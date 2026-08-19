.PHONY: help run build test lint tidy up down logs migrate-status

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-16s %s\n", $$1, $$2}'

run: ## Run the API locally (needs a reachable Postgres)
	go run ./cmd/api

build: ## Build a static linux binary into bin/
	CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o bin/api ./cmd/api

test: ## Run all tests
	go test ./... -race

lint: ## Vet + formatting check
	go vet ./...
	@test -z "$$(gofmt -l .)" || (echo "unformatted files:"; gofmt -l .; exit 1)

tidy: ## Tidy modules
	go mod tidy

up: ## Start the full stack (api + postgres) locally
	docker compose up --build -d

down: ## Stop the stack
	docker compose down

logs: ## Follow API logs
	docker compose logs -f api
