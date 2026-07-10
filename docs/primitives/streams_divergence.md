# Streams — divergence (docs/ ↔ src/types)

> **Baseline:** `docs/primitives/streams.md` and `src/types` (implementation). REFACTOR Part 14 is updated to match on doc sweep.

## Cross-cutting: explicit contracts (implemented)

Workflows that declare `streams` must also declare explicit **`args`**, **`metadata`**, and **`result`** on the definition (`z.undefined()` / `z.void()` when empty). Client and child invocation passes explicit **`args`** and **`metadata`** keys. See [explicit-contracts.md](../explicit-contracts.md).

Compensation blocks that declare per-instance **`streams`** also require explicit **`compensation.result`**.

## Status

| Surface | State |
|---------|--------|
| `defineWorkflow.streams` / `ctx.streams.<n>.write` → `number` | aligned |
| External `read(offset)` → `read \| never` | aligned |
| External `readNowait(session, offset)` → `read \| not_found \| never` | aligned |
| External watch `read(offset, { signal? })` — no session | aligned |
| Required `session` first on snapshot/command operator IO | aligned |
| `client.session` / `client.adoptSession` via `StorageDriver<TRaw>` | aligned (types + stubs) |
| `iterator` / reader async-iter sugar | **removed** — opts bag per read |
| `isOpen` / stream `closed` status | **removed** — terminal exhaustion is `{ status: "never" }` |
| Compensation block `streams` on operator handle | aligned (typed via `InferStepCompensationStreams`) |
| Signal abort on external reads | aligned (`AbortError`, no typed timeout arm) |

## Open follow-ups

- [ ] Runtime engine wiring (stubs only today).
- [ ] Compensation-block `attributes` / `events` / `channels` external planes (still placeholders).
