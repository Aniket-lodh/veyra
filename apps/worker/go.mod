module github.com/Aniket-lodh/veyra/worker

go 1.25.4

// queue-core is a workspace module — replace makes `go build` work without
// go.work, the require pins a coordinate for go.mod resolution. Both are needed.
replace github.com/Aniket-lodh/veyra/queue-core => ../../packages/queue-core

require (
	github.com/Aniket-lodh/veyra/queue-core v0.0.0-00010101000000-000000000000
	github.com/jackc/pgx/v5 v5.9.2
	github.com/joho/godotenv v1.5.1
	github.com/oklog/ulid/v2 v2.1.1
)

require (
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/wneessen/go-mail v0.8.1 // indirect
	golang.org/x/crypto v0.54.0 // indirect
	golang.org/x/sync v0.22.0 // indirect
	golang.org/x/text v0.40.0 // indirect
)
