## Main points

1. return timeouts to the `channel.receive`. `channel.receive(0)` is effectively a nowait. on timeout it returns `undefined` by default, but the user can specify the default value as the second optional parameter: `channel.receive(0, { status: "timeout" })`.
2. possibly split the engine and the client. the engine **needs** workflow definitions, while the client only needs the headers. or does it? maybe it needs the entire header tree? since we need to know who is whose child: some workflows are never parents. maybe we enforce that for the client? needs thinking about. see 4 for more context on the parent-child
3. OTel integration. nuff said, needs exploratory analysis first.
4. need to clarify semantics of idempotencyKey in different contexts. I think for parent / detached child workflows idempotencyKey is unique on `(workflowType, idempotencyKey)`, while for child workflows we'd have `(workflowType, idempotencyKey, parentWorkflowId)`. While this seems redundant, it kind of namespaces the workflows and incapsulates them. If we didn't do the `(workflowType, idempotencyKey, parentWorkflowId)`, this would mean that starting a child workflow might already have been done outside the current context, which is a very bad place to be in, so I think this is correct. However, this begs the question of how to search for direct children at the client level - this needs thinking. Also splits the `foreignWorkflow.[name].get()` API into child/non-child versions. Seems fair, but still better to think carefully here.
5. also when designing the client we need to think about the metadata being searchable. field-wise? or what? it's really difficult to pin down at the moment.
6. we need to better handle the types on different concurrency primitives. nothing should return a `Promise`: we need to be explicit about what runs when and `await` explicitly, never allowing any Promise-like to touch the event loop, unless awaited explicitly.
7. `dontCompensate` API needs a cleanup. We wanna remove the `compensate` and make it `ownCompensation` callback that returns the `compensate` Promise-like. This really highlights the semantics: you call the `ownCompensation` declaring that you're responsible and explicitly get the callback, otherwise you rely on the default behavior.
8. Need more engine-level observability over the compensation stage. We'd need `compensationTerminated` and `compensationFailed` lifecycles as well. Also we'd need a `getResult()` counterpart to the compensation. Or do we? `waitCompensation` returning a terminal status? Needs designing.

I guess if I do all of this the public API will be feature complete.

## Addons

- We _most probably_ need a logger wrapper to support multiple logging backends.
- We _may_ want to have a clean abstraction over a storage client, instead of forcing the postgres all the way. However, this really boils down to how the actual engine is going to be implemented. I think it's better to be going both ways to meet in the middle, and then abstract away the storage cleanly - I don't think it's gonna be "implementation detail"y much.
