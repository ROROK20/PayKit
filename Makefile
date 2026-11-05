# PayKit — convenience targets
# Run `make` or `make help` to list available targets.

.DEFAULT_GOAL := help
.PHONY: help install test test-coverage lint typecheck build frontend frontend-build frontend-install demo demo-local clean

help: ## List available targets
	@echo "PayKit — available make targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: ## Install the SDK's dependencies via npm ci
	npm ci

test: ## Run the SDK test suite
	npm test

test-coverage: ## Run the SDK tests with coverage
	npm run test:coverage

lint: ## Lint the SDK source (eslint)
	npm run lint

typecheck: ## Type-check the SDK (tsc --noEmit)
	npm run typecheck

build: ## Build the SDK to dist/ (cjs + esm + .d.ts)
	npm run build

frontend-install: ## Install the SDK, then the frontend (its file:.. link builds the SDK)
	npm install
	cd frontend && npm install

frontend: frontend-install ## Run the Next.js demo playground (http://localhost:3005)
	cd frontend && npm run dev

frontend-build: frontend-install ## Production-build the frontend
	cd frontend && npm run build

demo: ## One-command playground demo via Docker (http://localhost:3005)
	docker compose up --build

demo-local: ## One-command demo without Docker (builds SDK, runs Next.js dev)
	npm install && npm run build && cd frontend && npm install && npm run dev

clean: ## Remove build artifacts and coverage
	rm -rf dist coverage frontend/.next
