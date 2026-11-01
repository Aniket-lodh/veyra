# Unstable receiver — workload test fixture for the http_request handler.
# NOT a Veyra product service. Build context is this directory (the program is
# stdlib-only and has no dependency on packages/queue-core, unlike api/worker
# which build from the repo root). Brought up via the opt-in compose overlay
# deployments/compose/docker-compose.receiver.yml — never in prod.
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY main.go ./
RUN CGO_ENABLED=0 go build -trimpath -o /unstable-receiver .

FROM alpine:3.20
# tini as PID 1 so SIGTERM from `docker compose stop` reaches the Go process
# and the server shuts down gracefully (matches api/worker convention).
RUN apk add --no-cache tini
COPY --from=build /unstable-receiver /usr/local/bin/unstable-receiver
EXPOSE 8090
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/unstable-receiver"]
