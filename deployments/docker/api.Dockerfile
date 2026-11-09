# syntax=docker/dockerfile:1.7
# Veyra api — multi-stage build. Context must be the repo root.

ARG GO_VERSION=1.25
ARG ALPINE_VERSION=3.20

FROM golang:${GO_VERSION}-alpine AS builder
WORKDIR /src

RUN apk add --no-cache git ca-certificates

COPY apps/api/go.mod apps/api/go.sum apps/api/
COPY packages/queue-core/go.mod packages/queue-core/go.sum packages/queue-core/
RUN cd apps/api && go mod download

COPY packages/queue-core/ packages/queue-core/
COPY apps/api/ apps/api/

ARG VERSION=dev
ARG TARGETARCH
ENV CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH}
RUN cd apps/api && \
    go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" \
        -o /out/api ./cmd/api

FROM alpine:${ALPINE_VERSION} AS runtime

# wget is used by the compose healthcheck; ca-certificates for outbound TLS; tzdata so timestamps render with.
RUN apk add --no-cache ca-certificates tzdata wget tini && \
    addgroup -S veyra && \
    adduser -S -G veyra -h /app veyra

WORKDIR /app

COPY --from=builder /out/api /app/api
COPY --from=builder /src/apps/api/migrations /app/migrations
COPY --from=builder /src/apps/api/docs /app/docs

USER veyra

# Conservative defaults. Real values come from compose env / .env files.
ENV APP_ENV=production \
    PORT=8008 \
    LOG_LEVEL=info

EXPOSE 8008

# tini as PID 1 — see comment on apk add tini.
ENTRYPOINT ["/sbin/tini", "--", "/app/api"]
