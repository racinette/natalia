# 13 Queues

## Goal

Implement global durable queues per [docs/queues.md](../docs/queues.md).

## Source Coverage

- [docs/queues.md](../docs/queues.md) — authoritative public API and semantics.
- [docs/error-model.md](../docs/error-model.md) — queue handler errors vs workflow `ctx.errors`.
- Search query generalization for dead-letter APIs.

## Public API Target

See [docs/queues.md](../docs/queues.md). Type regression: `src/types-regression-tests/13_queues.ts`.

Highlights:

- `defineQueue` (data-only: `message`, optional `error`, `defaultDelay`, `defaultTtl`).
- `ctx.queues.<slot>.enqueue` — buffered, `void`, `delay`/`ttl`/`priority`.
- `client.queues.<definitionName>.registerHandler` — required `retryPolicy` with `maxAttempts: number | null`.
- `throw ctx.error({ deadLetter, ... })` — no `DEAD_LETTER` sentinel.
- Dead-letter namespace/handle APIs with `attempts()`.

## Runtime Target

- Persist `eligible_at` / `expires_at` at enqueue commit; numeric `ttl` offsets from eligibility.
- Queue message + attempt tables; `SELECT … FOR UPDATE SKIP LOCKED` claim ordering.
- Handler attempt records with `Typed<T>` persistence and serialization validation.

## Affected Areas

- Queue definition and client modules.
- `src/types/definitions/messaging.ts`, `handlers.ts`, `results.ts`, `engine.ts`
- Migrations and queue worker runtime.

## Acceptance Contract

`src/types-regression-tests/13_queues.ts` verifies definition inference, `HasDefaultTtl` / `HasQueueErrorSchema`, workflow enqueue typing, client handler registration, `ctx.error` options, dead-letter namespace/handle typing, and `txOrConn?` placement.
