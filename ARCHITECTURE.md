# Arquitetura

Este documento registra as decisões técnicas, o porquê de cada uma, os trade-offs aceitos e as limitações conhecidas.

## 1. Visão geral

```
           HTTP (Idempotency-Key)                 SQS wager-transactions.fifo
                    │                                         │
                    ▼                                         ▼
          WageringController                       WagerMessageConsumer
                    │          (mesmo use case)               │  inbox (consumerName, messageId)
                    └──────────────┬──────────────────────────┘
                                   ▼
                    ProcessWagerTransactionUseCase
                                   │  1 transação SQL (READ COMMITTED)
     ┌─────────────────────────────┼──────────────────────────────────────────┐
     │ SELECT wallet ... FOR UPDATE   →   idempotência (key + payloadHash)      │
     │ decideWager / settleWager (domínio puro)                                │
     │ INSERT wager_transactions → INSERT ledger → UPDATE wallet WHERE version │
     │ INSERT outbox_messages (+ INSERT inbox_messages se veio do SQS)         │
     └─────────────────────────────┼──────────────────────────────────────────┘
                                   ▼ COMMIT  → só então: resposta HTTP / ack SQS
                                   │
          OutboxPublisher (FOR UPDATE SKIP LOCKED) ──► wallet-events.fifo
          PendingReferenceWorker (backoff) ──► reprocessa PENDING_REFERENCE
```

Cada instância roda HTTP, consumer SQS, publisher da outbox e worker de referências pendentes. Todas são equivalentes e podem ser escaladas horizontalmente; nenhuma coordenação acontece fora do PostgreSQL.

## 2. Camadas e módulos

Hexagonal leve, sem cerimônia:

| Camada | Conteúdo | Depende de |
|---|---|---|
| `domain` | `Money`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction`, regras de liquidação, eventos, inbox/outbox | nada (TypeScript puro, sem decorators de NestJS ou ORM) |
| `application` | use cases e **portas** (`UnitOfWork`, repositórios, `Clock`, `IdGenerator`, `EventPublisher`, `MetricsRecorder`) | domínio |
| `platform` / `infrastructure` | NestJS, MikroORM, SQS, pino, Prometheus | aplicação |

Módulos: `wallet`, `wagering`, `messaging`. Os objetos de domínio usam construtor `private` + factories (`create`/`open`/`enqueue`) que validam, e `rehydrate`, que reconstrói estado persistido sem revalidar transições.

## 3. Modelo de domínio

### Money

- Valor em **`bigint` de centavos** (escala fixa 2). Nenhum `number`/`float` toca dinheiro em nenhum ponto; isso elimina toda uma classe de erros e dispensa biblioteca decimal.
- `Money.from` aceita apenas string decimal não negativa com 0 a 2 casas, sem zeros à esquerda, até 18 dígitos inteiros (cabe em `numeric(20,2)`). Rejeita `NaN`, `Infinity`, notação científica, vazio, sinais e mais de 2 casas. **Não arredonda**: entrada com 3 casas é erro.
- Serializa sempre com 2 casas (`"25.5"` vira `"25.50"`). Operações entre moedas diferentes lançam `CurrencyMismatchError`. É imutável (`Object.freeze`).
- Internamente pode ficar negativo (`negate`, diferença da reconciliação), mas contratos de entrada nunca aceitam negativo.

### Wallet (aggregate root)

- Abre na **versão 1**. Saldo inicial positivo gera o lançamento `CREDIT` da transação interna `OPENING`.
- O saldo só muda por `debit`/`credit`, que **devolvem o lançamento** correspondente. O lançamento é construído e validado antes de alterar o estado, então uma falha nunca deixa saldo e ledger divergentes.
- A versão só incrementa quando o saldo muda, e o lançamento registra a versão que produziu.

### WagerTransaction (máquina de estados)

```
PENDING ──► PENDING_REFERENCE ──► (PENDING_REFERENCE, a cada retentativa)
   │                │
   └────────────────┴──► PROCESSED | REJECTED | FAILED   (terminais)
