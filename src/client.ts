import type {
  AnyPublicWorkflowHeader,
  CompensationBlockNamespaceExternal,
  DeadLetterHandleExternal,
  DeadLetterNamespaceExternal,
  QueueNamespaceExternal,
  RequestCompensationNamespaceExternal,
  RequestHandleExternal,
  RequestNamespaceExternal,
  WorkflowClient,
  WorkflowClientAccessor,
} from "./types";

/**
 * Generic client surface shared by concrete clients and the executable engine.
 *
 * `workflows` is keyed by workflow name; each value matches `WorkflowClientAccessor`
 * (`start`, `execute`, `get`, `find`, `count`). Subclasses
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
  public readonly compensations: WorkflowClient<TWfs>["compensations"];

  constructor(workflows: TWfs) {
    const workflowAccessors: Record<
      string,
      WorkflowClientAccessor<AnyPublicWorkflowHeader>
    > = {};
    const requestAccessors: Record<string, RequestNamespaceExternal> = {};
    const queueAccessors: Record<string, QueueNamespaceExternal> = {};
    const compensationStepAccessors: Record<
      string,
      CompensationBlockNamespaceExternal<unknown>
    > = {};
    const compensationRequestAccessors: Record<
      string,
      RequestCompensationNamespaceExternal
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
        find: ((_query: unknown, _opts?: unknown) => {
          this.assertClientAvailable();
          throw new Error("Not implemented");
        }) as WorkflowClientAccessor<AnyPublicWorkflowHeader>["find"],
        count: async (_query: unknown, _opts?: unknown) => {
          this.assertClientAvailable();
          throw new Error("Not implemented");
        },
      } as WorkflowClientAccessor<AnyPublicWorkflowHeader>;

      const requests = (workflows[name] as { requests?: Record<string, { name?: string; compensation?: unknown }> })
        .requests;
      if (requests) {
        for (const request of Object.values(requests)) {
          if (request.name && !requestAccessors[request.name]) {
            requestAccessors[request.name] = this.createRequestAccessor();
          }
          if (
            request.name &&
            request.compensation !== undefined &&
            !compensationRequestAccessors[request.name]
          ) {
            compensationRequestAccessors[request.name] =
              this.createRequestCompensationNamespace();
          }
        }
      }

      const steps = (workflows[name] as { steps?: Record<string, { name?: string; compensation?: unknown }> })
        .steps;
      if (steps) {
        for (const step of Object.values(steps)) {
          if (
            step.name &&
            step.compensation !== undefined &&
            !compensationStepAccessors[step.name]
          ) {
            compensationStepAccessors[step.name] =
              this.createCompensationBlockNamespace();
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
    this.compensations = {
      requests: compensationRequestAccessors,
      steps: compensationStepAccessors,
    } as WorkflowClient<TWfs>["compensations"];
  }

  protected abstract assertClientAvailable(): void;

  private createRequestAccessor(): RequestNamespaceExternal {
    return {
      registerHandler: (_handler: unknown, _options?: unknown) => {
        this.assertClientAvailable();
        return () => undefined;
      },
      get: ((_id: unknown) => {
        this.assertClientAvailable();
        return this.createRequestHandle();
      }) as RequestNamespaceExternal["get"],
      find: ((_query: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      }) as RequestNamespaceExternal["find"],
      count: async (_query: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
    };
  }

  private createRequestHandle(): RequestHandleExternal {
    return {
      id: "" as RequestHandleExternal["id"],
      fetchRow: async (_opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
      attempts: this.createOperatorAttemptsNamespace(),
      resolve: async (_response: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
      escalateToManual: async (_escalation: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
    } as unknown as RequestHandleExternal;
  }

  private createOperatorAttemptsNamespace() {
    return {
      get: ((_attempt: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      }) as never,
      find: ((_query: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      }) as never,
      count: async (_query: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
    };
  }

  private createRequestCompensationNamespace(): RequestCompensationNamespaceExternal {
    return {
      get: ((_id: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      }) as RequestCompensationNamespaceExternal["get"],
      find: ((_query: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      }) as RequestCompensationNamespaceExternal["find"],
      count: async (_query: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
    };
  }

  private createCompensationBlockNamespace(): CompensationBlockNamespaceExternal<
    unknown
  > {
    return {
      get: ((_id: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      }) as CompensationBlockNamespaceExternal<unknown>["get"],
      find: ((_query: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      }) as CompensationBlockNamespaceExternal<unknown>["find"],
      count: async (_query: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
    };
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
      find: ((_query: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      }) as DeadLetterNamespaceExternal["find"],
      count: async (_query: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
    };
  }

  private createDeadLetterHandle(): DeadLetterHandleExternal {
    return {
      id: "" as DeadLetterHandleExternal["id"],
      fetchRow: async (_opts?: unknown) => {
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
      attempts: this.createOperatorAttemptsNamespace(),
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
