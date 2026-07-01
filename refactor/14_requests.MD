# 14 Requests

## Goal

Add durable requests for workflow code that needs an external handler or manual resolution path while preserving deterministic workflow execution.

## Source Coverage

- `REFACTOR.MD` Part 11: Requests.
- `REFACTOR.MD` Part 5: request call-time options.
- `REFACTOR.MD` Part 15 and 15b: attempt access and handler `ctx.errors`.
- Request compensation tables and query surface.

## Public API Target

- Export `defineRequest`.
- Workflows declare requests and call `ctx.requests.X(payload, opts?)`.
- No timeout returns the decoded response directly.
- Timeout returns `{ ok: true; result } | { ok: false; status: "timeout" }`.
- Request handler retry policy belongs to registration.
- Optional `errors` on `defineRequest`; optional `errors` on `compensation` block (separate map).
- Forward handlers return `TResponse` only; `throw ctx.errors.X(..., { manual: true | false })` for escalation/retry.
- `onExhausted` and compensation paths: `return` resolves (or reports outcome); any `throw` (including `ctx.errors.X(...)`) moves to manual — no `{ manual }` flag on those contexts.
- `manual: true` (forward handler) or any throw in exhaustion/compensation contexts parks the invocation (non-terminal until `resolve`, `cancel`, or workflow timeout).
- `client.requests.<definitionName>.registerHandler` mirrors queue registration.
- Client request namespaces use the unified searchable surface: `.get(id)`,
  `.findUnique(query)`, `.findMany(query)`, and `.count(query)`.
- Request search returns typed request handles. Manual resolution and
  cancellation are handle methods: `request.resolve(response)` and
  `request.cancel()`.
- Request ids are branded by request definition name, so `.get(id)` cannot mix
  ids from different request types.
- Requests can declare compensation with typed payload and response info.

## Runtime Target

- Request records persist payload, priority, state, attempts, manual mode, and response.
- Manual resolution validates response schemas and interrupts claimed handlers.
- Cancellation unblocks workflow-side timeout/terminal observation according to the spec.

## Affected Areas

- New request definition and client modules.
- `src/types/definitions.ts`
- `src/types/context.ts`
- `src/types/engine.ts`
- Migrations and request worker runtime.

## Acceptance Contract

The paired file `src/types-regression-tests/14_requests.ts` verifies request definition inference, forward/compensation `errors` maps, `ctx.errors` + `{ manual }`, workflow-side result unions, handle-based manual client APIs, request search/prefetch typing, and compensation handler context typing.
