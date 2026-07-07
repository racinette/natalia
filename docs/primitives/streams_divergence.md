# Streams — divergence (docs/ ↔ src/types)

> **Baseline:** `docs/primitives/streams.md` and `src/types` (implementation). REFACTOR Part 14 is updated to match on doc sweep.

## Status

| Surface | State |
|---------|--------|
| `defineWorkflow.streams` / `ctx.streams.<n>.write` → `number` | aligned |
| External `read(offset)` → `read \| never` | aligned |
| External `readNowait(offset)` → `read \| not_found \| never` | aligned |
| Sequential consumption via explicit `read(n)` loops | aligned |
| `iterator` / reader async-iter sugar | **removed** — opts bag per read |
| `isOpen` / stream `closed` status | **removed** — terminal exhaustion is `{ status: "never" }` |
| Compensation block `streams` on operator handle | aligned (typed via `InferStepCompensationStreams`) |
| Signal abort on external reads | aligned (`AbortError`, no typed timeout arm) |

## Open follow-ups

- [ ] Runtime engine wiring (stubs only today).
- [ ] Compensation-block `attributes` / `events` / `channels` external planes (still placeholders).
