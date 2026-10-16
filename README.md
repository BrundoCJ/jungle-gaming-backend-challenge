# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de múltiplos provedores, via HTTP e SQS, mantendo saldo e ledger consistentes mesmo com mensagens **duplicadas**, **fora de ordem** e **concorrentes**, em **várias instâncias**.

Solução para o [Jungle Gaming Backend Challenge](https://github.com/junglegaming/backend-challenge). As decisões de arquitetura, trade-offs e limitações estão em **[ARCHITECTURE.md](ARCHITECTURE.md)**.

| | |
|---|---|
| Runtime / pacotes / testes | Bun 1.3 |
| Linguagem | TypeScript (strict) |
| Framework | NestJS 12 |
| Banco | PostgreSQL 17 |
| ORM | MikroORM 7 |
| Mensageria | AWS SQS FIFO, emulado com [MiniStack](https://github.com/ministackorg/ministack) |
| Orquestração | Docker Compose |
| Observabilidade | logs JSON (pino), métricas Prometheus, health checks |

## Subir tudo com Docker

Pré-requisito: Docker com Compose v2.

```bash
docker compose up --build
```

Isso sobe:

| Serviço | O que faz | Porta |
|---|---|---|
| `postgres` | PostgreSQL 17 | 5432 |
| `ministack` | emulador de SQS (API compatível com AWS) | 4566 |
| `sqs-init` | cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive com `maxReceiveCount = 5`) e `wallet-events.fifo` | — |
| `migrate` | aplica as migrations e termina | — |
| `app-1`, `app-2`, `app-3` | três instâncias da aplicação (HTTP + consumer SQS + publisher da outbox + worker de referências pendentes) | 3001, 3002, 3003 |

> O LocalStack não é usado porque as imagens atuais exigem token pago. O MiniStack expõe a mesma API na mesma porta (ver ARCHITECTURE.md).

## Desenvolvimento local

Pré-requisitos: Bun ≥ 1.3 e Docker.

```bash
bun install
cp .env.example .env          # aponta para Postgres/MiniStack em localhost
bun run infra:up              # sobe Postgres + MiniStack e cria as filas
bun run db:migrate:up         # aplica as migrations
bun run dev                   # app em http://localhost:3000 (com hot reload)
```

### Comandos

| Comando | Descrição |
|---|---|
| `bun run start` / `bun run dev` | inicia a aplicação (dev com watch) |
| `bun run typecheck` | `tsc --noEmit` em modo strict |
| `bun run lint` / `bun run format` | Biome (lint e formatação) |
| `bun run test:unit` | testes de unidade (domínio, sem infraestrutura) |
| `bun run test:integration` | testes de integração contra PostgreSQL e MiniStack reais |
| `bun run test:concurrency` | corridas reais, incluindo **3 processos** da aplicação com crash e reinício |
| `bun run db:migrate:up` / `db:migrate:down` / `db:migrate:status` | migrations (down reverte a última; `down 0` reverte todas) |
| `bun run infra:up` / `bun run infra:down` | sobe/derruba a infraestrutura local (down remove os volumes) |

Os testes de integração e de concorrência precisam de `bun run infra:up`. Cada arquivo de teste cria um **banco isolado** (e filas próprias quando usa SQS), então os testes não dependem de ordem nem de estado anterior.

## API

Todas as respostas de erro têm o formato `{ "error": { "code", "message", "retryable" } }`.

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | cria a wallet; saldo inicial positivo gera a transação interna `OPENING` |
| `GET` | `/wallets/:walletId` | consulta a wallet |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=` | ledger paginado (cursor opaco e estável; `limit` padrão 50, máx. 200) |
| `POST` | `/wallets/:walletId/reconciliation` | compara saldo armazenado × saldo reconstruído pelo ledger |
| `POST` | `/wagering/transactions` | submete uma transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | consulta por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | consulta pelo id do provedor |
| `GET` | `/health/live` | processo vivo |
| `GET` | `/health/ready` | PostgreSQL e SQS alcançáveis (503 caso contrário) |
| `GET` | `/metrics` | métricas Prometheus |

Status de `POST /wagering/transactions`: `201` aplicada · `202` aguardando referência · `422` rejeitada por regra de negócio (com `failureCode`) · `400` payload inválido ou sem `Idempotency-Key` · `409` mesma key com payload diferente · `503` falha transitória (reenviar com a mesma key). Um replay devolve o **mesmo status e corpo** da resposta original, com `idempotentReplay: true`.

### Exemplos

```bash
API=http://localhost:3001
PLAYER=0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1

# 1. Criar wallet
WALLET=$(curl -s -X POST $API/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}" | jq -r .id)

# 2. Apostar (repita o mesmo comando: a resposta volta igual, com idempotentReplay=true)
BET="{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-123\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
curl -s -X POST $API/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' -d "$BET"
# {"transactionId":"...","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}

# 3. Mesma key, payload diferente -> 409 IDEMPOTENCY_KEY_CONFLICT
curl -s -X POST $API/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' -d "${BET/25.00/30.00}"

# 4. Ledger e reconciliação (em qualquer instância)
curl -s http://localhost:3002/wallets/$WALLET/ledger
curl -s -X POST http://localhost:3003/wallets/$WALLET/reconciliation

# 5. Consultar pela chave do provedor
curl -s $API/providers/provider-a/wagering/transactions/transaction-123
```

### Enviar uma transação pelo SQS

```bash
docker compose run --rm --entrypoint aws sqs-init sqs send-message \
  --queue-url http://ministack:4566/000000000000/wager-transactions.fifo \
  --message-group-id "$WALLET" --message-deduplication-id msg-124 \
  --message-body "{\"messageId\":\"msg-124\",\"type\":\"WagerTransactionRequested\",\"occurredAt\":\"2026-10-16T15:00:00.000Z\",\"data\":{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-124\",\"idempotencyKey\":\"provider-a:transaction-124\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}}"

# Eventos publicados pela outbox
docker compose run --rm --entrypoint aws sqs-init sqs receive-message \
  --queue-url http://ministack:4566/000000000000/wallet-events.fifo --max-number-of-messages 10
```

## Configuração

Todas as variáveis são validadas na inicialização (Zod); os padrões servem para desenvolvimento local.

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | porta HTTP |
| `INSTANCE_ID` | hostname | identifica a instância nos logs |
| `LOG_LEVEL` | `info` | `fatal` … `trace`, `silent` |
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5432/wagering` | PostgreSQL |
| `AWS_REGION` / `AWS_ENDPOINT_URL` | `us-east-1` / — | região e endpoint do SQS (emulador em dev) |
| `SQS_WAGER_QUEUE_NAME` / `SQS_WAGER_DLQ_NAME` / `SQS_EVENTS_QUEUE_NAME` | `wager-transactions.fifo` / `wager-transactions-dlq.fifo` / `wallet-events.fifo` | filas |
| `SQS_WAIT_TIME_SECONDS` / `SQS_VISIBILITY_TIMEOUT_SECONDS` | `20` / `30` | long polling e visibilidade |
| `RUN_SQS_CONSUMER` / `RUN_OUTBOX_PUBLISHER` / `RUN_PENDING_REFERENCE_WORKER` | `true` | liga/desliga cada worker da instância |
| `OUTBOX_POLL_INTERVAL_MS` / `PENDING_REFERENCE_POLL_INTERVAL_MS` | `500` / `1000` | intervalos dos workers |

## Estrutura

```
src/
  shared/domain/          Money, erros de domínio, JSON canônico, IntegrationEvent, backoff
  shared/application/     portas (UnitOfWork, Clock, IdGenerator, MetricsRecorder) e erros de aplicação
  modules/wallet/         Wallet, WalletLedgerEntry, serviço e HTTP de wallets, reconciliação
  modules/wagering/       WagerTransaction, regras de liquidação, use case, HTTP, consumer SQS, worker
  modules/messaging/      InboxMessage, OutboxMessage, publisher da outbox
  platform/               config, logs, banco (MikroORM, migrations, repositórios), SQS, métricas, health, auth
test/
  unit/                   domínio puro
  integration/            HTTP, banco, SQS e workers contra infraestrutura real
  concurrency/            corridas e múltiplos processos
```
