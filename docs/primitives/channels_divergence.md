# Channels — divergence (docs/ ↔ REFACTOR.MD ↔ src/types)

> Parked working note. Goal: decide the canonical API for channels, then reconcile all three sources. No source is authoritative yet.

## Cross-cutting: explicit contracts (implemented)

Workflows with **`channels`** declare explicit **`args`**, **`metadata`**, and **`result`**. Attached child calls that return channel-capable scope handles pass explicit **`metadata`** in the start-options bag (second argument). See [explicit-contracts.md](../explicit-contracts.md) and [child-workflows.md](./child-workflows.md).

## Three-source status
- **docs/channels.md**: Conceptual + examples. Internal read via `ctx.channels.<name>.receive()` (no-arg blocking) and `ctx.listen({...})` multiplex; external/handle is send-only (`channels.<name>.send(...)`). NO timeout/deadline args shown; NO `receiveNowait`; NO Part 14 `Date` deadline.
- **REFACTOR.MD**: `receive` has timeout overloads and Part 14 *extends* `receive` to accept `number | Date` (absolute deadline). `receiveNowait` is an awaitable read (flushes buffer) — Part 1/§ op tables. External/foreign/detached handles are send-only (`ChannelSendSurface`); no external receive.
- **src/types (impl)**: `ChannelHandle<T>` implemented with `receive()` / `receive(number)` / `receive(number, default)` overloads, `receiveNowait()` / `receiveNowait(default)`, and async-iter (`io-accessors.ts`). `receive(Date)` NOT implemented — overloads take `timeoutSeconds: number` only. External handle (`ChannelAccessorExternal<T>`) is `send`-only. So: partial vs REFACTOR — base channel done, Part 14 `Date` deadline missing.

## Divergences
| # | Topic | docs/ says | REFACTOR.MD says | src/types has | Direction |
|---|-------|-----------|------------------|---------------|-----------|
| 1 | `receive` deadline support (Part 14) | not mentioned (only no-arg `receive()`) | `receive(timeoutOrDeadline: number \| Date): ChannelReceiveCall<T \| undefined>` and `receive<TDefault>(timeoutOrDeadline: number \| Date, defaultValue): ChannelReceiveCall<T \| TDefault>` — `Date` = absolute deadline | only `number`: `receive(timeoutSeconds: number): ChannelReceiveCall<T \| undefined>` and `receive<TDefault>(timeoutSeconds: number, defaultValue): ChannelReceiveCall<T \| TDefault>` (`io-accessors.ts:49,55-61`) | REFACTOR ahead of code; docs behind both (missing all timeout/deadline overloads) |
| 2 | `receive` overloads in general | only `receive()` no-arg | no-arg + `number`(+default) + Part 14 `Date` | `receive()`, `receive(number)`, `receive(number, default)` (3 overloads, no Date) | docs behind code; code behind REFACTOR |
| 3 | `receiveNowait` (non-blocking poll) | not mentioned | awaitable read; flushes buffer; mirrors stream `readNowait` / attribute `getNowait` | `receiveNowait(): AtomicResult<T \| undefined>` and `receiveNowait<TDefault>(defaultValue): AtomicResult<T \| TDefault>` (`io-accessors.ts:71,80`) | docs missing; REFACTOR + code aligned |
| 4 | `receive` return future type | awaited inline (`await ctx.channels.cancel.receive()`) | `ChannelReceiveCall<T>` (one-shot, listen/select-able) | `interface ChannelReceiveCall<T> extends BlockingResult<T>` w/ `_kind: "channel_receive_call"` (`io-accessors.ts:20`) | docs behind code (future type / listen-ability undocumented) |
| 5 | `ctx.listen` multiplex | `ctx.listen({...})`, iterate `{ key, message }` | listen is channel-only; one-shot `ChannelReceiveCall` removed from `remaining` | `Listener<M>` yields `ListenerEvent = { key; message }`; accepts `ChannelHandle \| ChannelReceiveCall`; `remaining: ReadonlySet` (`selection.ts`) | aligned (docs key/message matches impl) |
| 6 | External/handle channel surface | send-only (`channels.<name>.send`) | send-only (`ChannelSendSurface`); no external receive | `ChannelAccessorExternal<T>` exposes only `send(...)` → `ChannelSendResult` (`engine.ts:101`) | aligned (all three: external is send-only) |

## Open API decisions (for later)
- [ ] Adopt Part 14 `receive(number | Date)` deadline overload? If yes, widen `ChannelHandle.receive` param to `number | Date` in `io-accessors.ts` and define `Date` = absolute deadline vs `number` = relative seconds.
- [ ] Document the full `receive` overload set (`number` timeout, `+default`) and `receiveNowait` in `docs/channels.md` — currently only no-arg `receive()` appears.
- [ ] Document that `receive(...)` returns a listen/select-able `ChannelReceiveCall<T>`, not a bare promise.
- [ ] Confirm external/handle channels stay send-only (no external `receive`) as the canonical contract — all three sources currently agree.
