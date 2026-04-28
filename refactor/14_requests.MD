# 13 Requests

## Goal

Add durable requests for workflow code that needs an external handler or manual resolution path while preserving deterministic workflow execution.

## Source Coverage

- `REFACTOR.MD` Part 11: Requests.
- `REFACTOR.MD` Part 5: request call-time options.
- `REFACTOR.MD` Part 15 and 15b: attempt access and `MANUAL`.
- Request compensation tables and query surface.

## Public API Target

- Export `defineRequest`.
- Workflows declare requests and call `ctx.requests.X(payload, opts?)`.
- No timeout returns the decoded response directly.
- Timeout returns `{ ok: true; result } | { ok: false; status: "timeout" }`.
- Request handler retry policy belongs to registration.
- Handler return type is `TResponse | typeof MANUAL`.
- `MANUAL` transitions a request to manual mode without exhausting retries.
- Client APIs can resolve or cancel manual requests.
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

The paired file `refactor/14_requests.ts` verifies request definition inference, workflow-side result unions, `MANUAL`, manual client APIs, request compensation info, and rejection of queue/topic-only early termination.
