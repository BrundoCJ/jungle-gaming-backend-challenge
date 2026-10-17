#!/usr/bin/env bash
# End-to-end checks against the running Docker Compose stack (make up).
# Each scenario compares the real responses with the expected ones.
#
#   scripts/manual-tests.sh [all|rules|race|sqs|dlq|crash|observability]
#
# Requires: docker compose, curl, jq.
set -uo pipefail
export MSYS_NO_PATHCONV=1 # keep Git Bash on Windows from rewriting arguments

cd "$(dirname "$0")/.."

PORTS=(3001 3002 3003)
QUEUES=http://ministack:4566/000000000000
PASSED=0
FAILED=0
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------- helpers

ok() {
  PASSED=$((PASSED + 1))
  printf '  [ok] %s\n' "$1"
}

check() { # check <description> <actual> <expected>
  if [ "$2" == "$3" ]; then
    ok "$1"
  else
    FAILED=$((FAILED + 1))
    printf '  [FALHOU] %s\n           esperado: %s\n           obtido:   %s\n' "$1" "$3" "$2"
  fi
}

section() { printf '\n== %s\n' "$1"; }

uuid() {
  printf '%04x%04x-%04x-4%03x-a%03x-%04x%04x%04x' $RANDOM $RANDOM $RANDOM \
    $((RANDOM % 4096)) $((RANDOM % 4096)) $RANDOM $RANDOM $RANDOM
}

new_wallet() { # new_wallet <balance>: sets PLAYER and WALLET
  PLAYER=$(uuid)
  WALLET=$(curl -s -X POST "localhost:${PORTS[0]}/wallets" -H 'content-type: application/json' \
    -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"$1\",\"currency\":\"BRL\"}}" | jq -r .id)
}

payload() { # payload <KIND> <id> <amount> [reference-id]
  local ref=""
  [ -n "${4:-}" ] && ref=",\"referenceExternalTransactionId\":\"$4-$WALLET\""
  printf '{"providerId":"provider-a","externalTransactionId":"%s","playerId":"%s","walletId":"%s","roundId":"r1","gameId":"g1","kind":"%s","money":{"amount":"%s","currency":"BRL"}%s}' \
    "$2-$WALLET" "$PLAYER" "$WALLET" "$1" "$3" "$ref"
}

tx() { # tx <port> <KIND> <id> <amount> [reference-id]: sets HTTP and BODY
  local response
  response=$(curl -s -w '\n%{http_code}' -X POST "localhost:$1/wagering/transactions" \
    -H 'content-type: application/json' -H "Idempotency-Key: provider-a:$3-$WALLET" \
    -d "$(payload "$2" "$3" "$4" "${5:-}")")
  HTTP=$(tail -n1 <<<"$response")
  BODY=$(sed '$d' <<<"$response")
}

field() { jq -r "$1" <<<"$BODY"; }
balance() { curl -s "localhost:${PORTS[0]}/wallets/$WALLET" | jq -r .balance.amount; }
debits() {
  curl -s "localhost:${PORTS[1]}/wallets/$WALLET/ledger?limit=200" |
    jq '[.items[] | select(.direction == "DEBIT")] | length'
}
consistent() { curl -s -X POST "localhost:${PORTS[2]}/wallets/$WALLET/reconciliation" | jq -r .consistent; }
tx_status() {
  curl -s "localhost:${PORTS[0]}/providers/provider-a/wagering/transactions/$1-$WALLET" | jq -r .status
}
http_code() { curl -s -o /dev/null -w '%{http_code}' "$1"; }

sqs() { docker compose run --rm -T --entrypoint aws sqs-init sqs "$@" 2>/dev/null; }
psql_value() { docker compose exec -T postgres psql -U wagering -d wagering -tAc "$1"; }

wait_until() { # wait_until <seconds> <command...>
  local deadline=$((SECONDS + $1))
  shift
  until "$@"; do
    [ "$SECONDS" -ge "$deadline" ] && return 1
    sleep 0.5
  done
}

envelope() { # envelope <messageId> <KIND> <id> <amount>
  printf '{"messageId":"%s","type":"WagerTransactionRequested","occurredAt":"%s","data":%s}' \
    "$1" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
    "$(payload "$2" "$3" "$4" | jq -c --arg key "provider-a:$3-$WALLET" '. + {idempotencyKey: $key}')"
}

# -------------------------------------------------------------- scenarios

