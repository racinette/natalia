import type {
  AnyPublicWorkflowHeader,
  CompensationBlockNamespaceExternal,
  DeadLetterHandleExternal,
  DeadLetterNamespaceExternal,
  InferSessionRaw,
  OperatorSession,
  QueueNamespaceExternal,
  RequestCompensationNamespaceExternal,
  RequestHandleExternal,
  RequestNamespaceExternal,
  StorageDriver,
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
  TDriver extends StorageDriver<any>,
> implements WorkflowClient<TWfs, TDriver>
{
  public readonly driver: TDriver;

  public readonly workflows: {
    [K in keyof TWfs]: WorkflowClientAccessor<TWfs[K]>;
  };
  public readonly requests: WorkflowClient<TWfs, TDriver>["requests"];
  public readonly queues: WorkflowClient<TWfs, TDriver>["queues"];
  public readonly compensations: WorkflowClient<TWfs, TDriver>["compensations"];

  constructor(workflows: TWfs, driver: TDriver) {
    this.driver = driver;
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
        start: async (_session: unknown, _options: unknown) => {
          this.assertClientAvailable();
          throw new Error("Not implemented");
        },
        execute: async (_session: unknown, _options: unknown) => {
          this.assertClientAvailable();
          throw new Error("Not implemented");
        },
        get: (_idempotencyKey: string) => {
          this.assertClientAvailable();
          throw new Error("Not implemented");
        },
        find: ((_session: unknown, _query: unknown, _opts?: unknown) => {
          this.assertClientAvailable();
          throw new Error("Not implemented");
        }) as WorkflowClientAccessor<AnyPublicWorkflowHeader>["find"],
        count: async (_session: unknown, _query?: unknown) => {
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
    this.requests = requestAccessors as WorkflowClient<TWfs, TDriver>["requests"];
    this.queues = queueAccessors as WorkflowClient<TWfs, TDriver>["queues"];
    this.compensations = {
      steps: compensationStepAccessors,
      requests: compensationRequestAccessors,
    } as WorkflowClient<TWfs, TDriver>["compensations"];
  }

  session<R>(
    _fn: (session: OperatorSession<InferSessionRaw<TDriver>, "engine">) => Promise<R>,
  ): Promise<R> {
    this.assertClientAvailable();
    throw new Error("Not implemented");
  }

  adoptSession(
    _raw: InferSessionRaw<TDriver>,
  ): OperatorSession<InferSessionRaw<TDriver>, "adopted"> {
    this.assertClientAvailable();
    throw new Error("Not implemented");
  }

  protected abstract assertClientAvailable(): void;

  protected createRequestAccessor(): RequestNamespaceExternal {
    return {
      get: (_id: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
      find: ((_session: unknown, _query?: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      }) as RequestNamespaceExternal["find"],
      count: async (_session: unknown, _query?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
      registerHandler: () => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
    };
  }

  protected createRequestCompensationNamespace(): RequestCompensationNamespaceExternal {
    return {
      get: (_id: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
      find: ((_session: unknown, _query?: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      }) as RequestCompensationNamespaceExternal["find"],
      count: async (_session: unknown, _query?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
    };
  }

  protected createCompensationBlockNamespace(): CompensationBlockNamespaceExternal<unknown> {
    return {
      get: (_id: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
      find: ((_session: unknown, _query?: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      }) as CompensationBlockNamespaceExternal<unknown>["find"],
      count: async (_session: unknown, _query?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
    };
  }

  protected createQueueAccessor(): QueueNamespaceExternal {
    return {
      registerHandler: () => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
      deadLetters: this.createDeadLetterNamespace(),
    };
  }

  protected createDeadLetterNamespace(): DeadLetterNamespaceExternal {
    return {
      get: (_id: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
      find: ((_session: unknown, _query?: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      }) as DeadLetterNamespaceExternal["find"],
      count: async (_session: unknown, _query?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
    };
  }

  protected createOperatorAttemptsNamespace(): DeadLetterHandleExternal["attempts"] {
    return {
      get: (_id: number) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
      find: ((_session: unknown, _query?: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      }) as DeadLetterHandleExternal["attempts"]["find"],
      count: async (_session: unknown, _query?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
    };
  }

  protected createDeadLetterHandle(): DeadLetterHandleExternal {
    return {
      id: "" as DeadLetterHandleExternal["id"],
      fetchRow: async (_session: unknown, _opts?: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
      retry: async (_session: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
      purge: async (_session: unknown) => {
        this.assertClientAvailable();
        throw new Error("Not implemented");
      },
      attempts: this.createOperatorAttemptsNamespace(),
    } as DeadLetterHandleExternal;
  }
}

class StaticWorkflowClient<
  TWfs extends Record<string, AnyPublicWorkflowHeader>,
  TDriver extends StorageDriver<any>,
> extends AbstractWorkflowClient<TWfs, TDriver>
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
 * lifecycle; method bodies are stubs until wired to a real runtime. Requires an
 * explicit {@link StorageDriver} — there is no default driver.
 */
export function createWorkflowClient<
  TWfs extends Record<string, AnyPublicWorkflowHeader>,
  TDriver extends StorageDriver<any>,
>(
  workflows: TWfs,
  driver: TDriver,
): WorkflowClient<TWfs, TDriver> {
  return new StaticWorkflowClient(workflows, driver);
}
