package config

import (
	"os"
	"testing"
)

func TestLoad_DebugEndpoints(t *testing.T) {
	// 1. Development default (empty or development) -> true
	os.Setenv("APP_ENV", "development")
	os.Unsetenv("ENABLE_DEBUG_ENDPOINTS")
	cfg := Load()
	if !cfg.EnableDebugEndpoints {
		t.Fatal("expected EnableDebugEndpoints=true by default in development")
	}

	// 2. Production default -> false
	os.Setenv("APP_ENV", "production")
	os.Unsetenv("ENABLE_DEBUG_ENDPOINTS")
	cfg = Load()
	if cfg.EnableDebugEndpoints {
		t.Fatal("expected EnableDebugEndpoints=false by default in production")
	}

	// 3. Production with explicit enable -> true
	os.Setenv("APP_ENV", "production")
	os.Setenv("ENABLE_DEBUG_ENDPOINTS", "true")
	cfg = Load()
	if !cfg.EnableDebugEndpoints {
		t.Fatal("expected EnableDebugEndpoints=true when explicitly set in production")
	}

	// 4. Development with explicit disable -> false
	os.Setenv("APP_ENV", "development")
	os.Setenv("ENABLE_DEBUG_ENDPOINTS", "false")
	cfg = Load()
	if cfg.EnableDebugEndpoints {
		t.Fatal("expected EnableDebugEndpoints=false when explicitly disabled in development")
	}
}
