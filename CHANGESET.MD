## Main points

3. OTel integration. nuff said, needs exploratory analysis first.
4. global rabbitmq-like queue with metadata and search query (separate tables for different topics). we could do request-response style interactions with this as well. basically allow to `.send` or `.request`, however `.request` requires a response, which kind of contradicts the entire thing. I guess it's worth separating into another entity. `request` is like a general purpose ask "whoever can do it, please, do the thing and get me the result". it's very close to a step and a channel at the same time, however, the difference is that it can be resolved in an arbitrary manner by an arbitrary entity. channel is very similar, but the problem with channels is that you don't have a way to "ask" for anything, you expect the result to come at some point in time. in a `.request` you explicitly ask for a thing and expect it to resolve to something eventually. the problem with steps is that you are the entity executing the code - while this is fine for most cases, sometimes you don't want (or simply are unable) to know the implementation details. this could be very useful for agentic workflows, where an agent might lack the instruments to finish the task, but they would be able to make a request into the void asking for something and awaiting a response to their request. while this opens up an easy way out for an agent to cheat without fully exploiting the tools at hand, I'd argue this could help immensely in cases where the agent is genuinely lacking the resources and needs human guidance.
5. global kafka-like log with metadata and search query (separate tables for different topics).
6. continue-as-new as return of new self-typed workflow from the workflow logic (what to do with compensations in this case?)
7. client vs engine: different connection sources. does client accept a pool in the constructor? or does every client method accept a pool? how to make it generic over the type of the backend?
8. a way to pause a workflow.
9. a way to make a workflow resilient to exceptions, so that it can throw, but instead of failing the wf we'd pause it, fix the error and then restart. Here we seem to need to simply create a `WorkflowError` base class and fail if either a child workflow or a step throw or an explicit `WorkflowError` is raised. Maybe we shouldn't terminate the workflow if it's a generic javascript error - it could simply be a programming error.
10. forking a workflow from a specific place in time.
11. error handling for blocks of code. `scope` could have an error handler - but the error itself is hard to trace, so we'd need a rich error type - which we may already have.
12. add `queries` or `attributes`: an attribute of a workflow that the client can `.get` - like an `event`, but with a value, similar to `stream`, but doesn't retain the history: only a single value is possible. the client `.get`s the value, and with it gets a `next` (or similar) callback, that would resolve, once the value is updated. The important thing being that `next` isn't very appropriate, as the user isn't guaranteed to actually get the next value: they are guaranteed that they get the new value, though they may have skipped some intermediate state.
13. client should have the ability to rollback any workflow. this means that they should be able to send a sigint / sigterm, in case the workflow is alive and wait for the workflow to compensate. OR if the workflow is complete, they should be able to revert its effects nonetheless by simply forcing the rollback to happen.
14. add priority to requests and queues

I guess if I do all of this the public API will be feature complete.

## Addons

- We _most probably_ need a logger wrapper to support multiple logging backends.
- We _may_ want to have a clean abstraction over a storage client, instead of forcing the postgres all the way. However, this really boils down to how the actual engine is going to be implemented. I think it's better to be going both ways to meet in the middle, and then abstract away the storage cleanly - I don't think it's gonna be "implementation detail"y much.
