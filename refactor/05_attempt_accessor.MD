# 05 Attempt Accessor

## Goal

Unify attempt inspection across steps, queues, requests, topics, and compensation. Replace step-specific error history with a generic lazy attempt accessor and shared failure records.

## Source Coverage

- `REFACTOR.MD` Part 15: AttemptAccessor Refactoring.
- `REFACTOR.MD` Part 2: compensation `info.attempts`.
- Queue, request, and topic sections that expose handler attempt history.

## Public API Target

- `StepErrorAccessor` is renamed to `AttemptAccessor`.
- `Failure` is the base captured-throw record.
- `Attempt extends Failure` and adds the 1-indexed `attempt` field.
- `AttemptAccessor.last()`, `all()`, `count()`, `[Symbol.asyncIterator]()`, and `reverse()` are lazy.
- `count` is an async method, not a property.
- `AttemptError` is a throwable class for structured JSON failure details.
- Attempt error fields are nullable because JavaScript can throw any value.

## Runtime Target

- Steps, queue handlers, request handlers, and topic consumers persist the same attempt column pattern.
- Error extraction handles `AttemptError`, `ExplicitError`, regular `Error`, strings, and arbitrary thrown values.
- Compensation info exposes attempt access for observed forward outcomes where retry history matters.

## Affected Areas

- `src/types/results.ts`
- `src/types/context.ts`
- `src/types/definitions.ts`
- `src/types/engine.ts`
- Error serialization and attempt persistence modules.

## Acceptance Contract

The paired file `refactor/05_attempt_accessor.ts` verifies generic attempt shapes, async accessor methods, removed step-specific names, `AttemptError` construction, and shared use from queue/request/topic/compensation surfaces.
