import type {
  AnyPublicWorkflowHeader,
  DeadLetterHandleExternal,
  DeadLetterNamespaceExternal,
  QueueNamespaceExternal,
  RequestHandleExternal,
  RequestNamespaceExternal,
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
  public readonly requests: WorkflowClient<TWfs>["requests"];
  public readonly queues: WorkflowClient<TWfs>["queues"];

  constructor(workflows: TWfs) {
    const workflowAccessors: Record<
      string,
      WorkflowClientAccessor<AnyPublicWorkflowHeader>
    > = {};
    const requestAccessors: Record<string, RequestNamespaceExternal> = {};
    const queueAccessors: Record<string, QueueNamespaceExternal> = {};
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

      const requests = (workflows[name] as { requests?: Record<string, { name?: string }> })
        .requests;
      if (requests) {
        for (const request of Object.values(requests)) {
          if (request.name && !requestAccessors[request.name]) {
            requestAccessors[request.name] = this.createRequestAccessor();
          }
        }
      }

      const queues = (workflows[name] as { queues?: Record<string, { name?: string }> }).queues;
      if (queues) {
        for (const queue of Object.values(queues)) {
          if (queue.name && !queueAccessors[queue.name]) {
            queueAccessors[queue.name] = this.createQueueAccessor();
          }
        }
      }
    }

    this.workflows = workflowAccessors as unknown as {
      [K in keyof TWfs]: WorkflowClientAccessor<TWfs[K]>;
    };
    this.requests = requestAccessors as WorkflowClient<TWfs>["requests"];
    this.queues = queueAccessors as WorkflowClient<TWfs>["queues"];
  }

  protected abstract assertClientAvailable(): void;

  private createRequestAccessor(): RequestNamespaceExternal {
    return {
      get: ((_id: unknown) => {
        this.assertClientAvailable();
        return this.createRequestHandle();
      }) as RequestNamespaceExternal["get"],
      findUnique: async (_query: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
      findMany: ((_query: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      }) as RequestNamespaceExternal["findMany"],
      count: async (_query: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
    };
  }

  private createRequestHandle(): RequestHandleExternal {
    return {
      id: "" as RequestHandleExternal["id"],
      fetchRow: async (_fieldsOrOpts?: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
      resolve: async (_response: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
      cancel: async (_opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
    } as RequestHandleExternal;
  }

  private createQueueAccessor(): QueueNamespaceExternal {
    return {
      registerHandler: (_handler: unknown, _options?: unknown) => {
        this.assertClientAvailable();
        return () => undefined;
      },
      deadLetters: this.createDeadLetterNamespace(),
    };
  }

  private createDeadLetterNamespace(): DeadLetterNamespaceExternal {
    return {
      get: ((_id: unknown) => {
        this.assertClientAvailable();
        return this.createDeadLetterHandle();
      }) as DeadLetterNamespaceExternal["get"],
      findUnique: async (_query: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
      findMany: ((_query: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      }) as DeadLetterNamespaceExternal["findMany"],
      count: async (_query: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
    };
  }

  private createDeadLetterHandle(): DeadLetterHandleExternal {
    return {
      id: "" as DeadLetterHandleExternal["id"],
      fetchRow: async (_fieldsOrOpts?: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
      retry: async (_opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
      purge: async (_opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
    } as DeadLetterHandleExternal;
  }
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
 * Accepts `PublicWorkflowHeader`, **`WorkflowInterface`**, or full
 * `WorkflowDefinition` maps (structural typing). Use when callers need the
 * typed client API (start/execute/get and introspection) without owning engine
 * lifecycle; method bodies are stubs until wired to a real runtime.
 */
export function createWorkflowClient<
  TWfs extends Record<string, AnyPublicWorkflowHeader>,
>(workflows: TWfs): WorkflowClient<TWfs> {
  return new StaticWorkflowClient(workflows);
}
