package auth

import (
	"strings"
	"testing"
)

func TestGenerateKey_FormatAndRoundTrip(t *testing.T) {
	t.Parallel()
	gen, err := GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	prefix, err := ParsePrefix(gen.Secret)
	if err != nil {
		t.Fatalf("ParsePrefix(%q): %v", gen.Secret, err)
	}
	if prefix != gen.Prefix {
		t.Fatalf("prefix mismatch: got %q want %q", prefix, gen.Prefix)
	}
	if !strings.HasPrefix(gen.Secret, gen.Prefix+"_") {
		t.Fatalf("secret %q does not start with prefix %q", gen.Secret, gen.Prefix)
	}
	if got := HashKey(gen.Secret); got != gen.Hash {
		t.Fatalf("hash mismatch: got %q want %q", got, gen.Hash)
	}
	if !EqualHash(gen.Hash, HashKey(gen.Secret)) {
		t.Fatal("EqualHash failed for identical digests")
	}
	if EqualHash(gen.Hash, HashKey(gen.Secret+"x")) {
		t.Fatal("EqualHash matched different secrets")
	}
}

func TestParsePrefix_RejectsMalformed(t *testing.T) {
	t.Parallel()
	cases := []string{
		"",
		"sk_live_abc",
		"veyra_short_secret",
		"veyra_toolong12_secret",
		"veyra_abcdefgh",
		"veyra_abcdefgh_",
	}
	for _, c := range cases {
		if _, err := ParsePrefix(c); err == nil {
			t.Fatalf("ParsePrefix(%q) expected error", c)
		}
	}
}

func TestValidateScopes(t *testing.T) {
	t.Parallel()
	got, err := ValidateScopes([]string{" jobs:read ", "jobs:write", "jobs:read"})
	if err != nil {
		t.Fatalf("ValidateScopes: %v", err)
	}
	if len(got) != 2 || got[0] != ScopeJobsRead || got[1] != ScopeJobsWrite {
		t.Fatalf("unexpected scopes: %#v", got)
	}
	if _, err := ValidateScopes([]string{"jobs:explode"}); err == nil {
		t.Fatal("expected invalid scope error")
	}
	if _, err := ValidateScopes(nil); err == nil {
		t.Fatal("expected empty scope error")
	}
}

func TestPrincipal_HasScope(t *testing.T) {
	t.Parallel()
	admin := Principal{Kind: "session", Role: RoleAdmin}
	if !admin.HasScope(ScopeJobsWrite) || !admin.HasAllScopes(ScopeJobsRead, ScopeDebug) {
		t.Fatal("session admin should grant every scope")
	}
	star := Principal{Kind: "api_key", Scopes: []string{ScopeAll}}
	if !star.HasScope(ScopeKeysAdmin) {
		t.Fatal("* should grant keys:admin")
	}
	limited := Principal{Kind: "api_key", Scopes: []string{ScopeJobsRead}}
	if limited.HasScope(ScopeJobsWrite) {
		t.Fatal("jobs:read must not grant jobs:write")
	}
}

func TestHashPassword_RoundTrip(t *testing.T) {
	t.Parallel()
	hash, err := HashPassword("correct-horse-battery")
	if err != nil {
		t.Fatal(err)
	}
	if !CheckPassword(hash, "correct-horse-battery") {
		t.Fatal("expected match")
	}
	if CheckPassword(hash, "wrong-password!!") {
		t.Fatal("expected mismatch")
	}
	if _, err := HashPassword("short"); err == nil {
		t.Fatal("expected weak password error")
	}
}

func TestNormalizeEmail(t *testing.T) {
	t.Parallel()
	got, err := NormalizeEmail("  Admin@Example.COM ")
	if err != nil {
		t.Fatal(err)
	}
	if got != "admin@example.com" {
		t.Fatalf("got %q", got)
	}
	if _, err := NormalizeEmail("not-an-email"); err == nil {
		t.Fatal("expected invalid email")
	}
}
