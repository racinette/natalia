# Natalia documentation

## Start here

- [Workflow identity](./primitives/workflow-identity.md) — identity block, start options, and `.get` lookup for globally addressable workflows
- [Explicit contracts](./explicit-contracts.md) — required `args` / `metadata` / `result` at definition; explicit invocation keys; required `compensation.result`
- [Workflow contract authoring](./header-interface-implementation.md) — header → interface → implementation layering
- [Error model](./error-model.md) — failures, halts, and handler vocabulary
- [Operator sessions](./operator-sessions.md) — snapshot vs watch IO and `session` scoping

## Primitives

| Topic | Guide | Divergence tracker |
| --- | --- | --- |
| Workflow identity | [workflow-identity.md](./primitives/workflow-identity.md) | — |
| Steps | [steps.md](./primitives/steps.md) | [steps_divergence.md](./primitives/steps_divergence.md) |
| Requests | [requests.md](./primitives/requests.md) | — |
| Child workflows | [child-workflows.md](./primitives/child-workflows.md) | — |
| External workflows | [external-workflows.md](./primitives/external-workflows.md) | — |
| Scopes | [scopes.md](./primitives/scopes.md) | — |
| Channels | [channels.md](./primitives/channels.md) | [channels_divergence.md](./primitives/channels_divergence.md) |
| Streams | [streams.md](./primitives/streams.md) | [streams_divergence.md](./primitives/streams_divergence.md) |
| Attributes | [attributes.md](./primitives/attributes.md) | [attributes_divergence.md](./primitives/attributes_divergence.md) |
| Events | [events.md](./primitives/events.md) | — |
| Topics | [topics.md](./primitives/topics.md) | [topics_divergence.md](./primitives/topics_divergence.md) |
| Queues | [queues.md](./primitives/queues.md) | — |
| Patches | [patches.md](./primitives/patches.md) | [patches_divergence.md](./primitives/patches_divergence.md) |

## Related

- [Resolving requests asynchronously](./resolving-requests-asynchronously.md)
