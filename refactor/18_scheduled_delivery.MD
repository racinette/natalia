# 17 Scheduled Delivery

## Goal

Introduce one shared scheduling option type for queue messages and workflow starts.

## Source Coverage

- `REFACTOR.MD` Part 16: Scheduled Delivery.
- Queue scheduling from Part 10.
- Workflow and child workflow start options from Part 5 and Part 17.

## Public API Target

- Export `ScheduledDeliveryOptions`.
- `delaySeconds` and `scheduledAt` are mutually exclusive.
- Queue enqueue options include scheduled delivery.
- Root workflow start options include scheduled delivery.
- Attached and detached child workflow start options include scheduled delivery.
- Compensation block child-workflow dependencies use the same child workflow option shapes.

## Runtime Target

- Scheduled queue messages are invisible until their scheduled time.
- Scheduled workflow starts create durable scheduled work.
- Deadline clocks start from creation time, not scheduled start time.
- If `delaySeconds >= deadlineSeconds`, the engine rejects the start/enqueue configuration.

## Affected Areas

- `src/types/definitions.ts`
- `src/types/engine.ts`
- `src/types/context.ts`
- Client start runtime.
- Queue enqueue runtime.
- Child workflow scheduling runtime.

## Acceptance Contract

The paired file `refactor/18_scheduled_delivery.ts` verifies mutual exclusion, root start options, child workflow attached/detached options, queue enqueue scheduling, and invalid deadline/schedule combinations where they are statically representable.
