.PHONY: help run build test test-integration test-remote gen-abis lint check-go-version tidy up down logs migrate-status

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-16s %s\n", $$1, $$2}'

run: ## Run the API locally (needs a reachable Postgres)
	go run ./cmd/api

build: ## Build a static linux binary into bin/
	CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o bin/api ./cmd/api

test: ## Run unit tests (no database needed)
	go test ./... -race

test-integration: ## Run every test including the ones needing TEST_DATABASE_URL
	go test ./... -race -count=1

test-remote: ## Bring a Postgres up on the VPS via rdk, tunnel it, run the full suite
	rdk test -f docker-compose.test.yml -t 5434 -- \
		env TEST_DATABASE_URL="postgres://ghoststake:ghoststake@127.0.0.1:5434/ghoststake_test?sslmode=disable" \
		$(MAKE) test-integration

gen-abis: ## Re-extract contract event ABIs (after `forge build` in ghoststake-contracts)
	go run ./cmd/genabi

lint: check-go-version ## Vet + formatting check
	go vet ./...
	@test -z "$$(gofmt -l .)" || (echo "unformatted files:"; gofmt -l .; exit 1)

check-go-version: ## Assert the Dockerfile's Go matches go.mod's
	@mod=$$(awk '/^go /{print $$2}' go.mod | cut -d. -f1,2); \
	img=$$(awk -F= '/^ARG GO_VERSION=/{print $$2}' Dockerfile); \
	if [ "$$mod" != "$$img" ]; then \
		echo "go.mod requires Go $$mod but the Dockerfile builds on $$img."; \
		echo "The image build would silently download a toolchain instead of"; \
		echo "using its pinned base. Update ARG GO_VERSION in the Dockerfile."; \
		exit 1; \
	fi

tidy: ## Tidy modules
	go mod tidy

up: ## Start the full stack (api + postgres) locally
	docker compose up --build -d

down: ## Stop the stack
	docker compose down

logs: ## Follow API logs
	docker compose logs -f api
