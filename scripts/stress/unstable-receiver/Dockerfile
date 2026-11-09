# Unstable receiver fixture for http_request handler tests. Not a Veyra service.

FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY main.go ./
RUN CGO_ENABLED=0 go build -trimpath -o /unstable-receiver .

FROM alpine:3.20
# tini as PID 1 so SIGTERM from `docker compose stop` reaches the Go process and the server shuts down gracefully (matches api/worker convention).
RUN apk add --no-cache tini
COPY --from=build /unstable-receiver /usr/local/bin/unstable-receiver
EXPOSE 8090
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/unstable-receiver"]
