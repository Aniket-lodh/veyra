module github.com/Aniket-lodh/veyra/api

go 1.26.0

// queue-core is a workspace module — the replace makes `go build` work without
// go.work (CI, IDE indexers), and the require gives go.mod a fixed pseudo-
// version so it can pin a coordinate. Both are needed.
replace github.com/Aniket-lodh/veyra/queue-core => ../../packages/queue-core

require (
	github.com/Aniket-lodh/veyra/queue-core v0.0.0-00010101000000-000000000000
	github.com/gofiber/contrib/v3/swaggerui v1.0.17
	github.com/gofiber/fiber/v3 v3.6.1
	github.com/golang-migrate/migrate/v4 v4.20.1
	github.com/jackc/pgx/v5 v5.12.0
	github.com/joho/godotenv v1.5.1
	github.com/oklog/ulid/v2 v2.1.2
)

require (
	github.com/go-openapi/runtime/server-middleware v0.33.4 // indirect
	github.com/gofiber/schema v1.9.3 // indirect
	github.com/gofiber/utils/v2 v2.6.4 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.3 // indirect
	github.com/klauspost/compress v1.20.3 // indirect
	github.com/kr/text v0.2.0 // indirect
	github.com/lib/pq v1.10.9 // indirect
	github.com/mattn/go-colorable v0.1.16 // indirect
	github.com/mattn/go-isatty v0.0.24 // indirect
	github.com/molecule-man/go-brrr v1.3.1 // indirect
	github.com/philhofer/fwd v1.2.1 // indirect
	github.com/tinylib/msgp v1.6.5 // indirect
	github.com/valyala/bytebufferpool v1.0.0 // indirect
	github.com/valyala/fasthttp v1.77.0 // indirect
	golang.org/x/crypto v0.58.0 // indirect
	golang.org/x/net v0.62.0 // indirect
	golang.org/x/sync v0.24.0 // indirect
	golang.org/x/sys v0.49.0 // indirect
	golang.org/x/text v0.43.0 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
)
