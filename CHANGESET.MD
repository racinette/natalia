## Main points

2. possibly split the engine and the client. the engine **needs** workflow definitions, while the client only needs the headers. or does it? maybe it needs the entire header tree? since we need to know who is whose child: some workflows are never parents. maybe we enforce that for the client? needs thinking about. see 4 for more context on the parent-child
3. OTel integration. nuff said, needs exploratory analysis first.
4. also when designing the client we need to think about the metadata being searchable. field-wise? or what? it's really difficult to pin down at the moment.
5. Need more engine-level observability over the compensation stage. We'd need `compensationTerminated` and `compensationFailed` lifecycles as well. Also we'd need a `getResult()` counterpart to the compensation. Or do we? `waitCompensation` returning a terminal status? Needs designing.

I guess if I do all of this the public API will be feature complete.

## Addons

- We _most probably_ need a logger wrapper to support multiple logging backends.
- We _may_ want to have a clean abstraction over a storage client, instead of forcing the postgres all the way. However, this really boils down to how the actual engine is going to be implemented. I think it's better to be going both ways to meet in the middle, and then abstract away the storage cleanly - I don't think it's gonna be "implementation detail"y much.
