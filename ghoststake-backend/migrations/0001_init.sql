-- +goose Up
CREATE TABLE users (
    id           BIGSERIAL PRIMARY KEY,
    address      TEXT        NOT NULL UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
);

-- One row per issued login challenge. The server stores the exact message it
-- rendered so verification never has to trust or re-parse client input.
CREATE TABLE auth_nonces (
    nonce       TEXT        PRIMARY KEY,
    address     TEXT        NOT NULL,
    message     TEXT        NOT NULL,
    issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);

-- Supports the expiry sweep.
CREATE INDEX auth_nonces_expires_at_idx ON auth_nonces (expires_at);

-- +goose Down
DROP TABLE auth_nonces;
DROP TABLE users;