```

Sair de um estado terminal lança `InvalidTransactionStateError` (erro de programação). `PENDING` existe só em memória: a transação é criada e liquidada na mesma transação SQL. `FAILED` está modelado e protegido pelo schema, mas nenhum fluxo atual o produz, porque erros permanentes de infraestrutura vão para a DLQ sem persistir (ver §11).

### Regras de liquidação

`decideWager` é uma **função pura**: recebe transação, wallet travada, referência e se ela já foi revertida, e devolve `apply`, `record`, `reject` ou `await-reference`. `settleWager` aplica a decisão. O mesmo código atende HTTP, SQS e o worker.

| Operação | Efeito | Regras |
|---|---|---|
| `BET` | débito | rejeita com `INSUFFICIENT_FUNDS` sem saldo; não pode ter referência |
| `WIN` | crédito | pode referenciar a `BET` da mesma rodada |
| `LOSS` | nenhum (sem ledger) | pode referenciar uma `BET`; valor pode ser 0 |
| `REFUND` | crédito | exige referência a uma `BET` `PROCESSED`, de mesmo valor |
| `ROLLBACK` | inverso da referência | exige referência `BET`/`WIN`/`REFUND` `PROCESSED`, de mesmo valor; sem saldo, rejeita com `REVERSAL_WOULD_OVERDRAW` |

A referência é resolvida por `(providerId, referenceExternalTransactionId)` e precisa ter mesmo provider, player, wallet, moeda e rodada (`REFERENCE_MISMATCH`).

## 4. Persistência

**ORM: MikroORM 7**, a opção preferencial. Ele dá `em.transactional()`, `LockMode` (`FOR UPDATE`, `SKIP LOCKED`) e um migrator programático.

- **Registros separados do domínio:** `EntitySchema` (sem decorators) descreve os registros, e mappers convertem para objetos de domínio via `rehydrate`. O domínio não conhece o ORM.
- **Operações nativas explícitas em vez de change tracking:** leituras com lock, `insert`, e `nativeUpdate` condicionado à versão. Cada escrita financeira vira um único statement SQL previsível. O Unit of Work do MikroORM é usado como fronteira transacional, não como rastreador de mudanças. Trade-off: perde-se o *dirty checking*, ganha-se controle total do SQL num caminho onde isso importa.
- **Money no banco:** `numeric(20,2)`, que o MikroORM hidrata como **string** e o mapper converte com `Money.from`. Moeda em coluna própria (`char(3)`). A representação é exata ponta a ponta: string ↔ `numeric` ↔ `bigint`.
- **Migrations escritas à mão** (SQL), com `up` e `down`, listadas explicitamente no código com nomes estáveis, sem descoberta por arquivos nem snapshots. Há teste de `up → down → up`. No compose, um serviço one-shot `migrate` roda antes das instâncias.

### Garantias aplicadas no schema

| Invariante | Mecanismo no PostgreSQL |
|---|---|
| uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| saldo nunca negativo | `CHECK (balance >= 0)` em `wallets` e nos saldos do ledger |
| idempotência persistente | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| REFUND/ROLLBACK têm referência; BET/OPENING não | `CHECK`s por `kind` |
| `failure_code` existe só em REJECTED/FAILED; terminais têm `processed_at`; PROCESSED guarda o saldo observado | `CHECK`s cruzando `status` e colunas |
| uma transação é revertida no máximo uma vez | índice único parcial `(reference_transaction_id) WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')` |
| lançamento aritmeticamente correto | `CHECK (balance_after = balance_before ± amount)` e `amount > 0` |
| no máximo um lançamento por transação | `UNIQUE (transaction_id)` |
| sem lost update | `UNIQUE (wallet_id, wallet_version)` no ledger + `UPDATE ... WHERE version = :esperada` |
| ledger imutável | triggers recusam `UPDATE`, `DELETE` e `TRUNCATE` |
| **saldo materializado == ledger** | *constraint trigger* `DEFERRABLE INITIALLY DEFERRED`: no commit, toda mudança de saldo/versão de uma wallet precisa do lançamento com aquela versão e aquele `balance_after` |
| inbox deduplicada | `PRIMARY KEY (consumer_name, message_id)` |

Mesmo um bug na aplicação não consegue gravar saldo negativo, débito duplicado ou saldo sem lançamento: o banco recusa o commit.

## 5. Concorrência

**A unidade de concorrência é a `walletId`.** A estratégia combina pessimistic locking com defesas no schema:

