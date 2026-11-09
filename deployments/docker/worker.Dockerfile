# syntax=docker/dockerfile:1.7
# Veyra worker — multi-stage build. Context must be the repo root.

ARG GO_VERSION=1.25
ARG ALPINE_VERSION=3.20

FROM golang:${GO_VERSION}-alpine AS builder
WORKDIR /src

RUN apk add --no-cache git ca-certificates

COPY apps/worker/go.mod apps/worker/go.sum apps/worker/
COPY packages/queue-core/go.mod packages/queue-core/go.sum packages/queue-core/
RUN cd apps/worker && go mod download

COPY packages/queue-core/ packages/queue-core/
COPY apps/worker/ apps/worker/

ARG VERSION=dev
ARG TARGETARCH
ENV CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH}
RUN cd apps/worker && \
    go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" \
        -o /out/worker ./cmd/worker

FROM alpine:${ALPINE_VERSION} AS runtime

RUN apk add --no-cache ca-certificates tzdata tini && \
    addgroup -S veyra && \
    adduser -S -G veyra -h /app veyra

WORKDIR /app
COPY --from=builder /out/worker /app/worker

USER veyra

ENV APP_ENV=production \
    LOG_LEVEL=info \
    VEYRA_WORKER_QUEUES=default

# tini as PID 1 forwards SIGTERM to the Go process so signal.NotifyContext fires and graceful shutdown runs.
ENTRYPOINT ["/sbin/tini", "--", "/app/worker"]
