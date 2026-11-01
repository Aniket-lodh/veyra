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
	// httpRequestMaxTimeout bounds a single request so a job cannot pin a
	// worker indefinitely even if the payload asks for an absurd timeout.
	httpRequestMaxTimeout = 5 * time.Minute
	// responseExcerptMaxBytes caps the response body we read + store. Enough
	// to debug "what did the receiver say" without unbounded result rows.
	responseExcerptMaxBytes = 2048
	// errorBodySnippetMaxBytes caps the body snippet embedded in a failure
	// message — error.message lands in jobs.error + job_attempts; keep it tight.
	errorBodySnippetMaxBytes = 200
)

// httpRequestPayload is the job payload for the http_request handler. It
// describes one generic outbound HTTP request — webhook delivery is one use
// case, not the identity. Body is the literal request body; set Content-Type
// in Headers (e.g. application/json) and provide the matching string.
type httpRequestPayload struct {
	URL            string            `json:"url"`
	Method         string            `json:"method"`         // default POST
	Headers        map[string]string `json:"headers"`        // applied verbatim
	Body           string            `json:"body"`           // literal request body
	TimeoutSeconds *int              `json:"timeoutSeconds"` // per-request; default 30, capped at 300
}

// HTTPRequest performs one outbound HTTP request described by the job payload.
//
// It does NOT retry internally: a non-2xx response, a timeout, or a transport
// error is returned as a failure, and the queue's Nack path decides retry vs
// immediate DLQ from handler.Error.Permanent (SPEC §7). Permanence is decided
// per HTTP status code — not per 4xx/5xx bucket: 408 and 429 stay retryable;
// other 4xx and invalid_payload are permanent; 5xx/timeout/dns/connection
// stay retryable.
//
// The handler is idempotent only insofar as the receiver is: a delivered-but-
// unacked request (lease lost mid-flight) may be re-sent on reclaim. Receivers
// that must dedupe should key on something stable in the payload.
type HTTPRequest struct {
	client *http.Client
}

// NewHTTPRequest builds the handler with a shared client. There is no global
// client timeout — each request's deadline comes from a context derived from
// the job context, so per-job timeoutSeconds is honored independently while the
// lease-derived job context still bounds the whole thing.
func NewHTTPRequest() *HTTPRequest {
	return &HTTPRequest{client: &http.Client{}}
}

// Handle executes the request and maps the outcome to (result, error):
//   - 2xx                       → success, rich result JSON
//   - non-2xx                   → *handler.Error (class http_4xx/http_5xx/…)
//   - timeout / dns / refused   → *handler.Error (classified)
//   - job ctx cancelled         → ctx.Err() verbatim (runtime takes the
//     reclaim path; this is NOT recorded as a handler failure)
//   - bad payload               → *handler.Error (class invalid_payload)
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

	// Per-request deadline as a child of the job context, so the request is
	// bounded by min(timeout, remaining lease-derived ctx).
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

	// Delivery-identity headers. Veyra is at-least-once: a retry or a reclaim
	// re-run resends this request, and if the prior send reached the receiver
	// before its worker died, the receiver sees it twice. These headers give
	// the receiver a stable key to dedupe on. job.ID is the ULID assigned at
	// enqueue — it never changes across attempts; job.Attempt increments, so
	// the receiver can also tell that a given delivery is a redelivery.
	req.Header.Set("X-Veyra-Job-Id", job.ID)
	req.Header.Set("X-Veyra-Attempt", strconv.Itoa(job.Attempt))
	if req.Header.Get("Idempotency-Key") == "" {
		// Default the conventional dedupe header to the job id. A caller that
		// set its own Idempotency-Key in payload.headers wins (left untouched).
		req.Header.Set("Idempotency-Key", job.ID)
	}

	start := time.Now()
	resp, err := h.client.Do(req)
	elapsed := time.Since(start)
	if err != nil {
		// If the JOB context was cancelled (worker shutdown or lease loss),
		// this is not a handler failure — return ctx.Err() so the runtime
		// leaves the lease to expire and reclaim takes over. A reqCtx-only
		// deadline (our own timeout) leaves ctx.Err() == nil and falls through.
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

// retryable4xx is the SPEC §7.4 allow-list: 4xx codes that must stay
// retryable. Checked before defaulting other 4xx to permanent. Grow this
// set (e.g. 425) rather than hard-coding literals at call sites.
var retryable4xx = map[int]struct{}{
	http.StatusRequestTimeout:  {}, // 408
	http.StatusTooManyRequests: {}, // 429
}

// isPermanentHTTPStatus decides disposition from the concrete status code
// (SPEC §7.4). Observability class (http_4xx) is separate from permanence.
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
// Permanence is decided separately by isPermanentHTTPStatus — do not derive
// Permanent from this coarse bucket (408/429 would be wrongly killed).
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

// classifyTransportError maps a client.Do error (with the job context known to
// be alive) to a failure class: timeout, dns, connection_refused, or a generic
// connection error.
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

// bodySnippet renders a short, single-line excerpt for embedding in a failure
// message. Empty bodies render as "" (no trailing noise).
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
