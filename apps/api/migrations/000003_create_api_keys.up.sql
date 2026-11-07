-- 000003_create_api_keys.up.sql

CREATE TABLE api_keys (
    id              TEXT        PRIMARY KEY,
    name            TEXT        NOT NULL
                    CONSTRAINT api_keys_name_nonempty CHECK (char_length(btrim(name)) > 0),
    key_prefix      TEXT        NOT NULL
                    CONSTRAINT api_keys_prefix_format CHECK (key_prefix ~ '^veyra_[0-9a-z]{8}$'),
    key_hash        TEXT        NOT NULL
                    CONSTRAINT api_keys_hash_format CHECK (key_hash ~ '^[0-9a-f]{64}$'),
    scopes          TEXT[]      NOT NULL
                    CONSTRAINT api_keys_scopes_nonempty CHECK (cardinality(scopes) > 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    CONSTRAINT api_keys_expires_after_created
        CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE UNIQUE INDEX api_keys_key_prefix_uidx ON api_keys (key_prefix);
CREATE INDEX api_keys_active_idx ON api_keys (created_at DESC)
    WHERE revoked_at IS NULL;
