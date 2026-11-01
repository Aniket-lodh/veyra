# syntax=docker/dockerfile:1.7
#
# Veyra api — multi-stage build.
#
# Build context MUST be the repo root (deployments/compose/docker-compose.yml
# sets `context: ../..`), because apps/api/go.mod has
#   replace github.com/Aniket-lodh/veyra/queue-core => ../../packages/queue-core
# so the build needs both apps/api/ and packages/queue-core/ in scope.
#
# Stages:
#   builder — golang:1.25-alpine with the source. Produces a static binary.
#   runtime — alpine:3.20 with ca-certs, tzdata, wget (for healthcheck),
#             and a non-root user. Only the binary + migrations are copied in.
# -----------------------------------------------------------------------------

ARG GO_VERSION=1.25
ARG ALPINE_VERSION=3.20

FROM golang:${GO_VERSION}-alpine AS builder
WORKDIR /src

RUN apk add --no-cache git ca-certificates

# Stage 1: cache module download. Copy ONLY go.mod + go.sum first so this
# layer is invalidated only by dependency changes, not by source edits.
COPY apps/api/go.mod apps/api/go.sum apps/api/
COPY packages/queue-core/go.mod packages/queue-core/go.sum packages/queue-core/
RUN cd apps/api && go mod download

# Stage 2: real source. queue-core copied BEFORE apps/api/ for the same
# caching reason — queue-core changes less often.
COPY packages/queue-core/ packages/queue-core/
COPY apps/api/ apps/api/

# Static, stripped, reproducible-ish. CGO off → no glibc / musl runtime
# dependency, so the binary works on any base image (alpine or distroless).
# GOARCH is intentionally NOT pinned: it defaults to the build platform's
# arch, so the same Dockerfile produces an amd64 binary on amd64 hosts and
# an arm64 binary on arm64 hosts (e.g. AWS Graviton, Ampere VPS, M-series
# Macs). Cross-compile by overriding `--build-arg TARGETARCH=arm64`.
ARG VERSION=dev
ARG TARGETARCH
ENV CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH}
RUN cd apps/api && \
    go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" \
        -o /out/api ./cmd/api

# -----------------------------------------------------------------------------
FROM alpine:${ALPINE_VERSION} AS runtime

# wget is used by the compose healthcheck; ca-certificates for outbound TLS;
# tzdata so timestamps render with the right zone; tini as PID 1 so SIGTERM
# from `docker stop` propagates correctly to the Go process (Go's signal
# handling expects to BE PID 1's signal target, and tini bridges that.)
RUN apk add --no-cache ca-certificates tzdata wget tini && \
    addgroup -S veyra && \
    adduser -S -G veyra -h /app veyra

WORKDIR /app

COPY --from=builder /out/api /app/api
# Migrations are read at startup from file://migrations relative to cwd.
# Keep this in lockstep with apps/api/internal/database/migrations.go.
COPY --from=builder /src/apps/api/migrations /app/migrations
# docs/ holds swagger.json. The api only mounts swagger when APP_ENV is dev
# (see cmd/api/main.go), but we still ship the file so flipping APP_ENV at
# runtime for a debug session works without rebuilding the image.
COPY --from=builder /src/apps/api/docs /app/docs

USER veyra

# Conservative defaults. Real values come from compose env / .env files.
ENV APP_ENV=production \
    PORT=8008 \
    LOG_LEVEL=info

EXPOSE 8008

# tini as PID 1 — see comment on apk add tini.
ENTRYPOINT ["/sbin/tini", "--", "/app/api"]
