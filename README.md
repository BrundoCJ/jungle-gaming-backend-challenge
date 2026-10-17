# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de múltiplos provedores, via HTTP e SQS. Saldo e ledger continuam consistentes mesmo com mensagens **duplicadas**, **fora de ordem** e **concorrentes**, em **várias instâncias**.

Solução para o [Jungle Gaming Backend Challenge](https://github.com/junglegaming/backend-challenge). Decisões, trade-offs e limitações estão em **[ARCHITECTURE.md](ARCHITECTURE.md)**.

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

## Início rápido

```bash
make setup         # verifica pré-requisitos, instala dependências e sobe o stack (3 instâncias)
make test-all      # lint + testes automatizados + testes manuais end-to-end
```

Ou, em um passo só, do zero: `make verify`. `make help` lista todos os comandos, e **[docs/TESTING.md](docs/TESTING.md)** explica cada teste e como rodar sem `make`.

## O que o sistema garante

| Garantia | Como |
|---|---|
| Sem débito ou crédito duplicado | idempotency key persistida com `UNIQUE`, hash canônico do payload, inbox `(consumer, messageId)` no SQS e no máximo um lançamento por transação (`UNIQUE`) |
| Saldo nunca negativo | regra de domínio e `CHECK (balance >= 0)` no banco |
| Sem lost update, correto com N instâncias | `SELECT ... FOR UPDATE` por wallet (sem lock global), `UPDATE ... WHERE version = ?` e `UNIQUE (wallet_id, wallet_version)` |
| Saldo materializado == ledger | lançamento gerado pelo próprio aggregate e *constraint trigger* diferido que recusa no commit qualquer mudança de saldo sem o lançamento correspondente |
| Ledger auditável e imutável | triggers recusam `UPDATE`, `DELETE` e `TRUNCATE` |
| Nenhum evento antes do commit | transactional outbox na mesma transação SQL; publisher com `FOR UPDATE SKIP LOCKED` em todas as instâncias |
| Referência fora de ordem | `PENDING_REFERENCE` + worker com backoff exponencial; depois de ≈ 4 min, `REJECTED` com `REFERENCE_NOT_FOUND` |
| Falhas de mensageria | ack só após o commit; retry com backoff; DLQ para mensagens permanentes ou que esgotaram as tentativas; `SIGTERM` gracioso |

Fluxo de uma transação (igual para HTTP e SQS):

```
lock da wallet → idempotência (key + hash) → regras de domínio
  → transação + lançamento + saldo + eventos (outbox) [+ inbox]  → COMMIT → resposta / ack
```

## Subir tudo com Docker

Pré-requisito: Docker com Compose v2.

```bash
make up            # ou: docker compose up -d --build --wait
```

| Serviço | O que faz | Porta |
|---|---|---|
| `postgres` | PostgreSQL 17 | 5432 |
| `ministack` | emulador de SQS (API compatível com AWS) | 4566 |
| `sqs-init` | cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive com `maxReceiveCount = 5`) e `wallet-events.fifo` | — |
| `migrate` | aplica as migrations e termina | — |
| `app-1`, `app-2`, `app-3` | três instâncias da aplicação, cada uma com HTTP, consumer SQS, publisher da outbox e worker de referências pendentes | 3001, 3002, 3003 |

> O LocalStack não é usado porque as imagens atuais exigem token pago. O MiniStack expõe a mesma API na mesma porta (ver ARCHITECTURE.md §16).

## Verificação rápida

