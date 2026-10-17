SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

COMPOSE := docker compose
MANUAL := bash scripts/manual-tests.sh

.PHONY: help check-deps install setup up down clean restart ps logs infra dev \
	check test test-unit test-integration test-concurrency \
	test-manual manual-rules manual-race manual-sqs manual-dlq manual-crash manual-observability \
	test-all verify

help: ## Lista os comandos disponíveis
	@echo "Uso: make <alvo>"
	@echo
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:[^#]*## /\t/' | \
		awk -F '\t' '{ printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 }'

# ------------------------------------------------------------------ setup

check-deps: ## Verifica bun, docker (rodando), docker compose, curl e jq
	@missing=0; for cmd in bun docker curl jq; do \
		command -v $$cmd >/dev/null 2>&1 || { echo "faltando: $$cmd"; missing=1; }; \
	done; [ $$missing -eq 0 ]
	@$(COMPOSE) version >/dev/null
	@docker info >/dev/null 2>&1 || { echo "o Docker nao esta rodando"; exit 1; }
	@echo "dependencias ok"

install: check-deps ## Instala as dependências do projeto (bun install)
	bun install --frozen-lockfile

setup: install up ## Instala tudo e sobe o projeto completo

# --------------------------------------------------------------- execução

up: ## Sobe Postgres, MiniStack, filas, migrations e as 3 instâncias (3001-3003)
	$(COMPOSE) up -d --build --wait
	@echo
	@echo "pronto: http://localhost:3001  http://localhost:3002  http://localhost:3003"

down: ## Para e remove os containers (mantém os dados)
	$(COMPOSE) down

clean: ## Para tudo e apaga os dados (volumes)
	$(COMPOSE) down -v

restart: down up ## Reinicia o stack

ps: ## Mostra o estado dos containers
	$(COMPOSE) ps -a

logs: ## Acompanha os logs das 3 instâncias
	$(COMPOSE) logs -f app-1 app-2 app-3

infra: ## Sobe só a infraestrutura (Postgres + MiniStack + filas)
	bun run infra:up

dev: infra ## Roda a aplicação local com hot reload na porta 3000
	bun run db:migrate:up
	bun run dev

# ------------------------------------------------- testes automatizados

check: ## Typecheck (strict) e lint
	bun run typecheck
	bun run lint

test-unit: ## Testes de unidade (domínio puro, sem infraestrutura)
	bun run test:unit

test-integration: infra ## Testes de integração contra PostgreSQL e MiniStack reais
	bun run test:integration

test-concurrency: infra ## Corridas reais e 3 processos com crash e reinício
	bun run test:concurrency

test: test-unit test-integration test-concurrency ## Todos os testes automatizados

# ------------------------------------- testes manuais (precisam de `make up`)

test-manual: ## Todos os cenários manuais contra o stack rodando
	$(MANUAL) all

manual-rules: ## Regras BET/WIN/LOSS/REFUND/ROLLBACK, idempotência e referência fora de ordem
	$(MANUAL) rules

manual-race: ## Corrida da seção 8 e 50 apostas idênticas em paralelo nas 3 instâncias
	$(MANUAL) race

manual-sqs: ## Consumo pelo SQS, redelivery, HTTP+SQS e publicação da outbox
	$(MANUAL) sqs

manual-dlq: ## Mensagem malformada indo para a DLQ
	$(MANUAL) dlq

manual-crash: ## Derruba e reinicia uma instância no meio do tráfego
	$(MANUAL) crash

manual-observability: ## Health checks, métricas e logs estruturados
	$(MANUAL) observability

# ------------------------------------------------------------------ tudo

test-all: check test test-manual ## Lint, todos os testes automatizados e todos os manuais

verify: setup test-all ## Do zero: instala, sobe o stack e roda absolutamente tudo
