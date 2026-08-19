# syntax=docker/dockerfile:1

ARG GO_VERSION=1.25

# ---- builder ----------------------------------------------------------------
FROM golang:${GO_VERSION}-alpine AS builder
WORKDIR /src

# Dependencies are downloaded in their own layer, so editing application code
# does not invalidate the module cache.
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY . .

# CGO_ENABLED=0 produces a fully static binary. go-ethereum normally reaches
# for a C secp256k1, but without cgo it falls back to the pure-Go
# decred/secp256k1 implementation — verified, and what makes the tiny runtime
# image below possible.
#
# -trimpath strips local filesystem paths; -s -w drop the symbol table and DWARF.
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux \
    go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

# ---- runtime ----------------------------------------------------------------
# distroless static: no shell, no package manager, no libc — just CA
# certificates (needed for HTTPS to the Arbitrum RPC) and a nonroot user.
# Nothing to exec into means a compromised process has almost nothing to use.
FROM gcr.io/distroless/static-debian12:nonroot AS runtime

COPY --from=builder /out/api /app/api

USER nonroot:nonroot
EXPOSE 8080

ENV HTTP_PORT=8080

ENTRYPOINT ["/app/api"]