rules() {
  section "Regras de negócio e idempotência (wallet com 100.00)"
  new_wallet 100.00

  tx 3001 BET bet1 30.00
  check "BET 30.00 aplicada" "$HTTP $(field .balance.amount)" "201 70.00"
  tx 3002 BET bet1 30.00
  check "replay em outra instância devolve a resposta original" \
    "$HTTP $(field .idempotentReplay) $(field .balance.amount)" "201 true 70.00"
  tx 3001 BET bet1 31.00
  check "mesma key com payload diferente é conflito" "$HTTP $(field .error.code)" "409 IDEMPOTENCY_KEY_CONFLICT"

  local missing
  missing=$(curl -s -o /dev/null -w '%{http_code}' -X POST localhost:3001/wagering/transactions \
    -H 'content-type: application/json' -d "$(payload BET nokey 1.00)")
  check "sem Idempotency-Key é 400" "$missing" "400"

  tx 3001 WIN win1 50.00 bet1
  check "WIN credita" "$HTTP $(field .balance.amount)" "201 120.00"
  tx 3001 LOSS loss1 0.00
  check "LOSS registra sem mexer no saldo" "$HTTP $(field .balance.amount)" "201 120.00"
  tx 3001 REFUND ref1 30.00 bet1
  check "REFUND devolve a BET" "$HTTP $(field .balance.amount)" "201 150.00"
  tx 3001 REFUND ref2 30.00 bet1
  check "a mesma BET não é revertida duas vezes" "$HTTP $(field .failureCode)" "422 REFERENCE_ALREADY_REVERSED"
  tx 3001 REFUND ref3 10.00 win1
  check "REFUND só referencia BET" "$HTTP $(field .failureCode)" "422 REFERENCE_INVALID_KIND"
  tx 3001 ROLLBACK rb1 50.00 win1
  check "ROLLBACK inverte o WIN" "$HTTP $(field .balance.amount)" "201 100.00"
  tx 3001 BET big 1000.00
  check "BET sem saldo é rejeitada" "$HTTP $(field .failureCode)" "422 INSUFFICIENT_FUNDS"

  tx 3001 REFUND early 10.00 bet2
  check "REFUND antes da BET fica pendente" "$HTTP $(field .status)" "202 PENDING_REFERENCE"
  tx 3001 BET bet2 10.00
  check "a BET referenciada chega" "$HTTP $(field .balance.amount)" "201 90.00"
  early_processed() { [ "$(tx_status early)" == "PROCESSED" ]; }
  wait_until 15 early_processed
  check "o worker aplica o REFUND pendente" "$(tx_status early) $(balance)" "PROCESSED 100.00"
  check "saldo == ledger (reconciliação)" "$(consistent)" "true"
}

race() {
  section "Concorrência: 100.00 e duas apostas de 80.00 em instâncias diferentes (seção 8)"
  new_wallet 100.00
  race_bet() {
    tx "$1" BET "$2" 80.00
    echo "$HTTP $(field .status) $(field .failureCode)" >"$TMP/race-$2"
  }
  race_bet 3001 a &
  race_bet 3002 b &
  wait
  check "uma processada e outra rejeitada por saldo" \
    "$(cat "$TMP/race-a" "$TMP/race-b" | sort | paste -sd '|' -)" \
    "201 PROCESSED null|422 REJECTED INSUFFICIENT_FUNDS"
  check "saldo final 20.00" "$(balance)" "20.00"
  check "exatamente um débito" "$(debits)" "1"
  local winner=a
  grep -q PROCESSED "$TMP/race-b" && winner=b
  tx 3003 BET "$winner" 80.00
  check "replay numa terceira instância" "$HTTP $(field .idempotentReplay)" "201 true"

  section "Concorrência: 50 cópias da mesma aposta em paralelo nas 3 instâncias"
  new_wallet 1000.00
  for i in $(seq 1 50); do
    (
      tx "${PORTS[$((i % 3))]}" BET same 10.00
      echo "$HTTP" >"$TMP/dup-$i"
    ) &
  done
  wait
  check "todas responderam 201" "$(cat "$TMP"/dup-* | sort -u)" "201"
  check "um único débito" "$(debits)" "1"
  check "saldo 990.00" "$(balance)" "990.00"
  check "saldo == ledger (reconciliação)" "$(consistent)" "true"
}

sqs_flow() {
  section "SQS: consumo, redelivery e idempotência entre HTTP e fila"
  new_wallet 100.00
  local message
  message=$(envelope "msg-$WALLET" BET sqs1 25.00)

  sqs send-message --queue-url "$QUEUES/wager-transactions.fifo" --message-group-id "$WALLET" \
    --message-deduplication-id "first-$WALLET" --message-body "$message" >/dev/null
  balance_is_75() { [ "$(balance)" == "75.00" ]; }
  wait_until 20 balance_is_75
  check "mensagem aplicada pelo consumer" "$(balance)" "75.00"

  sqs send-message --queue-url "$QUEUES/wager-transactions.fifo" --message-group-id "$WALLET" \
    --message-deduplication-id "again-$WALLET" --message-body "$message" >/dev/null
  sleep 4
  check "redelivery (mesmo messageId) não debita de novo" "$(balance) $(debits)" "75.00 1"

  tx 3002 BET sqs1 25.00
  check "a mesma transação via HTTP é replay" "$HTTP $(field .idempotentReplay)" "201 true"

  outbox_empty() { [ "$(psql_value 'select count(*) from outbox_messages where published_at is null')" == "0" ]; }
  wait_until 20 outbox_empty
  check "todos os eventos foram publicados pela outbox" \
    "$(psql_value 'select count(*) from outbox_messages where published_at is null')" "0"
}

