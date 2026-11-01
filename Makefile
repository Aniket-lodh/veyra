.DEFAULT_GOAL := help

GO_MODULES := packages/queue-core apps/api apps/worker
COMPOSE := docker compose -f deployments/compose/docker-compose.yml

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*##/ {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

.PHONY: up
up: ## Start Postgres, API, and one worker (builds images)
	scripts/dev/up.sh 1

.PHONY: down
down: ## Stop the dev stack (keeps the database volume)
	$(COMPOSE) down

.PHONY: fmt
fmt: ## Format Go code and frontend sources
	gofmt -w apps packages scripts
	cd apps/frontend/app && pnpm lint:fix

.PHONY: vet
vet: ## Run go vet in every Go module
	@for m in $(GO_MODULES); do echo "== $$m"; (cd $$m && go vet ./...) || exit 1; done

.PHONY: test
test: ## Run Go unit tests and frontend typecheck
	@for m in $(GO_MODULES); do echo "== $$m"; (cd $$m && go test ./...) || exit 1; done
	cd apps/frontend/app && pnpm typecheck

.PHONY: test-integration
test-integration: ## Run queue integration tests (needs Docker)
	cd packages/queue-core && go test -tags integration -count=1 ./...

.PHONY: lint
lint: ## Run gofmt check, golangci-lint, and frontend lint
	@test -z "$$(gofmt -l apps packages scripts)" || (gofmt -l apps packages scripts && exit 1)
	@for m in $(GO_MODULES); do echo "== $$m"; (cd $$m && golangci-lint run) || exit 1; done
	cd apps/frontend/app && pnpm lint:check

.PHONY: build
build: ## Build the frontend and both Docker images
	cd apps/frontend/app && pnpm build
	docker build -f deployments/docker/api.Dockerfile -t veyra-api:local .
	docker build -f deployments/docker/worker.Dockerfile -t veyra-worker:local .