1. Toda operação abre uma transação `READ COMMITTED` e faz `SELECT ... FROM wallets WHERE id = ? FOR UPDATE` **antes** de qualquer leitura de idempotência ou regra. Isso serializa todo o trabalho sobre uma mesma wallet, em qualquer instância, e deixa as outras wallets correndo em paralelo (não há lock global; existe teste disso).
2. **Ordem de lock fixa** (wallet → transação), igual no caminho de requisição e no worker, o que evita deadlocks.
3. `SET LOCAL lock_timeout = '2000ms'`. Lock timeout, deadlock, falha de serialização, conflito de versão e corrida de unique disparam **retry limitado** (3 tentativas com jitter) de toda a unidade de trabalho. Esgotado, vira `503` (HTTP) ou retry com backoff (SQS), e o cliente reenvia com a mesma key.
4. Defesa em profundidade: `UPDATE ... WHERE version = :esperada`, `UNIQUE (wallet_id, wallet_version)`, `CHECK (balance >= 0)` e o trigger diferido.

**Por que pessimista e não otimista:** numa *hot wallet* o otimista gera tempestades de retry sob contenção. Com o lock, as concorrentes esperam na fila do PostgreSQL (milissegundos por operação) e o resultado é determinístico. Exemplo: 60 apostas de 1.00 contra 30.00 dão exatamente 30 processadas e 30 rejeitadas. O custo é a latência sob contenção extrema numa mesma wallet, limitada pelo `lock_timeout`.

**Recursos do broker são otimização, não garantia:** o `MessageGroupId` (recomendado = `walletId`) e a deduplicação do FIFO reduzem trabalho, mas a correção vem do banco.

## 6. Idempotência

- **Fonte da verdade:** o header `Idempotency-Key` no HTTP, ou `data.idempotencyKey` no SQS. O padrão recomendado é `{providerId}:{externalTransactionId}`.
- **`payloadHash = hex(sha256(canonicalJson(campos de negócio)))`**, onde:
  - os campos são `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (com o valor normalizado para 2 casas) e `referenceExternalTransactionId`, se presente;
  - o JSON canônico ordena as chaves recursivamente (ordem de code unit UTF-16), descarta `undefined` e não tem espaços;
  - header, envelope SQS e metadados de transporte **não** entram no hash, então a mesma operação tem o mesmo hash por HTTP e por SQS.
- **Mesma key + mesmo hash:** devolve **a resposta original**, com o mesmo status e o saldo observado naquele momento (guardado em `observed_balance`) e `idempotentReplay: true`. Rejeições também são replays: uma aposta rejeitada por saldo continua rejeitada.
- **Mesma key + hash diferente:** `409 IDEMPOTENCY_KEY_CONFLICT`, nunca replay.
- **Mesmo `externalTransactionId` com outra key:** `409 EXTERNAL_TRANSACTION_ID_CONFLICT`.
- **No SQS**, a inbox `(consumerName, messageId)` é gravada **na mesma transação** do efeito. Redelivery é absorvido pela inbox; o mesmo `messageId` com corpo diferente é *poison message* e vai para a DLQ.
- Nada disso usa cache em memória: tudo é estado persistido e protegido por constraints.

## 7. Contrato HTTP

| Situação | Status | Corpo |
|---|---|---|
| transação aplicada | `201` | `{ transactionId, status: "PROCESSED", balance, idempotentReplay }` |
| aguardando referência | `202` | `status: "PENDING_REFERENCE"` |
| rejeição de regra de negócio (persistida) | `422` | `status: "REJECTED"`, `failureCode` |
| wallet inexistente (não persistida) | `422` | `error.code = "WALLET_NOT_FOUND"` |
| payload inválido / sem `Idempotency-Key` / cursor inválido | `400` | `INVALID_PAYLOAD`, `MISSING_IDEMPOTENCY_KEY`, `INVALID_CURSOR` |
| recurso não encontrado (GET) | `404` | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` |
| conflito | `409` | `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_TRANSACTION_ID_CONFLICT`, `WALLET_ALREADY_EXISTS` |
| falha transitória de infraestrutura | `503` + `Retry-After` | `SERVICE_UNAVAILABLE`, `retryable: true` |

