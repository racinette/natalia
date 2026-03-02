## Main points

1. make sure that scope is a deterministic promise, so that it can be the input to select as well.
2. check that compensation is a deterministicpromise, make sure it is.
3. OTel integration. nuff said, needs exploratory analysis first.
4. (maybe) allow to read the current event flag values inside the workflow
5. (maybe) allow to read the stream values (I don't think so, why would we?)
6. (maybe) create a syntactic sugar over the scope that doesn't accept the callback and returns all resolved or fails the workflow: e.g. `const { flight, hotel } = await ctx.scope({ flight: ctx.steps.reserveFlight(), hotel: ctx.steps.reserveHotel() });`. I guess it's a common enough use case. Btw, I suppose we can keep this scope anonymous, as it doesn't have a body.

I guess if I do all of this the public API will be feature complete.

## Addons

- We _most probably_ need a logger wrapper to support multiple logging backends.
- We _may_ want to have a clean abstraction over a storage client, instead of forcing the postgres all the way. However, this really boils down to how the actual engine is going to be implemented. I think it's better to be going both ways to meet in the middle, and then abstract away the storage cleanly - I don't think it's gonna be "implementation detail"y much.
