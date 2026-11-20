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
