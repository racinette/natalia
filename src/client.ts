import type {
  AnyPublicWorkflowHeader,
  WorkflowClient,
  WorkflowClientAccessor,
} from "./types";

/**
 * Generic client surface shared by concrete clients and the executable engine.
 *
 * `workflows` is keyed by workflow name; each value matches `WorkflowClientAccessor`
 * (`start`, `execute`, `get`, `findUnique`, `findMany`, `count`). Subclasses
 * supply lifecycle/state guards via `assertClientAvailable()` before invoking
 * the stubbed runtime methods.
 */
export abstract class AbstractWorkflowClient<
  TWfs extends Record<string, AnyPublicWorkflowHeader>,
> implements WorkflowClient<TWfs>
{
  public readonly workflows: {
    [K in keyof TWfs]: WorkflowClientAccessor<TWfs[K]>;
  };

  constructor(workflows: TWfs) {
    const workflowAccessors: Record<
      string,
      WorkflowClientAccessor<AnyPublicWorkflowHeader>
    > = {};
    for (const [name] of Object.entries(workflows)) {
      workflowAccessors[name] = {
        start: async (_options: unknown) => {
          this.assertClientAvailable();
          throw new Error("Not implemented");
        },
        execute: async (_options: unknown) => {
          this.assertClientAvailable();
          throw new Error("Not implemented");
        },
        get: (_idempotencyKey: string) => {
          this.assertClientAvailable();
          throw new Error("Not implemented");
        },
        findUnique: async (_query: unknown, _opts?: unknown) => {
          this.assertClientAvailable();
          throw new Error("Not implemented");
        },
        findMany: ((_query: unknown, _opts?: unknown) => {
          this.assertClientAvailable();
          throw new Error("Not implemented");
        }) as WorkflowClientAccessor<AnyPublicWorkflowHeader>["findMany"],
        count: async (_query: unknown, _opts?: unknown) => {
          this.assertClientAvailable();
          throw new Error("Not implemented");
        },
      } as WorkflowClientAccessor<AnyPublicWorkflowHeader>;
    }

    this.workflows = workflowAccessors as unknown as {
      [K in keyof TWfs]: WorkflowClientAccessor<TWfs[K]>;
    };
  }

  protected abstract assertClientAvailable(): void;
}

class StaticWorkflowClient<
  TWfs extends Record<string, AnyPublicWorkflowHeader>,
> extends AbstractWorkflowClient<TWfs>
{
  protected assertClientAvailable(): void {
    // The static client has no lifecycle guard of its own.
  }
}

/**
 * Create a typed client surface from workflow public contracts.
 *
 * Accepts either lightweight `PublicWorkflowHeader` maps or full
 * `WorkflowDefinition` maps (structural typing). Use when callers need the
 * typed client API (start/execute/get and introspection) without owning engine
 * lifecycle; method bodies are stubs until wired to a real runtime.
 */
export function createWorkflowClient<
  TWfs extends Record<string, AnyPublicWorkflowHeader>,
>(workflows: TWfs): WorkflowClient<TWfs> {
  return new StaticWorkflowClient(workflows);
}