Erros sempre seguem `{ error: { code, message, retryable } }`. O provedor decide pelo status, sem interpretar mensagem: `4xx` significa não reenviar igual, `503` significa reenviar com a mesma key. O mapeamento é o mesmo em todos os endpoints (um filtro global).

## 8. Failure codes

| Código | Quando | Ação do provedor |
|---|---|---|
| `WALLET_NOT_FOUND` | wallet inexistente | corrigir e enviar nova transação |
| `PLAYER_WALLET_MISMATCH` | wallet de outro player | corrigir e enviar nova |
| `CURRENCY_MISMATCH` | moeda ≠ moeda da wallet | corrigir e enviar nova |
| `INSUFFICIENT_FUNDS` | aposta sem saldo | nenhuma |
| `REVERSAL_WOULD_OVERDRAW` | reversão deixaria saldo negativo | acionar suporte (situação operacional distinta) |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro da janela de retentativas | enviar a referência primeiro |
| `REFERENCE_MISMATCH` | referência de outro provider/player/wallet/moeda/rodada | corrigir e enviar nova |
| `REFERENCE_INVALID_KIND` | tipo não referenciável (ex.: REFUND de WIN) | corrigir e enviar nova |
| `REFERENCE_NOT_PROCESSED` | referência foi rejeitada/falhou | nenhuma |
| `REFERENCE_ALREADY_REVERSED` | referência já revertida | nenhuma |
| `AMOUNT_MISMATCH` | valor da reversão ≠ valor da referência | corrigir e enviar nova |
| `PROCESSING_FAILED` | (reservado para `FAILED`) | acionar suporte |

Uma rejeição é terminal para a sua idempotency key: "corrigir" sempre significa enviar uma **nova** transação. Os códigos estão em `failure-code.ts` com descrição e ação.

## 9. Mensageria (SQS)

Filas: `wager-transactions.fifo` (entrada), `wager-transactions-dlq.fifo` (DLQ, redrive com `maxReceiveCount = 5`) e `wallet-events.fifo` (saída da outbox).

O consumer:

- usa **o mesmo use case** da entrada HTTP;
- faz **ack (delete) só após o commit**;
- classifica os erros:

| Classe | Exemplos | Tratamento |
|---|---|---|
| negócio (terminal) | rejeição, wallet inexistente, conflito de idempotência, payload de domínio inválido | ack |
| transitório | banco indisponível, lock esgotado, erro desconhecido | sem ack; `ChangeMessageVisibility` com backoff (2s × 2ⁿ, teto 60s); após `maxReceiveCount` a redrive policy move para a DLQ |
| permanente | JSON malformado, envelope inválido, `messageId` reutilizado com outro corpo | enviado para a DLQ na hora (com `failureReason`) e removido da fila |

- **`SIGTERM`:** `enableShutdownHooks` aborta o long poll, conclui a mensagem em andamento e devolve imediatamente a visibilidade das mensagens do lote que não começaram. O processamento é sequencial dentro de cada lote.
- **Crash entre commit e ack:** a mensagem reaparece após o visibility timeout, a inbox detecta a duplicata e o efeito não se repete (há teste).

## 10. Transactional outbox

- Transação, saldo, ledger, inbox (quando SQS) e eventos são gravados na **mesma transação SQL**. Nenhum evento é publicado antes do commit.
- O `OutboxPublisher` roda em toda instância:
  - reivindica até 25 linhas devidas com `SELECT ... FOR UPDATE SKIP LOCKED`;
  - publica cada uma em `wallet-events.fifo` com `MessageGroupId = aggregateId` e `MessageDeduplicationId = eventId`;
  - marca `published_at`, tudo dentro de uma transação.
  
  Publishers concorrentes nunca pegam a mesma linha enquanto o lock existe.
- **Cenário de falha:** se o processo morre depois do commit de negócio, ou no meio do lote, a transação do publisher sofre rollback, os locks somem e outra instância publica as linhas. A entrega é **at-least-once**: uma republicação é possível e segura, porque `eventId` é estável e o consumidor deve deduplicar por ele (o FIFO também deduplica dentro de 5 minutos).
- Falhas de publicação fazem backoff exponencial (1s até 60s) e **nunca descartam** evento confirmado.
- **Eventos:**
  - `WagerTransactionProcessed`: qualquer transação aplicada, inclusive LOSS e OPENING;
  - `WagerTransactionRejected`;
  - `WalletBalanceChanged`: somente quando há lançamento;
  - `WagerTransactionPendingReference`: só na primeira vez que a transação estaciona.
