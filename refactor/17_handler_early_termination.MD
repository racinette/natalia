# 16 Handler Early Termination

## Goal

Separate request manual-mode handoff from queue/topic unrecoverable input failures.

## Source Coverage

- `REFACTOR.MD` Part 15b: Handler Early Termination.
- Request, queue, and topic handler sections.
- Attempt error extraction rules from Part 15.

## Public API Target

- Export `MANUAL`.
- Request handlers can return `TResponse | typeof MANUAL`.
- Returning `MANUAL` transitions the request directly to manual mode.
- Export `UnrecoverableError`.
- Queue handlers can throw `UnrecoverableError` to dead-letter immediately.
- Topic handlers can throw `UnrecoverableError` to trigger `onConsumeError("attemptsExhausted")` immediately.
- `UnrecoverableError` is not the request early-termination pattern.
- `AttemptError` remains retriable and structured; it does not skip retries.

## Runtime Target

- Request manual transition stops retrying without recording artificial exhaustion.
- Queue/topic unrecoverable throws are recorded as attempts and then move to exhaustion handling.
- Regular `Error` and `AttemptError` continue to follow retry policy.

## Affected Areas

- Request handler runtime.
- Queue worker runtime.
- Topic consumer runtime.
- Public error exports.

## Acceptance Contract

The paired file `refactor/17_handler_early_termination.ts` verifies legal and illegal early-termination surfaces and the distinction between `MANUAL`, `UnrecoverableError`, and `AttemptError`.
