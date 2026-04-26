# 03 Call Time Options

## Goal

Replace builder-chain configuration with explicit call-time options and ordinary sequential result handling.

## Source Coverage

- `REFACTOR.MD` Part 5: Call-Time Options and Timeout Semantics.
- `REFACTOR.MD` summary: removed call types and methods.
- Request, child-workflow, and step sections that define timeout and retry return shapes.

## Public API Target

- `RetryPolicyOptions` describes retry behavior only: `intervalSeconds`, `backoffRate`, `maxIntervalSeconds`, and per-attempt `timeoutSeconds`.
- `StepBoundary` describes workflow-side observation boundaries: relative seconds, absolute deadline, max attempts, or combinations of max attempts with wall-clock bounds.
- Step calls without `timeout` return the result directly.
- Step calls with `timeout` return `{ ok: true; result } | { ok: false; status: "timeout" }`.
- Attached child workflows always return `{ ok: true; result } | { ok: false; status: "failed"; error }`, and add `"timeout"` only when a timeout option is provided.
- Requests return the response directly without timeout and the timeout union with timeout.
- Request priority is a call option, not a builder method.
- `.retry`, `.timeout`, `.failure`, `.priority`, and `.complete` are removed.

## Affected Areas

- `src/types/definitions.ts`
- `src/types/context.ts`
- `src/types/results.ts`
- `src/types/engine.ts`
- Runtime scheduling for steps, child workflows, and requests.

## Acceptance Contract

The paired file `refactor/03_call_time_options.ts` verifies overload behavior, mutually meaningful timeout result unions, removed builders, and rejection of invalid retry/deadline option shapes.
