# 15 Attributes And Streams

## Goal

Add observable workflow attributes and complete the non-blocking read surface for streams and channel receive deadlines.

## Source Coverage

- `REFACTOR.MD` Part 13: Attributes.
- `REFACTOR.MD` Part 14: Streams Extension.
- VEL notes about buffered operations and read flush behavior.

## Public API Target

- Workflows declare `attributes`.
- Workflow and compensation contexts can set attributes with `ctx.attributes.X.set(value)`.
- Attribute set is a synchronous buffered operation.
- External handles expose `attributes.X.get({ afterVersion?, signal? })`.
- External handles expose `attributes.X.getNowait()`.
- Stream readers expose `readNowait(offset)` overloads.
- Channel `receive` accepts `number | Date` as timeout/deadline.

## Runtime Target

- Attribute values are stored per workflow instance and attribute name.
- Attribute versions increment monotonically.
- Attribute long-polling uses notification or efficient wake-up semantics.
- `get` can return `{ status: "never" }` after workflow termination.
- `getNowait` can return `{ status: "not_set" }`.
- `readNowait` is non-blocking and mirrors channel/event nowait behavior.

## Affected Areas

- `src/types/definitions.ts`
- `src/types/context.ts`
- `src/types/engine.ts`
- Stream/channel result types.
- Attribute persistence and notification runtime.

## Acceptance Contract

The paired file `refactor/16_attributes_and_streams.ts` verifies attribute schemas, set/get/getNowait result shapes, stream `readNowait` overloads, and channel `receive(Date)` overloads.
