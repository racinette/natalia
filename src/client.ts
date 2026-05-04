import type {
  AnyPublicWorkflowHeader,
  WorkflowClient,
  WorkflowClientAccessor,
} from "./types";

/**
 * Generic client surface shared by concrete clients and the executable engine.
 * Subclasses provide lifecycle/state guards via assertClientAvailable().
 */
export abstract class AbstractWorkflowClient<
  TWfs extends Record<string, AnyPublicWorkflowHeader>,
> implements WorkflowClient<TWfs>
{
  public readonly workflows: {
    [K in keyof TWfs]: WorkflowClientAccessor<TWfs[K]>;
  };

  constructor(workflows: TWfs) {
    const workflowAccessors: Record<string, WorkflowClientAccessor<any>> = {};
    for (const [name] of Object.entries(workflows)) {
      workflowAccessors[name] = {
        start: async (_options: any) => {
          this.assertClientAvailable();
          throw new Error("Not implemented");
        },
        execute: async (_options: any) => {
          this.assertClientAvailable();
          throw new Error("Not implemented");
        },
        get: (_idempotencyKey: string) => {
          this.assertClientAvailable();
          throw new Error("Not implemented");
        },
        search: async (_queryOrBuilder: any, _options?: any) => {
          this.assertClientAvailable();
          throw new Error("Not implemented");
        },
      };
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
 * `WorkflowDefinition` maps (structural typing). This is useful for callers
 * that only need client operations and do not own engine lifecycle.
 */
export function createWorkflowClient<
  TWfs extends Record<string, AnyPublicWorkflowHeader>,
>(workflows: TWfs): WorkflowClient<TWfs> {
  return new StaticWorkflowClient(workflows);
}
