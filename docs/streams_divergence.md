# Streams — divergence (docs/ ↔ REFACTOR.MD ↔ src/types)

> Parked working note. Goal: decide the canonical API for streams, then reconcile all three sources. No source is authoritative yet.

## Three-source status
- **docs/streams.md**: Conceptual + examples only. Internal write `ctx.streams.<name>.write(...)`; external handle reads via `streams.<name>.read(offset)`, `iterator`, and async iteration. NO mention of the Part 14 `readNowait` non-blocking read.
- **REFACTOR.MD Part 14 (Streams Extension)**: Adds `readNowait(offset)` on the *external* handle — a non-blocking read variant returning `not_found` instead of waiting. Spec-only addition layered on the existing reader.
- **src/types (impl)**: Reader (`StreamReaderAccessorExternal<T>`) and writer (`StreamAccessor<T>`) implemented; `read`/`iterator`/`isOpen`/async-iter all present. `readNowait` NOT implemented anywhere (`grep -rn readNowait src/` → 0 hits). So: partial vs REFACTOR — base reader done, Part 14 extension missing.

## Divergences
| # | Topic | docs/ says | REFACTOR.MD says | src/types has | Direction |
|---|-------|-----------|------------------|---------------|-----------|
| 1 | Non-blocking read `readNowait` | not mentioned | `readNowait(offset: number): Promise<StreamReadResult<T> \| { status: "not_found" }>` and `readNowait(offset, defaultValue: D): Promise<StreamReadResult<T> \| { status: "not_found"; value: D }>` (Part 14) | absent — `StreamReaderAccessorExternal<T>` exposes only `read(offset, options?)`, `iterator(start?, end?)`, `isOpen(opts?)`, `[asyncIterator]` (`src/types/engine.ts`) | REFACTOR ahead of docs AND code; docs missing Part 14 |
| 2 | External read result shape | `got.ok && got.status === "received"` → `got.data` | `StreamReadResult<T>` (also `not_found` arm for readNowait) | `StreamReadResult<T> = {ok:true;status:"received";data:T;offset:number} \| {ok:false;status:"closed"} \| {ok:false;status:"not_found"}` (`src/types/results.ts:382`) — note docs example omits `offset` and the `closed`/`not_found` arms | docs behind code (incomplete) |
| 3 | External reader surface (`iterator`/`isOpen`) | shows `read`, `iterator`, async-iteration; no `isOpen` | base reader assumed | `iterator(startOffset?, endOffset?)` → `StreamIteratorHandleExternal<T>`, plus `isOpen(opts?)` → `StreamOpenResult` (`src/types/engine.ts:130-147`) | docs behind code (`isOpen`, offset bounds undocumented) |
| 4 | Internal write accessor | `ctx.streams.<name>.write(data)`, buffered, void | buffered op (Part 1 table); offset observable only externally | `interface StreamAccessor<T> { write(data: T): void }` (`io-accessors.ts:101`) | aligned (all three agree) |
| 5 | Stream defn schema | `streams: { name: zodSchema }` | `streams?: { [name]: JsonSchemaConstraint }` | `StreamDefinitions = Record<string, StandardSchemaV1<JsonInput, unknown>>` (`primitives.ts:22`) | aligned in intent; REFACTOR wording `JsonSchemaConstraint` vs impl `StandardSchemaV1` is a naming gap |

## Open API decisions (for later)
- [ ] Adopt Part 14 `readNowait` on the external reader? If yes, implement in `StreamReaderAccessorExternal` and add `not_found` (+ optional `value: D`) arm; then document it in `docs/streams.md`.
- [ ] Reconcile the `readNowait` `not_found` shape with the existing `StreamReadResult<T>` which already carries a `not_found` arm (avoid two divergent `not_found` shapes — one with `value`, one without).
- [ ] Document `isOpen` and `iterator(startOffset?, endOffset?)` bounds in `docs/streams.md` (currently code-only).
- [ ] Fix docs read example to include `offset` and handle `closed` / `not_found` arms.
- [ ] Settle the schema-type vocabulary (`JsonSchemaConstraint` in REFACTOR vs `StandardSchemaV1` in code) for stream/channel definitions.
