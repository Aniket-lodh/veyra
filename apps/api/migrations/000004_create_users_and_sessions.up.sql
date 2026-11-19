-- 000004_create_users_and_sessions.up.sql

CREATE TABLE users (
    id              TEXT        PRIMARY KEY,
    email           TEXT        NOT NULL
                    CONSTRAINT users_email_nonempty CHECK (char_length(btrim(email)) > 0),
    password_hash   TEXT        NOT NULL
                    CONSTRAINT users_password_hash_nonempty CHECK (char_length(password_hash) > 0),
    role            TEXT        NOT NULL DEFAULT 'admin'
                    CONSTRAINT users_role_known CHECK (role IN ('admin')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_uidx ON users (email);

CREATE TABLE sessions (
    id              TEXT        PRIMARY KEY,
    user_id         TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      TEXT        NOT NULL
                    CONSTRAINT sessions_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sessions_expires_after_created CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX sessions_token_hash_uidx ON sessions (token_hash);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

ALTER TABLE api_keys
    ADD COLUMN created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
