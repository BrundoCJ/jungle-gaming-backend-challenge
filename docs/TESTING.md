# Como testar

Há duas camadas de teste, e as duas rodam contra **PostgreSQL e SQS reais** (MiniStack), sem mocks de banco ou fila:

| Camada | O que é | Comando |
|---|---|---|
| **Automatizados** | suítes `bun test`: unidade, integração e concorrência (inclusive 3 processos da aplicação) | `make test` |
| **Manuais (end-to-end)** | `scripts/manual-tests.sh` exercita o stack do Docker Compose como um provedor faria e confere cada resposta | `make test-manual` |

Para rodar **absolutamente tudo do zero** (instalar dependências, subir o stack, lint, testes automatizados e manuais):

```bash
make verify
```

## Pré-requisitos

| Ferramenta | Para quê |
|---|---|
| [Bun](https://bun.sh) ≥ 1.3 | instalar dependências e rodar os testes automatizados |
| Docker com Compose v2 (rodando) | PostgreSQL, MiniStack e as 3 instâncias |
| `curl` e `jq` | testes manuais |
| `make` | atalhos (opcional: cada alvo é só um comando, listado abaixo) |

`make check-deps` confere tudo isso. No Windows, use o **Git Bash**. Se faltar o `make`, instale com `winget install ezwinports.make` ou rode diretamente os comandos da coluna "equivale a".

## Comandos `make`

`make help` lista todos os alvos.

| Alvo | O que faz | Equivale a |
|---|---|---|
| `make install` | verifica pré-requisitos e instala as dependências | `bun install --frozen-lockfile` |
| `make up` | sobe Postgres, MiniStack, filas, migrations e as instâncias nas portas 3001–3003 | `docker compose up -d --build --wait` |
| `make setup` | `install` + `up` | |
| `make down` / `make clean` | para o stack (`clean` também apaga os dados) | `docker compose down [-v]` |
| `make logs` / `make ps` | logs das instâncias / estado dos containers | `docker compose logs -f …` |
| `make dev` | aplicação local com hot reload na porta 3000 | `bun run infra:up && bun run db:migrate:up && bun run dev` |
| `make check` | typecheck strict + lint | `bun run typecheck && bun run lint` |
| `make test-unit` | testes de unidade | `bun run test:unit` |
| `make test-integration` | testes de integração (sobe a infra se preciso) | `bun run infra:up && bun run test:integration` |
| `make test-concurrency` | testes de concorrência (sobe a infra se preciso) | `bun run infra:up && bun run test:concurrency` |
| `make test` | as três suítes automatizadas | |
| `make test-manual` | todos os cenários manuais (precisa de `make up`) | `bash scripts/manual-tests.sh all` |
| `make manual-<cenário>` | um cenário: `rules`, `race`, `sqs`, `dlq`, `crash`, `observability` | `bash scripts/manual-tests.sh <cenário>` |
| `make test-all` | `check` + `test` + `test-manual` | |
| `make verify` | `setup` + `test-all` | |

## Testes automatizados

```bash
make test          # ou: bun run infra:up && bun run test:unit && bun run test:integration && bun run test:concurrency
```

| Suíte | Testes | Onde | Cobre |
|---|---|---|---|
| unidade | 154 | `test/unit` | `Money` (escala, entradas inválidas, sem arredondamento), `Wallet`, `WalletLedgerEntry`, máquina de estados da `WagerTransaction`, todas as regras de BET/WIN/LOSS/REFUND/ROLLBACK, conflito de moeda, hash canônico e payload divergente, eventos, inbox e outbox, config e logs |
| integração | 90 | `test/integration` | migrations `up → down → up` e cada constraint/trigger; unit of work (atomicidade, rollback, lock timeout, guarda de versão); toda a API HTTP; idempotência e replay; 50 apostas idênticas em paralelo; corrida da seção 8; reconciliação; consumer SQS (redelivery, HTTP+SQS, crash entre commit e ack, DLQ, shutdown); dois publishers na mesma outbox; worker de referências pendentes; health e métricas |
| concorrência | 5 | `test/concurrency` | 60 apostas numa wallet quente; wallets em paralelo; ausência de lock global; **3 processos** da aplicação recebendo cada aposta 2× por HTTP e 2× pelo SQS, com `kill -9` e reinício de uma instância |

Detalhes que garantem testes confiáveis:

- **Isolamento:** cada arquivo de teste cria um banco PostgreSQL próprio (e filas próprias quando usa SQS) e o descarta no fim. A ordem de execução não importa.
- **Invariante final:** os testes de fluxo verificam `saldo da wallet == saldo reconstruído pelo ledger == balance_after do último lançamento`.
- **Paralelismo real:** os testes de concorrência usam requisições simultâneas e processos separados, não loops sequenciais.
- **Dublês pontuais:** só dois testes trocam uma peça, e mesmo assim mantêm a infraestrutura real. Um usa um broker que falha (Postgres real) para testar o backoff da outbox; o outro usa um use case que falha transitoriamente (SQS real) para testar retry e DLQ.

O mapa requisito → arquivo de teste está em [ARCHITECTURE.md §15](../ARCHITECTURE.md#15-testes).

## Testes manuais (end-to-end)

```bash
make up            # sobe o stack (uma vez)
make test-manual   # roda todos os cenários
```

O script cria wallets novas a cada execução, então pode ser rodado quantas vezes quiser. Cada verificação imprime `[ok]` ou `[FALHOU]`, com o esperado e o obtido, e o script sai com erro se algo falhar.

| Cenário | `make` | O que verifica |
|---|---|---|
| Regras e idempotência | `manual-rules` | BET debita; replay em outra instância devolve a resposta original; mesma key com payload diferente → `409`; sem `Idempotency-Key` → `400`; WIN credita; LOSS não mexe no saldo; REFUND devolve a BET, só uma vez e só de BET; ROLLBACK inverte o WIN; BET sem saldo → `422 INSUFFICIENT_FUNDS`; REFUND antes da BET → `202 PENDING_REFERENCE` e o worker o aplica quando a BET chega; reconciliação consistente |
| Concorrência | `manual-race` | **seção 8:** 100.00 e duas apostas de 80.00 simultâneas em instâncias diferentes → uma `201`, outra `422`, saldo 20.00, um débito, replay numa terceira instância; **50 cópias** da mesma aposta distribuídas nas 3 instâncias → todas `201`, um único débito |
| SQS | `manual-sqs` | mensagem aplicada pelo consumer; redelivery do mesmo `messageId` não debita de novo; a mesma transação via HTTP é replay; a outbox publica todos os eventos |
| DLQ | `manual-dlq` | mensagem malformada vai para `wager-transactions-dlq.fifo` |
| Crash | `manual-crash` | `docker compose kill app-2`; as outras instâncias continuam atendendo; `app-2` volta, responde replay e o saldo bate com o ledger |
| Observabilidade | `manual-observability` | `/health/live` e `/health/ready` nas 3 instâncias; todas as métricas expostas em `/metrics`; log JSON com `correlationId`, `transactionId` e `walletId`, sem valores monetários |

Saída esperada (resumida):

```
== Concorrência: 100.00 e duas apostas de 80.00 em instâncias diferentes (seção 8)
  [ok] uma processada e outra rejeitada por saldo
  [ok] saldo final 20.00
  [ok] exatamente um débito
  [ok] replay numa terceira instância
...
49 verificações ok, 0 falharam
```

## Explorar na mão

Para experimentar livremente com o stack de pé (`make up`), cole no Git Bash ou num terminal Linux/macOS:

```bash
API=http://localhost:3001
PLAYER=$(printf '%04x%04x-%04x-4%03x-a%03x-%04x%04x%04x' $RANDOM $RANDOM $RANDOM $((RANDOM % 4096)) $((RANDOM % 4096)) $RANDOM $RANDOM $RANDOM)
WALLET=$(curl -s -X POST $API/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}" | jq -r .id)

# tx <TIPO> <id> <valor> [id-da-referência] [porta]
tx() {
  local ref=""
  [ -n "$4" ] && ref=",\"referenceExternalTransactionId\":\"$4-$WALLET\""
  curl -s -w " [%{http_code}]\n" -X POST "localhost:${5:-3001}/wagering/transactions" \
    -H 'content-type: application/json' -H "Idempotency-Key: provider-a:$2-$WALLET" \
    -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"$2-$WALLET\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"r1\",\"gameId\":\"g1\",\"kind\":\"$1\",\"money\":{\"amount\":\"$3\",\"currency\":\"BRL\"}$ref}"
}
```

Rode na ordem, porque cada passo parte do saldo do anterior:

| Comando | Resultado esperado |
|---|---|
| `tx BET bet1 30.00` | `201`, saldo 70.00 |
| `tx BET bet1 30.00` | `201`, mesma resposta com `idempotentReplay: true` |
| `tx BET bet1 31.00` | `409 IDEMPOTENCY_KEY_CONFLICT` |
| `tx WIN win1 50.00 bet1` | `201`, saldo 120.00 |
| `tx LOSS loss1 0.00` | `201`, saldo 120.00 |
| `tx REFUND ref1 30.00 bet1` | `201`, saldo 150.00 |
| `tx REFUND ref2 30.00 bet1` | `422 REFERENCE_ALREADY_REVERSED` |
| `tx ROLLBACK rb1 50.00 win1` | `201`, saldo 100.00 |
| `tx BET big 1000.00` | `422 INSUFFICIENT_FUNDS` |
| `tx REFUND early 10.00 bet2` | `202 PENDING_REFERENCE` |
| `tx BET bet2 10.00` | `201`; em segundos o worker aplica o REFUND e o saldo volta a 100.00 |

Mais comandos úteis:

```bash
tx BET a 80.00 "" 3001 & tx BET b 80.00 "" 3002 & wait        # corrida entre instâncias (use uma wallet nova com 100.00)
curl -s localhost:3002/wallets/$WALLET/ledger | jq             # ledger com saldo antes/depois de cada lançamento
curl -s -X POST localhost:3003/wallets/$WALLET/reconciliation | jq
curl -s localhost:3001/metrics | grep -E '^wager_|^sqs_|^outbox_'
docker compose logs -f app-1                                   # uma linha JSON por transação
docker compose kill app-2 && docker compose start app-2        # crash e reinício
```

Para enviar mensagens pelo SQS e ler os eventos publicados, veja a seção "Enviar uma transação pelo SQS" do [README](../README.md#enviar-uma-transação-pelo-sqs). No Git Bash, prefixe os comandos `docker compose run` com `MSYS_NO_PATHCONV=1`.

## Solução de problemas

| Sintoma | O que fazer |
|---|---|
| `o stack não está no ar: rode 'make up' primeiro` | `make up` e aguarde as 3 instâncias ficarem `healthy` (`make ps`) |
| `o Docker nao esta rodando` | abra o Docker Desktop e aguarde o engine iniciar |
| `port is already allocated` | outro processo usa 5432, 4566 ou 3001–3003; pare-o ou rode `make down` |
| testes de integração não conectam | `make infra` (ou `bun run infra:up`) |
| `make: command not found` no Windows | `winget install ezwinports.make`, ou rode os comandos da coluna "equivale a" |
| um cenário manual falhou | a saída mostra esperado × obtido; `make logs` mostra o que a aplicação registrou |