dlq() {
  section "DLQ: mensagem inválida vai direto para a dead-letter queue"
  dlq_count() {
    sqs get-queue-attributes --queue-url "$QUEUES/wager-transactions-dlq.fifo" \
      --attribute-names ApproximateNumberOfMessages | jq -r .Attributes.ApproximateNumberOfMessages
  }
  local before
  before=$(dlq_count)
  sqs send-message --queue-url "$QUEUES/wager-transactions.fifo" --message-group-id dlq-check \
    --message-deduplication-id "bad-$(uuid)" --message-body 'isso nao e json' >/dev/null
  dlq_grew() { [ "$(dlq_count)" -gt "$before" ]; }
  wait_until 20 dlq_grew
  check "a DLQ recebeu a mensagem malformada" "$([ "$(dlq_count)" -gt "$before" ] && echo sim)" "sim"
}

crash() {
  section "Crash: derrubar uma instância no meio e reiniciar"
  new_wallet 100.00
  docker compose kill app-2 >/dev/null 2>&1
  check "app-2 fora do ar" "$(http_code localhost:3002/health/live)" "000"
  tx 3001 BET c1 10.00
  check "app-1 continua atendendo" "$HTTP" "201"
  tx 3003 BET c2 10.00
  check "app-3 continua atendendo" "$HTTP" "201"

  docker compose start app-2 >/dev/null 2>&1
  app2_ready() { [ "$(http_code localhost:3002/health/ready)" == "200" ]; }
  wait_until 60 app2_ready
  check "app-2 voltou e está pronta" "$(http_code localhost:3002/health/ready)" "200"
  tx 3002 BET c1 10.00
  check "replay na instância reiniciada" "$HTTP $(field .idempotentReplay)" "201 true"
  check "saldo 80.00 e saldo == ledger" "$(balance) $(consistent)" "80.00 true"
}

observability() {
  section "Observabilidade: health, métricas e logs"
  for port in "${PORTS[@]}"; do
    check "/health/live e /health/ready na porta $port" \
      "$(http_code "localhost:$port/health/live") $(http_code "localhost:$port/health/ready")" "200 200"
  done

  new_wallet 10.00
  curl -s -o /dev/null -X POST localhost:3001/wagering/transactions -H 'content-type: application/json' \
    -H "x-correlation-id: check-$WALLET" -H "Idempotency-Key: provider-a:obs-$WALLET" -d "$(payload BET obs 1.00)"

  local metrics
  metrics=$(curl -s localhost:3001/metrics)
  for name in wager_transactions_total wager_duplicates_total wager_processing_duration_seconds \
    sqs_messages_total sqs_message_retries_total sqs_dead_lettered_total db_lock_conflicts_total \
    outbox_messages_total outbox_lag_seconds wallet_reconciliation_mismatches_total; do
    check "métrica $name exposta" "$(grep -c "^# TYPE $name " <<<"$metrics")" "1"
  done

  sleep 1
  local line
  line=$(docker compose logs app-1 --no-log-prefix 2>/dev/null | grep "check-$WALLET" | tail -n1)
  check "log JSON com correlationId, transactionId e walletId" \
    "$(jq -r '[.correlationId, (.transactionId | length > 0), .walletId] | join(" ")' <<<"$line")" \
    "check-$WALLET true $WALLET"
  check "nenhum valor monetário no log" "$(grep -c '"amount"' <<<"$line")" "0"
}

# ------------------------------------------------------------------- main

for cmd in docker curl jq; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "requer '$cmd' instalado"
    exit 2
  }
done
if [ "$(http_code "localhost:${PORTS[0]}/health/ready")" != "200" ]; then
  echo "o stack não está no ar: rode 'make up' primeiro"
  exit 2
fi

case "${1:-all}" in
rules) rules ;;
race) race ;;
sqs) sqs_flow ;;
dlq) dlq ;;
crash) crash ;;
observability) observability ;;
all)
  rules
  race
  sqs_flow
  dlq
  crash
  observability
  ;;
*)
  echo "uso: $0 [all|rules|race|sqs|dlq|crash|observability]"
  exit 2
  ;;
esac

printf '\n%d verificações ok, %d falharam\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
