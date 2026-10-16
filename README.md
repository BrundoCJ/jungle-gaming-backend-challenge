# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de múltiplos provedores de jogos, mantendo saldo e ledger consistentes sob entrega duplicada, fora de ordem e concorrente.

Solução para o [Jungle Gaming Backend Challenge](https://github.com/junglegaming/backend-challenge).

**Stack:** Bun · TypeScript (strict) · NestJS · PostgreSQL · MikroORM · AWS SQS (MiniStack) · Docker Compose

> Em desenvolvimento. Setup, comandos e decisões de arquitetura serão documentados aqui e em `ARCHITECTURE.md`.
