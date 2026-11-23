package config

import (
	"testing"
)

func TestLoad_DebugEndpoints(t *testing.T) {
	// 1. Development default (empty or development) -> true
	t.Setenv("APP_ENV", "development")
	t.Setenv("ENABLE_DEBUG_ENDPOINTS", "")
	cfg := Load()
	if !cfg.EnableDebugEndpoints {
		t.Fatal("expected EnableDebugEndpoints=true by default in development")
	}

	// 2. Production default -> false
	t.Setenv("APP_ENV", "production")
	t.Setenv("ENABLE_DEBUG_ENDPOINTS", "")
	cfg = Load()
	if cfg.EnableDebugEndpoints {
		t.Fatal("expected EnableDebugEndpoints=false by default in production")
	}

	// 3. Production with explicit enable -> true
	t.Setenv("APP_ENV", "production")
	t.Setenv("ENABLE_DEBUG_ENDPOINTS", "true")
	cfg = Load()
	if !cfg.EnableDebugEndpoints {
		t.Fatal("expected EnableDebugEndpoints=true when explicitly set in production")
	}

	// 4. Development with explicit disable -> false
	t.Setenv("APP_ENV", "development")
	t.Setenv("ENABLE_DEBUG_ENDPOINTS", "false")
	cfg = Load()
	if cfg.EnableDebugEndpoints {
		t.Fatal("expected EnableDebugEndpoints=false when explicitly disabled in development")
	}
}

func TestLoad_DefaultPort8080(t *testing.T) {
	t.Setenv("PORT", "")
	cfg := Load()
	if cfg.Port != "8080" {
		t.Fatalf("expected default port 8080, got %q", cfg.Port)
	}
}

func TestValidatePort(t *testing.T) {
	valid := []struct {
		in   string
		want int
	}{
		{"8080", 8080},
		{" 8080 ", 8080},
		{"1", 1},
		{"65535", 65535},
	}
	for _, tc := range valid {
		got, err := ValidatePort(tc.in)
		if err != nil {
			t.Fatalf("ValidatePort(%q) unexpected error: %v", tc.in, err)
		}
		if got != tc.want {
			t.Fatalf("ValidatePort(%q) = %d, want %d", tc.in, got, tc.want)
		}
	}

	invalid := []string{
		"",
		"   ",
		"0",        // 0 rejected to enforce deterministic binding
		"-1",
		"-8080",
		"65536",
		"99999",
		"abc",
		"8080a",
		":8080",
	}
	for _, in := range invalid {
		if got, err := ValidatePort(in); err == nil {
			t.Fatalf("ValidatePort(%q) expected error, got %d", in, got)
		}
	}
}
