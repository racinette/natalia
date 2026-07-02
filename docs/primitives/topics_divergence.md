# Topics — divergence (docs/ ↔ REFACTOR.MD ↔ src/types)

> Parked working note. Goal: decide the canonical API for topics, then reconcile all three sources. No source is authoritative yet.

## Three-source status
- **docs/topics.md**: Full surface — `ctx.topics.<name>.publish(...)`, a `topics` slot on `defineWorkflow`, and client-side `registerTopicConsumer` / `registerBatchTopicConsumer` with `filter` / `retryPolicy` / `onConsumeError` / `neverExpire`. AHEAD of code.
- **REFACTOR.MD Part 12 (Topics)**: Same full surface as docs, plus DB schema (`topic_records`, `topic_consumers`, `topic_consumer_attempt`), `affected_consumers` routing SQL, batch polling loop, retention sweeper, `TopicRecord<TPayload,TMetadata>` type. AHEAD of code.
- **src/types (impl)**: Partial. `defineTopic()` and data-only `TopicDefinition` exist. No publish accessor, no workflow-definition slot, no client registration functions, no batch consumer, no filter/onConsumeError types.

## Divergences
| # | Topic | docs/ says | REFACTOR.MD says | src/types has | Direction |
|---|-------|-----------|------------------|---------------|-----------|
| 1 | Publish from body | `ctx.topics.audit.publish(record, { metadata })` → `void`, buffered | `ctx.topics.auditEvents.publish(...)` → `void`, buffered, also in compensation contexts | No `ctx.topics` namespace in `WorkflowContext`/`CompensationContext` or `io-accessors.ts`; no `TopicAccessor` type | docs + REFACTOR ahead |
| 2 | Workflow-definition slot | `topics: { audit: auditTopic }` on `defineWorkflow` | Implied by `ctx.topics.<declaredName>` | `WorkflowDefinition` has no `topics`/`TTopics`; only the compensation `StepCompensation.topics?` slot (primitives.ts:213) and `WorkflowContract`'s `TTopics extends TopicDefinitions` exist as dependency-declaration slots, not publish slots | docs + REFACTOR ahead |
| 3 | Client single consumer | `client.registerTopicConsumer(topic, name, handler, { filter, retryPolicy, onConsumeError })` | Same + `registration` runtime options, advisory-lock identity | Not present. `TopicDefinition` is data-only; consumer registration will live on the client | docs + REFACTOR ahead |
| 4 | Batch consumer | `client.registerBatchTopicConsumer(topic, name, handler, { batch, neverExpire, ... })` | Same + `batch` options table (`maxRecords`/`intervalSeconds`/`minRecords`/`flushAfterSeconds`), `TopicRecord[]` | Not present at all | docs + REFACTOR ahead |
| 5 | Consume-error model | `onConsumeError.callback` returns `"skip"`/`"halt"`; `UnrecoverableError` for permanent failure; defaults attemptsExhausted→halt, offsetExpired→skip | Same, plus type-level narrowing of event type on `neverExpire` and `onConsumeError.retryPolicy` | No `onConsumeError`, no `attemptsExhausted`/`offsetExpired` event types; no consumer registration API yet | docs + REFACTOR ahead |
| 6 | Consumer record type | implicit `record` arg | `TopicRecord<TPayload,TMetadata>` with `id`/`payload`/`metadata` | No consumer handler types yet; definition carries `record`/`metadata` schemas only | code differs |
| 7 | Retry policy units | seconds (`intervalSeconds`, `backoffRate`, `maxAttempts`) | seconds for consume, ms for `registration`/`onConsumeError` runtime policies | No consumer retry policy types yet | docs + REFACTOR ahead |

## Open API decisions (for later)
- [ ] Does publish live at `ctx.topics.<name>.publish` (requires a `topics` slot + `TTopics` generic on `WorkflowDefinition`/`WorkflowContext`) or stay definition-attached?
- [x] Consumer registration: client method (`client.registerTopicConsumer`) per docs/REFACTOR — definition-level registration removed.
- [ ] Canonical consumer handler record shape: bare decoded payload (code) vs `TopicRecord<TPayload,TMetadata>` with `id`/`metadata` (docs/REFACTOR).
- [ ] Whether the batch consumer (`registerBatchTopicConsumer`) is in the first canonical cut at all.
- [ ] `onConsumeError` `"skip"`/`"halt"` model + `neverExpire`-driven type narrowing: confirm and implement, or drop.
- [ ] Retry-policy unit convention (seconds vs ms) and where each applies (durable consume vs runtime registration).
