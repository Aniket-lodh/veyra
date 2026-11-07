package auth

import (
	"fmt"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

const (
	bcryptCost       = 12
	minPasswordRunes = 12
	maxPasswordRunes = 128
)

func HashPassword(plain string) (string, error) {
	n := utf8.RuneCountInString(plain)
	if n < minPasswordRunes {
		return "", fmt.Errorf("%w: password must be at least %d characters", ErrWeakPassword, minPasswordRunes)
	}
	if n > maxPasswordRunes {
		return "", fmt.Errorf("%w: password too long", ErrWeakPassword)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(plain), bcryptCost)
	if err != nil {
		return "", fmt.Errorf("auth.HashPassword: %w", err)
	}
	return string(hash), nil
}

func CheckPassword(hash, plain string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}
