# 14 Topics

## Goal

Add global ordered topics with workflow publishing, named consumers, batch consumers, typed filters, and durable offset management.

## Source Coverage

- `REFACTOR.MD` Part 12: Topics.
- `REFACTOR.MD` Part 9: search query generalization for filters.
- `REFACTOR.MD` Part 15 and 15b: attempt access and `UnrecoverableError`.

## Public API Target

- Export `defineTopic`.
- Workflows declare topics and publish with `ctx.topics.X.publish(record, opts?)`.
- Publish is a synchronous buffered operation.
- Topic records carry typed payload and optional metadata.
- Client APIs register single-record consumers and batch consumers.
- Filters use `SearchQuery<{ meta; payload }>` semantics.
- `neverExpire: true` narrows `onConsumeError` so `offsetExpired` is impossible.
- Batch consumers receive a non-empty readonly array of `TopicRecord`.
- `onConsumeError` returns `"skip"` or `"halt"`.

## Runtime Target

- Per-topic insert ordering is serialized to prevent consumers from advancing past uncommitted records.
- Consumer offsets are independent by topic/name.
- Retention respects `neverExpire` consumers.
- Attempt rows record single-record and batch failures.

## Affected Areas

- New topic definition and client modules.
- `src/types/definitions.ts`
- `src/types/context.ts`
- `src/types/engine.ts`
- Migrations, topic dispatcher, retention sweeper, and consumer registration runtime.

## Acceptance Contract

The paired file `refactor/14_topics.ts` verifies publish typing, consumer and batch consumer callback shapes, filter namespaces, `TopicRecord`, `neverExpire` narrowing, and `UnrecoverableError` behavior surface.
