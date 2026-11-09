package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"syscall"
	"time"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"
)

const (
	httpRequestDefaultMethod  = http.MethodPost
	httpRequestDefaultTimeout = 30 * time.Second
	// httpRequestMaxTimeout bounds a single request so a job cannot pin a worker indefinitely even if the payload asks for an absurd timeout.
	httpRequestMaxTimeout = 5 * time.Minute
	// responseExcerptMaxBytes caps the response body we read + store.
	responseExcerptMaxBytes = 2048
	// errorBodySnippetMaxBytes caps the body snippet embedded in a failure message — error.message lands in jobs.error + job_attempts; keep it tight.
	errorBodySnippetMaxBytes = 200
)

// httpRequestPayload is the job payload for the http_request handler.
type httpRequestPayload struct {
	URL            string            `json:"url"`
	Method         string            `json:"method"`         // default POST
	Headers        map[string]string `json:"headers"`        // applied verbatim
	Body           string            `json:"body"`           // literal request body
	TimeoutSeconds *int              `json:"timeoutSeconds"` // per-request; default 30, capped at 300
}

// HTTPRequest performs one outbound HTTP request described by the job payload.
type HTTPRequest struct {
	client *http.Client
}

// NewHTTPRequest builds the handler with a shared client.
func NewHTTPRequest() *HTTPRequest {
	return &HTTPRequest{client: &http.Client{}}
}

// Handle executes the request and maps the outcome to (result, error): - 2xx → success, rich result JSON
func (h *HTTPRequest) Handle(ctx context.Context, job *queuecore.Job) (json.RawMessage, error) {
	var p httpRequestPayload
	if err := json.Unmarshal(job.Payload, &p); err != nil {
		return nil, permanentError("invalid_payload", fmt.Sprintf("cannot decode http_request payload: %v", err))
	}
	if strings.TrimSpace(p.URL) == "" {
		return nil, permanentError("invalid_payload", "http_request payload missing required field: url")
	}

	method := strings.ToUpper(strings.TrimSpace(p.Method))
	if method == "" {
		method = httpRequestDefaultMethod
	}

	timeout := httpRequestDefaultTimeout
	if p.TimeoutSeconds != nil {
		if *p.TimeoutSeconds <= 0 {
			return nil, permanentError("invalid_payload", "http_request timeoutSeconds must be > 0")
		}
		timeout = min(time.Duration(*p.TimeoutSeconds)*time.Second, httpRequestMaxTimeout)
	}

	// Per-request deadline as a child of the job context, so the request is bounded by min(timeout, remaining lease-derived ctx).
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var body io.Reader
	if p.Body != "" {
		body = strings.NewReader(p.Body)
	}
	req, err := http.NewRequestWithContext(reqCtx, method, p.URL, body)
	if err != nil {
		return nil, permanentError("invalid_payload", fmt.Sprintf("cannot build %s request to %q: %v", method, p.URL, err))
	}
	for k, v := range p.Headers {
		req.Header.Set(k, v)
	}
	if req.Header.Get("User-Agent") == "" {
		req.Header.Set("User-Agent", "veyra-worker/http_request")
	}

	// Delivery-identity headers.
	req.Header.Set("X-Veyra-Job-Id", job.ID)
	req.Header.Set("X-Veyra-Attempt", strconv.Itoa(job.Attempt))
	if req.Header.Get("Idempotency-Key") == "" {
		// Default the conventional dedupe header to the job id.
		req.Header.Set("Idempotency-Key", job.ID)
	}

	start := time.Now()
	resp, err := h.client.Do(req)
	elapsed := time.Since(start)
	if err != nil {
		// If the JOB context was cancelled (worker shutdown or lease loss), this is not a handler failure — return ctx.Err() so the runtime leaves…
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, classifyTransportError(err, method, p.URL, elapsed)
	}
	defer func() { _ = resp.Body.Close() }()

	excerpt, _ := io.ReadAll(io.LimitReader(resp.Body, responseExcerptMaxBytes))
	contentType := resp.Header.Get("Content-Type")

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		result, _ := json.Marshal(map[string]any{
			"statusCode":      resp.StatusCode,
			"durationMs":      elapsed.Milliseconds(),
			"contentType":     contentType,
			"responseExcerpt": string(excerpt),
		})
		return result, nil
	}

	return nil, &Error{
		Class: httpStatusClass(resp.StatusCode),
		Message: fmt.Sprintf("%s %s → HTTP %d (%s) after %dms%s",
			method, p.URL, resp.StatusCode, http.StatusText(resp.StatusCode),
			elapsed.Milliseconds(), bodySnippet(excerpt)),
		Permanent: isPermanentHTTPStatus(resp.StatusCode),
	}
}

// retryable4xx is the SPEC §7.4 allow-list: 4xx codes that must stay retryable.
var retryable4xx = map[int]struct{}{
	http.StatusRequestTimeout:  {}, // 408
	http.StatusTooManyRequests: {}, // 429
}

// isPermanentHTTPStatus decides disposition from the concrete status code (SPEC §7.4).
func isPermanentHTTPStatus(code int) bool {
	if code < 400 || code >= 500 {
		return false // 3xx / 5xx / other → retry
	}
	if _, ok := retryable4xx[code]; ok {
		return false
	}
	return true // other 4xx → permanent
}

func permanentError(class, message string) *Error {
	return &Error{Class: class, Message: message, Permanent: true}
}

// httpStatusClass maps a non-2xx status to a failure class for grouping.
func httpStatusClass(code int) string {
	switch {
	case code >= 500:
		return "http_5xx"
	case code >= 400:
		return "http_4xx"
	case code >= 300:
		return "http_3xx" // a redirect the client did not/could not follow
	default:
		return "http_other"
	}
}

// classifyTransportError maps a client.Do error (with the job context known to be alive) to a failure class: timeout, dns,…
func classifyTransportError(err error, method, url string, elapsed time.Duration) *Error {
	// Our per-request deadline (reqCtx) firing surfaces as DeadlineExceeded.
	if errors.Is(err, context.DeadlineExceeded) {
		return &Error{Class: "timeout", Message: fmt.Sprintf("%s %s timed out after %dms", method, url, elapsed.Milliseconds())}
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return &Error{Class: "dns", Message: fmt.Sprintf("%s %s DNS lookup failed: %s", method, url, dnsErr.Err)}
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return &Error{Class: "connection_refused", Message: fmt.Sprintf("%s %s connection refused after %dms", method, url, elapsed.Milliseconds())}
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return &Error{Class: "timeout", Message: fmt.Sprintf("%s %s network timeout after %dms", method, url, elapsed.Milliseconds())}
	}
	return &Error{Class: "connection", Message: fmt.Sprintf("%s %s failed after %dms: %v", method, url, elapsed.Milliseconds(), err)}
}

// bodySnippet renders a short, single-line excerpt for embedding in a failure message.
func bodySnippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	if s == "" {
		return ""
	}
	s = strings.Join(strings.Fields(s), " ") // collapse whitespace/newlines
	if len(s) > errorBodySnippetMaxBytes {
		s = s[:errorBodySnippetMaxBytes] + "…"
	}
	return "; body: " + s
}
