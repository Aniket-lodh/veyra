package main

import (
	"context"
	"fmt"
	"log"
	"math/rand/v2"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type config struct {
	port     string
	rate2xx  int
	rate4xx  int
	rate5xx  int
	delayMs  int
	hangRate float64
	hangMs   int
}

func main() {
	cfg := loadConfig()
	log.Printf("unstable-receiver.start port=%s rates=2xx:%d/4xx:%d/5xx:%d delayMs=%d hangRate=%.2f hangMs=%d",
		cfg.port, cfg.rate2xx, cfg.rate4xx, cfg.rate5xx, cfg.delayMs, cfg.hangRate, cfg.hangMs)

	mux := http.NewServeMux()
	mux.HandleFunc("/", cfg.handle)

	srv := &http.Server{Addr: ":" + cfg.port, Handler: mux}

	// Graceful shutdown on SIGTERM/SIGINT (compose stop, Ctrl-C).
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		log.Print("unstable-receiver.stopping")
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	}()

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("unstable-receiver.listen_failed: %v", err)
	}
	log.Print("unstable-receiver.stopped")
}

func (c *config) handle(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	// 1. Hang (timeout simulation) takes precedence — forced, or rolled.
	hang := q.Get("hang") == "1" || (c.hangRate > 0 && rand.Float64() < c.hangRate)
	if hang {
		log.Printf("recv method=%s path=%s remote=%s → HANG hangMs=%d", r.Method, r.URL.Path, r.RemoteAddr, c.hangMs)
		select {
		case <-time.After(time.Duration(c.hangMs) * time.Millisecond):
			// Client almost certainly timed out already; respond late so the connection isn't held forever if the client is patient.
			writeStatus(w, http.StatusGatewayTimeout, "hang")
		case <-r.Context().Done():
			// Client gave up (timeout / cancellation) — nothing to write.
			log.Printf("recv path=%s → client gave up during hang", r.URL.Path)
		}
		return
	}

	// 2. Delay before responding.
	delayMs := c.delayMs
	if v := q.Get("delayMs"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			delayMs = n
		}
	}
	if delayMs > 0 {
		select {
		case <-time.After(time.Duration(delayMs) * time.Millisecond):
		case <-r.Context().Done():
			log.Printf("recv path=%s → client gave up during delay (%dms)", r.URL.Path, delayMs)
			return
		}
	}

	// 3. Choose a status: exact override, then bucket override, then weighted.
	code, bucket := c.chooseStatus(q)
	// Surface Veyra's delivery-identity headers so redelivery stability is visible in the log: the same jobId across attempts (with attempt…
	log.Printf("recv method=%s path=%s remote=%s → status=%d bucket=%s delayMs=%d jobId=%s attempt=%s idemKey=%s",
		r.Method, r.URL.Path, r.RemoteAddr, code, bucket, delayMs,
		dash(r.Header.Get("X-Veyra-Job-Id")), dash(r.Header.Get("X-Veyra-Attempt")), dash(r.Header.Get("Idempotency-Key")))
	writeStatus(w, code, bucket)
}

// chooseStatus resolves the response code and a human bucket label.
func (c *config) chooseStatus(q map[string][]string) (int, string) {
	get := func(k string) string {
		if v, ok := q[k]; ok && len(v) > 0 {
			return v[0]
		}
		return ""
	}
	if s := get("status"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n >= 100 && n <= 599 {
			return n, bucketLabel(n)
		}
	}
	switch strings.ToLower(get("bucket")) {
	case "2xx":
		return http.StatusOK, "2xx"
	case "4xx":
		return http.StatusBadRequest, "4xx"
	case "5xx":
		return http.StatusServiceUnavailable, "5xx"
	}

	total := c.rate2xx + c.rate4xx + c.rate5xx
	if total <= 0 {
		return http.StatusOK, "2xx"
	}
	roll := rand.IntN(total)
	switch {
	case roll < c.rate2xx:
		return http.StatusOK, "2xx"
	case roll < c.rate2xx+c.rate4xx:
		return http.StatusBadRequest, "4xx"
	default:
		return http.StatusServiceUnavailable, "5xx"
	}
}

// dash renders an empty header value as "-" to keep log lines aligned.
func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func bucketLabel(code int) string {
	switch {
	case code >= 500:
		return "5xx"
	case code >= 400:
		return "4xx"
	case code >= 300:
		return "3xx"
	default:
		return "2xx"
	}
}

func writeStatus(w http.ResponseWriter, code int, bucket string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	fmt.Fprintf(w, `{"receiver":"unstable","status":%d,"bucket":%q}`+"\n", code, bucket)
}

func loadConfig() config {
	return config{
		port:     envStr("RECEIVER_PORT", "8090"),
		rate2xx:  envInt("RECEIVER_RATE_2XX", 70),
		rate4xx:  envInt("RECEIVER_RATE_4XX", 10),
		rate5xx:  envInt("RECEIVER_RATE_5XX", 20),
		delayMs:  envInt("RECEIVER_DELAY_MS", 0),
		hangRate: envFloat("RECEIVER_HANG_RATE", 0),
		hangMs:   envInt("RECEIVER_HANG_MS", 60000),
	}
}

func envStr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return n
		}
		log.Printf("unstable-receiver.config.invalid key=%s value=%q fallback=%d", key, os.Getenv(key), def)
	}
	return def
}

func envFloat(key string, def float64) float64 {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f >= 0 && f <= 1 {
			return f
		}
		log.Printf("unstable-receiver.config.invalid key=%s value=%q fallback=%.2f", key, os.Getenv(key), def)
	}
	return def
}