- O envelope é uma classe abstrata (`IntegrationEvent`) com `eventType`/`version` fixos no tipo; o `data` usa `MoneyProps` em string.

## 11. Referências fora de ordem

- Referência ausente, ou ainda não terminal, faz a transação ser persistida como `PENDING_REFERENCE` (HTTP `202`) com `next_reference_check_at`.
- O `PendingReferenceWorker`, em todas as instâncias, busca as transações devidas e reprocessa cada uma na sua própria transação. Ele trava a wallet, relê a transação e revalida o status, então workers concorrentes são seguros (há teste com três).
- **Limite:** backoff exponencial de 1s, 2s, 4s … 128s, com 8 checagens, ou seja **≈ 4 min 15 s** no total. Na prática, o provedor envia a operação referenciada em segundos. Quatro minutos absorvem reordenação e redelivery do broker sem deixar transações penduradas por muito tempo, e o valor é configurável na política. Esgotado, vira `REJECTED` com `REFERENCE_NOT_FOUND` e `WagerTransactionRejected` é publicado.
- Um replay de uma transação pendente devolve o estado atual (`202`); quem a resolve é o worker.

## 12. Observabilidade

- **Logs:** JSON estruturado (pino), com `instanceId` e, via `AsyncLocalStorage`, `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`. O `x-correlation-id` de entrada é reaproveitado quando bem formado. Campos de dinheiro e payloads (`money`, `amount`, `balance`, `payload`, `authorization`) são **redacted**.
- **Métricas Prometheus em `/metrics`:**

| Métrica | O que mede |
|---|---|
| `wager_transactions_total{kind,status,channel}` | transações liquidadas por status e canal (`http`, `sqs`, `worker`) |
| `wager_duplicates_total{channel,mechanism}` | duplicatas absorvidas (`idempotency-key` ou `inbox`) |
| `wager_processing_duration_seconds` | latência de processamento (histograma) |
| `sqs_messages_total{disposition,reason}`, `sqs_message_retries_total`, `sqs_dead_lettered_total` | destino das mensagens, retries e DLQ |
| `db_lock_conflicts_total` | lock timeout, deadlock e conflito de versão que forçaram retry |
| `outbox_messages_total{result}`, `outbox_lag_seconds` | publicações e idade da mensagem pendente mais antiga |
| `wallet_reconciliation_mismatches_total` | divergências encontradas na reconciliação |

- **Health:** `/health/live` (processo) e `/health/ready` (`SELECT 1` + `GetQueueAttributes`, com timeout de 2s, `503` se algum cair). São abertos, sem autenticação.
- **Reconciliação:** `POST /wallets/:id/reconciliation` trava a wallet, compara o saldo com a soma do ledger e loga, conta na métrica e sinaliza (`consistent: false`) divergências. Nunca corrige automaticamente.

## 13. Autenticação

**Decisão: não implementada**, porque não pontua e competiria com correção, concorrência e idempotência. O ponto de extensão existe no código:

- um `AuthGuard` global passa toda requisição não `@Public` por um `ProviderIdentityPort`; o adapter atual (`AllowAllProviderIdentity`) aceita todos;
- **desenho proposto:** um IdP externo (Keycloak ou Zitadel no compose) emite tokens OIDC *client credentials* por provedor. O adapter validaria o JWT pelo JWKS (assinatura, `iss`, `aud`, `exp`) e mapearia um claim para `providerId`, e o use case exigiria `payload.providerId === identity.providerId`, recusando com 403. Sem tabela própria de usuários e senhas.
- Health fica aberto. Mensagens da fila são canal interno confiável, mas o `providerId` delas continua passando pelas mesmas validações de domínio.

## 14. Interpretações adotadas

