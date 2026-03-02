## Main points

1. need to figure out whether it is valuable to add synchronous compensations for attached child workflows. whether there is a possible use case at all, and if there is, is it compelling enough to justify the semantical split.
2. check that compensation is a deterministicpromise, make sure it is.
3. OTel integration. nuff said, needs exploratory analysis first.
4. Need more engine-level observability over the compensation stage. We'd need `compensationTerminated` and `compensationFailed` lifecycles as well. Also we'd need a `getResult()` counterpart to the compensation. Or do we? `waitCompensation` returning a terminal status? Needs designing.

I guess if I do all of this the public API will be feature complete.

## Addons

- We _most probably_ need a logger wrapper to support multiple logging backends.
- We _may_ want to have a clean abstraction over a storage client, instead of forcing the postgres all the way. However, this really boils down to how the actual engine is going to be implemented. I think it's better to be going both ways to meet in the middle, and then abstract away the storage cleanly - I don't think it's gonna be "implementation detail"y much.