`make test-manual` roda todos os cenários de ponta a ponta e confere cada resposta automaticamente (ver [docs/TESTING.md](docs/TESTING.md#testes-manuais-end-to-end)). Para ver o essencial na mão, com o stack de pé (requer `curl` e `jq`), o roteiro abaixo cria uma wallet com 100.00. Em seguida dispara **duas apostas de 80.00 ao mesmo tempo em instâncias diferentes** (cenário obrigatório da seção 8) e repete uma delas numa terceira instância.

```bash
PLAYER=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || printf '%04x%04x-%04x-4%03x-a%03x-%04x%04x%04x' \
  $RANDOM $RANDOM $RANDOM $((RANDOM % 4096)) $((RANDOM % 4096)) $RANDOM $RANDOM $RANDOM)
WALLET=$(curl -s -X POST localhost:3001/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}" | jq -r .id)

bet() { # bet <instance-port> <externalTransactionId>
  curl -s -w " [%{http_code}]\n" -X POST "localhost:$1/wagering/transactions" \
    -H 'content-type: application/json' -H "Idempotency-Key: provider-a:$2" \
    -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"$2\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"r1\",\"gameId\":\"g1\",\"kind\":\"BET\",\"money\":{\"amount\":\"80.00\",\"currency\":\"BRL\"}}"
}

bet 3001 "a-$WALLET" & bet 3002 "b-$WALLET" & wait   # uma PROCESSED (201), outra REJECTED INSUFFICIENT_FUNDS (422)
bet 3003 "a-$WALLET"                        # replay: mesma resposta, idempotentReplay=true
curl -s -X POST localhost:3002/wallets/$WALLET/reconciliation | jq '{consistent, storedBalance}'
# { "consistent": true, "storedBalance": { "amount": "20.00", "currency": "BRL" } }
```

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

Os alvos `make` (`make help`) cobrem o dia a dia; por baixo, são estes scripts:

| Comando | Descrição |
|---|---|
| `bun run start` / `bun run dev` | inicia a aplicação (dev com watch) |
| `bun run typecheck` | `tsc --noEmit` em modo strict |
| `bun run lint` / `bun run format` | Biome (lint e formatação) |
| `bun run test:unit` | testes de unidade (domínio, sem infraestrutura) |
| `bun run test:integration` | testes de integração contra PostgreSQL e MiniStack reais |
| `bun run test:concurrency` | corridas reais, incluindo **3 processos** da aplicação com crash e reinício |
| `bun run db:migrate:up` / `db:migrate:down` / `db:migrate:status` | migrations (`down` reverte a última; `down 0` reverte todas) |
| `bun run infra:up` / `bun run infra:down` | sobe/derruba a infraestrutura local (`down` remove os volumes) |

## Testes

Guia completo: **[docs/TESTING.md](docs/TESTING.md)**.

```bash
make test          # automatizados: unidade + integração + concorrência (sobe a infra se preciso)
make test-manual   # end-to-end contra o stack rodando (make up)
make test-all      # check + test + test-manual
```

| Suíte | Testes | Infraestrutura |
|---|---|---|
| unidade | 154 | nenhuma (domínio puro) |
| integração | 90 | PostgreSQL + MiniStack reais |
| concorrência | 5 | PostgreSQL + MiniStack reais, até 3 processos da aplicação |
| manuais (end-to-end) | 49 verificações | stack completo do Docker Compose (3 instâncias) |

Não há mocks de banco ou de fila. Cada arquivo de teste cria um **banco isolado** (e filas próprias quando usa SQS), então os testes não dependem de ordem nem de estado anterior. Cobertura dos cenários obrigatórios:

- `Money` (escala, entradas inválidas, sem arredondamento silencioso), invariantes da `Wallet`, todas as regras de `BET`/`WIN`/`LOSS`/`REFUND`/`ROLLBACK`, conflito de moeda e idempotency key com payload divergente;
- migrations `up → down → up` e cada constraint e trigger do schema;
- atomicidade entre wallet, ledger, inbox e outbox; redelivery; retry e DLQ; dois publishers sobre a mesma outbox;
- **50 apostas idênticas em paralelo → um único débito**; saldo 100.00 com duas apostas de 80.00; 60 apostas contra uma wallet quente; wallets distintas em paralelo, sem lock global;
- **3 processos** recebendo cada aposta 2× por HTTP e 2× pelo SQS, com uma instância derrubada (`kill -9`) e reiniciada no meio;
- worker morto depois do commit e antes do ack; `REFUND`/`ROLLBACK` antes da referência; reinício com consistência final.

Ao fim dos testes de fluxo, todos verificam a invariante `saldo da wallet == saldo reconstruído pelo ledger == balance_after do último lançamento`.

## API

Respostas de erro sempre seguem `{ "error": { "code", "message", "retryable" } }`.

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | cria a wallet; saldo inicial positivo gera a transação interna `OPENING` |
| `GET` | `/wallets/:walletId` | consulta a wallet |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=` | ledger paginado (cursor opaco e estável; `limit` padrão 50, máx. 200) |
| `POST` | `/wallets/:walletId/reconciliation` | compara saldo armazenado × saldo reconstruído pelo ledger (divergências são logadas e sinalizadas, nunca corrigidas) |
| `POST` | `/wagering/transactions` | submete uma transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | consulta por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | consulta pelo id do provedor |
| `GET` | `/health/live` | processo vivo |
| `GET` | `/health/ready` | PostgreSQL e SQS alcançáveis (`503` caso contrário) |
| `GET` | `/metrics` | métricas Prometheus |

Status de `POST /wagering/transactions`:

| Status | Significado | O provedor deve |
|---|---|---|
| `201` | transação aplicada | — |
| `202` | aguardando a transação referenciada (`PENDING_REFERENCE`) | aguardar o evento |
| `422` | rejeitada por regra de negócio, com `failureCode` | não reenviar igual |
| `400` | payload inválido ou sem `Idempotency-Key` | corrigir a requisição |
| `409` | mesma key com payload diferente | não reenviar |
| `503` | falha transitória (com `Retry-After`) | reenviar com a **mesma** key |

Um replay devolve o **mesmo status e corpo** da resposta original, incluindo o saldo observado na época, com `idempotentReplay: true`. A lista de `failureCode`s e a ação esperada para cada um está em [ARCHITECTURE.md §8](ARCHITECTURE.md#8-failure-codes).

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

Use `walletId` como `MessageGroupId`: a ordem por wallet ajuda, mas a correção não depende dela (o banco garante as invariantes).

## Observabilidade

- **Logs:** uma linha JSON por transação, com os ids do contexto. Nunca aparecem valores monetários nem payloads:

  ```json
  {"level":"info","service":"wagering-processor","instanceId":"app-1","correlationId":"e2e-check-1","walletId":"01a146f6-…","providerId":"provider-a","transactionId":"01a146f8-…","context":"ProcessWagerTransactionUseCase","message":"BET PROCESSED via http"}
  ```

  O header `x-correlation-id` é propagado (ou gerado) e devolvido na resposta; nas mensagens SQS, o `messageId` vira o `correlationId`.
- **Métricas** (`/metrics`, por instância):
  - `wager_transactions_total{kind,status,channel}`
  - `wager_duplicates_total{channel,mechanism}`
  - `wager_processing_duration_seconds`
  - `sqs_messages_total`, `sqs_message_retries_total`, `sqs_dead_lettered_total`
  - `db_lock_conflicts_total`
  - `outbox_messages_total`, `outbox_lag_seconds`
  - `wallet_reconciliation_mismatches_total`
- **Health:** `/health/live` e `/health/ready`, ambos sem autenticação.

## Autenticação

Não implementada, por decisão: não pontua na avaliação e competiria com correção, concorrência e idempotência. O ponto de extensão está no código: um `AuthGuard` global apoiado em um `ProviderIdentityPort`, com o adapter atual aceitando todos. O desenho proposto (OIDC client credentials com Keycloak ou Zitadel, mapeando o token para `providerId`) está em [ARCHITECTURE.md §13](ARCHITECTURE.md#13-autenticação).

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
scripts/
  migrate.ts              CLI de migrations (up/down/status)
  manual-tests.sh         cenários end-to-end autoverificáveis contra o stack
docs/TESTING.md           como testar tudo (automatizado e manual)
Makefile                  atalhos: setup, up, test, test-manual, verify
```

## Solução de problemas

| Sintoma | Causa provável |
|---|---|
| `port is already allocated` ao subir o compose | outro serviço usando 5432, 4566 ou 3001–3003; pare-o ou rode `docker compose down` num stack anterior |
| `/health/ready` retorna `503` com `sqs: down` | o `sqs-init` ainda não terminou ou o MiniStack reiniciou sem as filas; rode `docker compose up sqs-init` |
| testes de integração falham ao conectar | a infraestrutura local não está de pé; rode `bun run infra:up` |
