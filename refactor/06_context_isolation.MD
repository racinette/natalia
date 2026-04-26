# 06 Context Isolation

## Goal

Make every workflow, branch, and compensation context expose only the definitions explicitly available to that definition site.

## Source Coverage

- `REFACTOR.MD` Part 6: Context Isolation.
- `REFACTOR.MD` Part 2: no shared compensation namespace.
- `REFACTOR.MD` Part 4 and Part 7: local error and branch definitions.

## Public API Target

- Dependency filtering happens at definition time.
- A branch context sees only its declared dependencies.
- A compensation context sees only the dependencies declared under that operation's `compensation` block.
- Workflow-level errors are not automatically visible inside branches.
- Branch-level errors are not visible in the workflow body.
- Compensation blocks do not share names or primitives with one another unless declared independently.
- Removed global workflow state remains unavailable.

## Runtime Target

- Context objects are constructed from the same filtered definition metadata used by TypeScript.
- Missing primitive access should be impossible in typed code and fail clearly if attempted dynamically.
- Isolation boundaries line up with persisted branch and compensation block instances.

## Affected Areas

- `src/types/definitions.ts`
- `src/types/context.ts`
- `src/workflow.ts`
- Context construction and replay modules.
- Examples and type regression tests that currently assume broad workflow context access.

## Acceptance Contract

The paired file `refactor/06_context_isolation.ts` verifies branch, workflow, and compensation contexts expose only local dependencies and reject undeclared primitives.
