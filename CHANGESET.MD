## Main points

3. OTel integration. nuff said, needs exploratory analysis first.
7. client vs engine: different connection sources. does client accept a pool in the constructor? or does every client method accept a pool? how to make it generic over the type of the backend?
8. a way to pause a workflow.
10. forking a workflow from a specific place in time.
13. client should have the ability to rollback any workflow. this means that they should be able to send a sigint / sigterm, in case the workflow is alive and wait for the workflow to compensate. OR if the workflow is complete, they should be able to revert its effects nonetheless by simply forcing the rollback to happen.
18. we need a new primitive, a "stream aggregator" - i dunno what to call it. Basically it sits atop of some stream and aggregates the incoming messages into a "denormalized" json. It's an amalgamation of a consumer and a workflow with the workflow creating the initial state (if needed) and the consumer picking up the new pieces of data to modify on top of the thing. It should be able to start from some offset (a callback returning an offset after the consumer rights have been acquired). What would also be interesting is adding these kinds of stream aggregators dynamically. Maybe this is semantically close to an infinitely running workflow that updates an attribute. This could solve the entire issue. But we'd need a continue-as-new if we let it run infinitely and prevent it from growing infinitely large. However, this would only be possible if we let workflows consume the topics, which is a questionable capability, since it's globally stateful. workflow-as-an-object seems like a concept similar to distributed objects in restate. for now I cannot find a compelling use-case. however, the streams are effectively a way to collect some event stream into a single logical unit, so maybe this is actually what really is needed.
19. real cron-like workflows. I feel like outside 

I guess if I do all of this the public API will be feature complete.

## Addons

- We _most probably_ need a logger wrapper to support multiple logging backends.
- We _may_ want to have a clean abstraction over a storage client, instead of forcing the postgres all the way. However, this really boils down to how the actual engine is going to be implemented. I think it's better to be going both ways to meet in the middle, and then abstract away the storage cleanly - I don't think it's gonna be "implementation detail"y much.
