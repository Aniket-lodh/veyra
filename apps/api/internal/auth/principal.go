package auth

import "time"

type Principal struct {
	ID        string
	Kind      string // session | api_key
	Email     string
	Role      string
	Prefix    string
	Scopes    []string
	Source    string
	SessionID string
}

func (p Principal) HasScope(want string) bool {
	if p.Kind == "session" && p.Role == RoleAdmin {
		return true
	}
	for _, s := range p.Scopes {
		if s == ScopeAll || s == want {
			return true
		}
	}
	return false
}

func (p Principal) HasAllScopes(want ...string) bool {
	for _, w := range want {
		if !p.HasScope(w) {
			return false
		}
	}
	return true
}

func (p Principal) HasAnyScope(want ...string) bool {
	if p.Kind == "session" && p.Role == RoleAdmin {
		return true
	}
	for _, w := range want {
		if p.HasScope(w) {
			return true
		}
	}
	return false
}

type User struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	Role      string    `json:"role"`
	CreatedAt time.Time `json:"createdAt"`
}

const RoleAdmin = "admin"
