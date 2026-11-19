package jobs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"

	queuecore "github.com/Aniket-lodh/veyra/queue-core"
)

type mockJobRepo struct {
	createFunc func(ctx context.Context, p queuecore.CreateParams) (*queuecore.Job, error)
}

func (m *mockJobRepo) Create(ctx context.Context, p queuecore.CreateParams) (*queuecore.Job, error) {
	if m.createFunc != nil {
		return m.createFunc(ctx, p)
	}
	return nil, errors.New("not implemented")
}

func (m *mockJobRepo) Cancel(ctx context.Context, p queuecore.CancelParams) (*queuecore.Job, error) {
	return nil, errors.New("not implemented")
}

func (m *mockJobRepo) GetByID(ctx context.Context, id string) (*queuecore.Job, error) {
	return nil, errors.New("not implemented")
}

func (m *mockJobRepo) List(ctx context.Context, p queuecore.ListParams) ([]*queuecore.Job, error) {
	return nil, errors.New("not implemented")
}

func (m *mockJobRepo) Count(ctx context.Context, p queuecore.ListParams) (int, error) {
	return 0, errors.New("not implemented")
}

func (m *mockJobRepo) ListAttempts(ctx context.Context, jobID string) ([]*queuecore.Attempt, error) {
	return nil, errors.New("not implemented")
}

func TestCreate_IdempotencyHeaderAccepted(t *testing.T) {
	t.Parallel()

	var capturedKey *string
	repo := &mockJobRepo{
		createFunc: func(ctx context.Context, p queuecore.CreateParams) (*queuecore.Job, error) {
			capturedKey = p.IdempotencyKey
			return &queuecore.Job{
				ID:           "01M7SNV6RX8QKSF3KZFAB9GM01",
				Handler:      p.Handler,
				Queue:        p.Queue,
				Priority:     p.Priority,
				MaxAttempts:  p.MaxAttempts,
				Status:       queuecore.StatusQueued,
				ScheduledFor: time.Now().UTC(),
				EnqueuedAt:   time.Now().UTC(),
				Payload:      p.Payload,
			}, nil
		},
	}

	h := NewHandler(repo)
	app := fiber.New()
	app.Post("/jobs", h.Create)

	body := map[string]any{
		"handler": "send_email",
		"queue":   "mail",
		"payload": map[string]string{"to": "user@example.com"},
	}
	payloadBytes, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/jobs", bytes.NewReader(payloadBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "header-key-12345")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201 Created, got %d", resp.StatusCode)
	}

	if capturedKey == nil || *capturedKey != "header-key-12345" {
		t.Fatalf("expected IdempotencyKey 'header-key-12345', got %v", capturedKey)
	}
}

func TestCreate_IdempotencyHeaderBodyMismatch(t *testing.T) {
	t.Parallel()

	repo := &mockJobRepo{}
	h := NewHandler(repo)
	app := fiber.New()
	app.Post("/jobs", h.Create)

	body := map[string]any{
		"handler":        "send_email",
		"queue":          "mail",
		"payload":        map[string]string{"to": "user@example.com"},
		"idempotencyKey": "body-key-1",
	}
	payloadBytes, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/jobs", bytes.NewReader(payloadBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "header-key-2")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request on mismatch, got %d", resp.StatusCode)
	}

	bodyResp, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(bodyResp), "do not match") {
		t.Fatalf("expected mismatch message, got %s", string(bodyResp))
	}
}

func TestCreate_IdempotentReplayHeader(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name           string
		isReplay       bool
		wantReplayHead string
	}{
		{
			name:           "Fresh creation does not have Idempotent-Replay header",
			isReplay:       false,
			wantReplayHead: "",
		},
		{
			name:           "Replay has Idempotent-Replay: true header",
			isReplay:       true,
			wantReplayHead: "true",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			repo := &mockJobRepo{
				createFunc: func(ctx context.Context, p queuecore.CreateParams) (*queuecore.Job, error) {
					return &queuecore.Job{
						ID:           "01M7SNV6RX8QKSF3KZFAB9GM01",
						Handler:      p.Handler,
						Queue:        p.Queue,
						Priority:     p.Priority,
						MaxAttempts:  p.MaxAttempts,
						Status:       queuecore.StatusQueued,
						ScheduledFor: time.Now().UTC(),
						EnqueuedAt:   time.Now().UTC(),
						Payload:      p.Payload,
						IsReplay:     tc.isReplay,
					}, nil
				},
			}

			h := NewHandler(repo)
			app := fiber.New()
			app.Post("/jobs", h.Create)

			body := map[string]any{
				"handler":        "send_email",
				"queue":          "mail",
				"payload":        map[string]string{"to": "user@example.com"},
				"idempotencyKey": "key-test",
			}
			payloadBytes, _ := json.Marshal(body)

			req := httptest.NewRequest(http.MethodPost, "/jobs", bytes.NewReader(payloadBytes))
			req.Header.Set("Content-Type", "application/json")

			resp, err := app.Test(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()

			if resp.StatusCode != http.StatusCreated {
				t.Fatalf("expected 201 Created, got %d", resp.StatusCode)
			}

			gotHeader := resp.Header.Get("Idempotent-Replay")
			if gotHeader != tc.wantReplayHead {
				t.Fatalf("expected Idempotent-Replay=%q, got %q", tc.wantReplayHead, gotHeader)
			}
		})
	}
}

func TestCreate_IdempotencyConflictReturns409(t *testing.T) {
	t.Parallel()

	repo := &mockJobRepo{
		createFunc: func(ctx context.Context, p queuecore.CreateParams) (*queuecore.Job, error) {
			return nil, queuecore.ErrIdempotencyConflict
		},
	}

	h := NewHandler(repo)
	app := fiber.New()
	app.Post("/jobs", h.Create)

	body := map[string]any{
		"handler":        "send_email",
		"queue":          "mail",
		"payload":        map[string]string{"to": "different@example.com"},
		"idempotencyKey": "key-reused",
	}
	payloadBytes, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/jobs", bytes.NewReader(payloadBytes))
	req.Header.Set("Content-Type", "application/json")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 Conflict, got %d", resp.StatusCode)
	}

	bodyResp, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(bodyResp), "idempotency key conflict") {
		t.Fatalf("expected conflict error message, got %s", string(bodyResp))
	}
}

func TestCreate_InternalErrorSanitization(t *testing.T) {
	t.Parallel()

	repo := &mockJobRepo{
		createFunc: func(ctx context.Context, p queuecore.CreateParams) (*queuecore.Job, error) {
			return nil, errors.New("pgx: fatal connection timeout at db.internal.net:5432: table jobs corrupted")
		},
	}

	h := NewHandler(repo)
	app := fiber.New()
	app.Post("/jobs", h.Create)

	body := map[string]any{
		"handler": "send_email",
		"queue":   "mail",
		"payload": map[string]string{"to": "user@example.com"},
	}
	payloadBytes, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/jobs", bytes.NewReader(payloadBytes))
	req.Header.Set("Content-Type", "application/json")

	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", resp.StatusCode)
	}

	bodyResp, _ := io.ReadAll(resp.Body)
	bodyStr := string(bodyResp)
	if !strings.Contains(bodyStr, `"error":"internal server error"`) {
		t.Fatalf("expected generic 'internal server error', got %s", bodyStr)
	}
	if strings.Contains(bodyStr, "pgx") || strings.Contains(bodyStr, "db.internal.net") {
		t.Fatalf("database details leaked in 500 response: %s", bodyStr)
	}
}
