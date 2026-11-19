package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	ScopeJobsRead  = "jobs:read"
	ScopeJobsWrite = "jobs:write"
	ScopeQueueRead = "queue:read"
	ScopeKeysAdmin = "keys:admin"
	ScopeDebug     = "debug"
	ScopeAll       = "*"
)

var AllKnownScopes = []string{
	ScopeJobsRead,
	ScopeJobsWrite,
	ScopeQueueRead,
	ScopeKeysAdmin,
	ScopeDebug,
	ScopeAll,
}

var (
	ErrMalformedKey       = errors.New("auth: malformed api key")
	ErrInvalidScope       = errors.New("auth: invalid scope")
	ErrUnauthenticated    = errors.New("auth: unauthenticated")
	ErrForbidden          = errors.New("auth: forbidden")
	ErrWeakPassword       = errors.New("auth: weak password")
	ErrInvalidEmail       = errors.New("auth: invalid email")
	ErrEmailTaken         = errors.New("auth: email already registered")
	ErrInvalidCredentials = errors.New("auth: invalid credentials")
	ErrUserNotFound       = errors.New("auth: user not found")
	ErrKeyNotFound        = errors.New("auth: api key not found")
)

type KeyRecord struct {
	ID        string
	Name      string
	Prefix    string
	Scopes    []string
	Source    string
	ExpiresAt *time.Time
}

// GeneratedKey is returned once at creation; Secret is never stored.
type GeneratedKey struct {
	ID     string
	Prefix string
	Secret string
	Hash   string
}

// GenerateKey mints veyra_<8hex>_<64hex>.
func GenerateKey() (GeneratedKey, error) {
	var prefixBytes [5]byte
	if _, err := rand.Read(prefixBytes[:]); err != nil {
		return GeneratedKey{}, fmt.Errorf("auth.GenerateKey: prefix: %w", err)
	}
	prefixBody := strings.ToLower(hex.EncodeToString(prefixBytes[:]))[:8]

	var secretBytes [32]byte
	if _, err := rand.Read(secretBytes[:]); err != nil {
		return GeneratedKey{}, fmt.Errorf("auth.GenerateKey: secret: %w", err)
	}
	secretBody := hex.EncodeToString(secretBytes[:])

	prefix := "veyra_" + prefixBody
	plaintext := prefix + "_" + secretBody
	return GeneratedKey{
		Prefix: prefix,
		Secret: plaintext,
		Hash:   HashKey(plaintext),
	}, nil
}

func HashKey(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}

func EqualHash(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func ParsePrefix(plaintext string) (string, error) {
	plaintext = strings.TrimSpace(plaintext)
	if !strings.HasPrefix(plaintext, "veyra_") {
		return "", ErrMalformedKey
	}
	rest := plaintext[len("veyra_"):]
	i := strings.IndexByte(rest, '_')
	if i != 8 {
		return "", ErrMalformedKey
	}
	if len(rest) <= i+1 {
		return "", ErrMalformedKey
	}
	return "veyra_" + rest[:8], nil
}

func ValidateScopes(scopes []string) ([]string, error) {
	if len(scopes) == 0 {
		return nil, fmt.Errorf("%w: empty", ErrInvalidScope)
	}
	known := make(map[string]struct{}, len(AllKnownScopes))
	for _, s := range AllKnownScopes {
		known[s] = struct{}{}
	}
	out := make([]string, 0, len(scopes))
	seen := make(map[string]struct{}, len(scopes))
	for _, raw := range scopes {
		s := strings.TrimSpace(raw)
		if s == "" {
			continue
		}
		if _, ok := known[s]; !ok {
			return nil, fmt.Errorf("%w: %q", ErrInvalidScope, s)
		}
		if _, dup := seen[s]; dup {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%w: empty", ErrInvalidScope)
	}
	return out, nil
}
