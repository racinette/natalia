## Main points

3. OTel integration. nuff said, needs exploratory analysis first.
4. (maybe) allow to read the current event flag values inside the workflow
5. (maybe) allow to read the stream values (I don't think so, why would we?)

I guess if I do all of this the public API will be feature complete.

## Addons

- We _most probably_ need a logger wrapper to support multiple logging backends.
- We _may_ want to have a clean abstraction over a storage client, instead of forcing the postgres all the way. However, this really boils down to how the actual engine is going to be implemented. I think it's better to be going both ways to meet in the middle, and then abstract away the storage cleanly - I don't think it's gonna be "implementation detail"y much.