1. **Cada transação é revertida no máximo uma vez**, por REFUND **ou** ROLLBACK. Ler a regra 4 como "por tipo" permitiria REFUND + ROLLBACK da mesma BET, creditando duas vezes. ROLLBACK de um REFUND continua possível, porque referencia outra transação.
2. WIN e LOSS podem, opcionalmente, referenciar a BET da rodada; essas referências não contam como reversão.
3. LOSS pode ter valor `0.00`; as demais operações exigem valor positivo.
4. `WALLET_NOT_FOUND` não é persistido (não há wallet para associar, por FK) e responde `422`.
5. Entrada com 0 a 2 casas decimais é aceita e normalizada para 2; mais de 2 casas é rejeitada, nunca arredondada.
6. Criar wallet duplicada (player + moeda) é `409`; abrir com saldo `0.00` não gera transação OPENING nem lançamento.
7. Uma wallet de outro player é rejeitada e persistida (`PLAYER_WALLET_MISMATCH`), ficando auditável.

## 15. Testes

Todos os testes de integração e concorrência usam **PostgreSQL e MiniStack reais**, sem mocks de banco ou fila. Cada arquivo cria um banco e filas isolados.

| Requisito (seção 13 do enunciado) | Onde |
|---|---|
| Money, Wallet, regras BET/WIN/LOSS/REFUND/ROLLBACK, moeda, payload divergente | `test/unit/**` |
| migrations e constraints | `test/integration/database/*` |
| atomicidade wallet + ledger + inbox + outbox | `unit-of-work.test.ts`, `wallets.test.ts`, `wager-consumer.test.ts` |
| inbox e redelivery, retry e DLQ | `wager-consumer.test.ts` |
| publishers concorrentes sobre a mesma outbox | `outbox-publisher.test.ts`, `unit-of-work.test.ts` (SKIP LOCKED) |
| 50 apostas idênticas em paralelo → um débito | `wagering.test.ts` |
| saldo 100.00 + duas apostas de 80.00 simultâneas | `wagering.test.ts` |
| wallets distintas em paralelo / sem lock global | `test/concurrency/contention.test.ts` |
| ≥ 3 processos simultâneos | `test/concurrency/multi-instance.test.ts` |
| worker morto depois do commit e antes do ack | `wager-consumer.test.ts` |
| REFUND/ROLLBACK antes da referência | `pending-reference.test.ts`, `wagering.test.ts` |
| reinício com consistência final | `multi-instance.test.ts` (kill -9 e restart, reconciliação de todas as wallets) |

Invariante verificada nos testes de fluxo: `wallet.balance == saldo reconstruído pelo ledger == balance_after do último lançamento`.

## 16. Trade-offs, limitações e cortes deliberados

- **MiniStack em vez de LocalStack.** As imagens atuais do LocalStack (2026.x) encerram sem `LOCALSTACK_AUTH_TOKEN`. O MiniStack é open-source, usa a mesma porta e a mesma API, e foi validado para FIFO, redrive e DLQ. O código usa o SDK oficial da AWS, então trocar de emulador ou ir para a AWS real é só configuração.
- **Outbox publicada dentro da transação do lote:** mantém uma transação aberta durante as chamadas ao SQS (lote limitado a 25). É mais simples e correto que um lease com `locked_until`, ao custo de segurar conexões durante a rede. Com volume alto, a evolução seria lease + publicação fora da transação.
- **Pessimistic lock por wallet:** a latência sob contenção extrema numa única wallet é limitada pelo `lock_timeout` (2s) e pelos retries; acima disso o cliente recebe `503` e reenvia.
- **FIFO e retries:** uma mensagem em backoff segura as seguintes do mesmo `MessageGroupId` (mesma wallet). É aceitável, porque a ordem por wallet é desejável, mas um grupo pode atrasar sob falha prolongada.
- **Retenção:** inbox e outbox publicada crescem indefinidamente; em produção haveria expurgo periódico (ex.: mais de 7 dias).
- **Métricas por instância:** cada processo expõe as suas, e a agregação fica com o Prometheus.
- **Não implementado (fora do escopo ou opcional):** autenticação (§13), ledger de partidas dobradas, reversão parcial, teste de carga, OpenTelemetry e dashboards. Imutabilidade de estado terminal é garantida no domínio e pelos `CHECK`s de coerência, não por trigger.
- **Ferramenta:** no Bun 1.3.14, `expect(promise).resolves`/`.rejects` às vezes travam depois de um erro do driver PostgreSQL dentro do `bun test`. Os testes usam `await` direto e o helper `rejectionOf()`.
