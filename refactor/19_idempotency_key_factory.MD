# 18 Idempotency Key Factory

## Goal

Require meaningful workflow identity by default while allowing deterministic derivation from workflow args.

## Source Coverage

- `REFACTOR.MD` Part 17: `idempotencyKeyFactory`.
- Scheduled start options from Part 16.
- Child workflow call-time options from Part 5.

## Public API Target

- Workflow start calls require `idempotencyKey` unless the workflow definition declares `idempotencyKeyFactory`.
- `idempotencyKeyFactory(args)` receives decoded workflow args.
- When a factory exists, callers may omit `idempotencyKey`.
- An explicit `idempotencyKey` overrides the factory.
- The same conditionality applies to attached child workflow starts and `startDetached`.
- Factory output is always a string.

## Runtime Target

- If a key is omitted and a factory exists, the engine computes the key after args validation.
- Explicit keys are preserved and do not call or override with the factory.
- Generated and explicit keys participate in the same uniqueness/deduplication path.

## Affected Areas

- `src/types/definitions.ts`
- `src/types/engine.ts`
- `src/types/context.ts`
- `src/workflow.ts`
- Client start runtime and child workflow start runtime.

## Acceptance Contract

The paired file `refactor/19_idempotency_key_factory.ts` verifies conditional start option typing, decoded factory args, explicit override, child workflow parity, and rejected missing keys for workflows without factories.
