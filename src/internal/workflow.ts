import type { Pool, Client } from "pg";
import { AsyncLock, sleep } from "./async-primitives";
import { WorkflowDefinition } from "../types";

export interface FailoverConfig {
  advisoryLockNamespace?: number;
  failoverTimeout?: number;
  releaseRowIterationLimit?: number;
  patrolInterval?: number;
  debouncePeriod?: number;
}

class ManagerConnection {
  private readonly workerfailoverTimeouts: Map<
    number,
    { timeout: NodeJS.Timeout; lastUpdated: number }
  >;
  private executorId!: number;
  private readonly client!: Client;
  private readonly schemaName: string;
  private readonly advisoryLockNamespace: number;
  private readonly workerAliveResponseBroadcastChannel: string;
  private readonly workersAliveRequestBroadcastChannel: string;
  private readonly signal: AbortSignal;
  private readonly failoverTimeout: number;
  private readonly patrolInterval: number;
  private readonly releaseRowIterationLimit: number;
  private readonly debouncePeriod: number;
  private readonly lock: AsyncLock;

  constructor({
    client,
    signal,
    schemaName = "workflows",
    failover: {
      advisoryLockNamespace = 1,
      failoverTimeout = 10000,
      releaseRowIterationLimit = 50,
      patrolInterval = 3000,
      debouncePeriod = 1000,
    } = {},
  }: {
    client: Client;
    signal: AbortSignal;
    schemaName?: string;
    failover?: FailoverConfig;
  }) {
    this.client = client;
    this.signal = signal;
    this.schemaName = schemaName;
    this.advisoryLockNamespace = advisoryLockNamespace;
    this.workerAliveResponseBroadcastChannel = `${this.schemaName}_worker_alive_response`;
    this.workersAliveRequestBroadcastChannel = `${this.schemaName}_worker_alive_request`;
    this.workerfailoverTimeouts = new Map();
    this.failoverTimeout = failoverTimeout;
    this.releaseRowIterationLimit = releaseRowIterationLimit;
    this.patrolInterval = patrolInterval;
    this.debouncePeriod = debouncePeriod;
    this.lock = new AsyncLock();
  }

  private getKnownExecutorIds(): Set<number> {
    return new Set(this.workerfailoverTimeouts.keys());
  }

  private getDebouncedExecutorIds(): Set<number> {
    const now = Date.now();
    return new Set(
      Array.from(this.workerfailoverTimeouts.entries())
        .filter(
          ([_, { lastUpdated }]) => now - lastUpdated > this.debouncePeriod
        )
        .map(([executorId]) => executorId)
    );
  }

  private async patrolLoop(): Promise<void> {
    while (!this.signal.aborted) {
      const wait = sleep(this.patrolInterval, this.signal);
      const inProgressExecutorIds = await this.lock.withLock(() =>
        this.listExecutorsWithInProgressWorkflows([this.executorId])
      );
      if (inProgressExecutorIds === undefined) {
        break;
      }
      const knownExecutorIds = this.getKnownExecutorIds();
      // if a worker has not been listed, this means it doesn't have in-progress workflows
      // so we don't care whether it's alive or not,
      // since there is nothing to recover in case it's dead
      const newExecutorIds = inProgressExecutorIds.difference(knownExecutorIds);
      const removedExecutorIds = knownExecutorIds.difference(
        inProgressExecutorIds
      );

      // these are executors that have no in-progress workflows
      for (const executorId of removedExecutorIds) {
        this.clearExecutorfailoverTimeout(executorId);
      }

      // these are new executors that we haven't seen before
      // we need to start checking for their presence
      // we assume they are alive and set the timeout to default
      for (const executorId of newExecutorIds) {
        this.setExecutorfailoverTimeout(executorId);
      }

      // all the current executors need to be checked for presence
      if (!this.signal.aborted) {
        const debouncedExecutorIds = this.getDebouncedExecutorIds();
        if (debouncedExecutorIds.size > 0) {
          await this.lock.withLock(() =>
            this.sendWorkersAliveRequest(debouncedExecutorIds)
          );
        }
        await wait;
      }
    }
  }

  private async listExecutorsWithInProgressWorkflows(
    excludeExecutorIds: number[]
  ): Promise<Set<number>> {
    const result = await this.client.query(
      `
      SELECT DISTINCT executor_id 
      FROM ${this.schemaName}.workflow
      WHERE status IN ('running', 'cancelling') AND executor_id <> ANY($1);
    `,
      [excludeExecutorIds]
    );
    return new Set(result.rows.map((row) => parseInt(row.executor_id)));
  }

  private async tryReleaseWorkflowsFromUnresponsiveExecutor(
    executorId: number
  ): Promise<{ count: number; acquired: boolean }> {
    this.clearExecutorfailoverTimeout(executorId);

    const rollbackAndReturn = async () => {
      await this.client.query("ROLLBACK");
      return { count: 0, acquired: false };
    };

    // here we're gonna try to release the worker's workflows
    await this.client.query("BEGIN");
    if (this.signal.aborted) {
      return await rollbackAndReturn();
    }
    // we want a shared lock to allow others to help us as well,
    // but prevent anybody from actually claiming the executor id
    const acquired = await this.tryAcquireAdvisoryLock(executorId, {
      shared: true,
      // release after the transaction is committed/rolled back
      xact: true,
    });
    if (!acquired || this.signal.aborted) {
      return await rollbackAndReturn();
    }
    // now we're releasing in-progress workflows
    // that are owned by the dead worker
    let count = 0;

    while (true) {
      // batch release the workflows
      const result = await this.client.query(
        `
        WITH locked_workflow AS (
          SELECT id
          FROM ${this.schemaName}.workflow
          WHERE (status = 'running' OR status = 'cancelling')
                AND executor_id = $1
          ORDER BY id
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        ),
        released_workflow AS (
          UPDATE ${this.schemaName}.workflow
          SET status = 'pending',
              executor_id = NULL
          WHERE id IN (SELECT id FROM locked_workflow)
          RETURNING id;
        )
        SELECT COUNT(id) AS cnt FROM released_workflow;
      `,
        [executorId, this.releaseRowIterationLimit]
      );
      const { cnt } = result.rows[0];
      count += cnt;
      if (cnt < this.releaseRowIterationLimit || this.signal.aborted) {
        break;
      }
    }
    await this.client.query("COMMIT");
    return { count, acquired: true };
  }

  private async acquireExecutorId(): Promise<number> {
    const result = await this.client.query(
      `SELECT nextval('${this.schemaName}.executor_id_seq') AS executor_id;`
    );
    const { executor_id } = result.rows[0];
    return executor_id;
  }

  private async tryAcquireAdvisoryLock(
    executorId: number,
    {
      shared = false,
      xact = false,
    }: {
      shared: boolean;
      xact: boolean;
    }
  ): Promise<boolean> {
    const result = await this.client.query(
      `SELECT pg_try_advisory${xact ? "_xact" : ""}_lock${
        shared ? "_shared" : ""
      }($1, $2) AS acquired;`,
      [this.advisoryLockNamespace, executorId]
    );
    return result.rows[0].acquired;
  }

  private clearExecutorfailoverTimeout(executorId: number): void {
    const val = this.workerfailoverTimeouts.get(executorId);
    if (val) {
      clearTimeout(val.timeout);
      this.workerfailoverTimeouts.delete(executorId);
    }
  }

  private setExecutorfailoverTimeout(executorId: number): void {
    if (executorId === this.executorId) return;
    if (Number.isNaN(executorId) || !Number.isSafeInteger(executorId)) return;
    const prev = this.workerfailoverTimeouts.get(executorId);
    if (prev) {
      clearTimeout(prev.timeout);
      this.workerfailoverTimeouts.delete(executorId);
    }
    const timeout = setTimeout(
      () =>
        this.lock.withLock(() =>
          this.tryReleaseWorkflowsFromUnresponsiveExecutor(executorId)
        ),
      this.failoverTimeout
    );
    const now = Date.now();
    this.workerfailoverTimeouts.set(executorId, {
      timeout,
      lastUpdated: now,
    });
  }

  private handleWorkerAliveResponseBroadcastMessage(
    payload: string | undefined
  ) {
    if (payload === undefined) return;
    const executorId = parseInt(payload);
    this.setExecutorfailoverTimeout(executorId);
  }

  private handleWorkersAliveRequestBroadcastMessage(
    payload: string | undefined
  ) {
    if (payload === undefined) return;
    const { sender, requested }: { sender: number; requested: number[] } =
      JSON.parse(payload);
    // ignore messages from ourselves
    if (sender === this.executorId) return;
    // the sender is alive, since it sent us a message
    this.setExecutorfailoverTimeout(sender);
    if (requested.includes(this.executorId)) {
      // sender asked whether we are alive
      this.sendWorkerAliveResponse();
    }
  }

  private async registerListeners(): Promise<true> {
    await this.client.query(
      `LISTEN ${this.workersAliveRequestBroadcastChannel};`
    );
    await this.client.query(
      `LISTEN ${this.workerAliveResponseBroadcastChannel};`
    );

    this.client.on("notification", (msg) => {
      const { channel, payload } = msg;

      switch (channel) {
        case this.workerAliveResponseBroadcastChannel:
          this.handleWorkerAliveResponseBroadcastMessage(payload);
          break;
        case this.workersAliveRequestBroadcastChannel:
          this.handleWorkersAliveRequestBroadcastMessage(payload);
          break;
      }
    });

    return true;
  }

  /**
   * Broadcast the presence of self to the other workers
   */
  private async sendWorkerAliveResponse(): Promise<true> {
    await this.client.query("SELECT pg_notify($1, $2)", [
      this.workerAliveResponseBroadcastChannel,
      this.executorId.toString(),
    ]);
    return true;
  }

  private async sendWorkersAliveRequest(
    requestedExecutorIds: Set<number>
  ): Promise<true> {
    await this.client.query("SELECT pg_notify($1, $2)", [
      this.workersAliveRequestBroadcastChannel,
      JSON.stringify({
        sender: this.executorId,
        requested: Array.from(requestedExecutorIds),
      }),
    ]);
    return true;
  }

  async run() {
    const inProgressExecutorIds =
      await this.listExecutorsWithInProgressWorkflows([]);
    if (this.signal.aborted) {
      return;
    }
    let identityStolen = false;
    for (const executorId of inProgressExecutorIds) {
      // we're trying to steal someone's lost identity
      // this may be a restart, so we'd like to NOT create a new identity,
      // if there is one available
      identityStolen = await this.tryAcquireAdvisoryLock(executorId, {
        shared: false,
        xact: false,
      });
      if (this.signal.aborted) {
        return;
      }
      if (identityStolen) {
        this.executorId = executorId;
        break;
      }
    }
    if (!identityStolen) {
      while (true) {
        const executorId = await this.lock.withLock(() =>
          this.acquireExecutorId()
        );
        if (executorId === undefined) {
          return;
        }
        const identityCreated = await this.lock.withLock(() =>
          this.tryAcquireAdvisoryLock(executorId, {
            shared: false,
            xact: false,
          })
        );
        if (identityCreated === undefined) {
          return;
        }
        if (identityCreated) {
          this.executorId = executorId;
          break;
        }
      }
    }
    const registered = await this.lock.withLock(() => this.registerListeners());
    if (registered === undefined) {
      return;
    }
    await this.patrolLoop();
  }
}

class WorkflowExecutorInstance {}

class WorkflowExecutorEngine {
  private readonly executorId: number;
  private readonly pool: Pool;
  private readonly schemaName: string;
  private readonly signal: AbortSignal;
  private readonly workflowDefinitions: Map<string, WorkflowDefinition<any, any, any, any, any, any, any, any, any, any>>;

  constructor({
    executorId,
    pool,
    schemaName,
    signal,
    workflowDefinitions,
  }: {
    executorId: number;
    pool: Pool;
    schemaName: string;
    signal: AbortSignal;
    workflowDefinitions: Map<string, WorkflowDefinition<any, any, any, any, any, any, any, any, any, any>>;
  }) {
    this.executorId = executorId;
    this.pool = pool;
    this.schemaName = schemaName;
    this.signal = signal;
    this.workflowDefinitions = workflowDefinitions;
  }

  async run() {
    
  }
}

class Engine {
  private readonly pool: Pool;
  private readonly managerConnectionFactory: () => Promise<Client>;
  private readonly schemaName: string;
  private readonly advisoryLockNamespace: number;
  private readonly workerBroadcastChannel: string;

  constructor({
    pool,
    managerConnectionFactory,
    schemaName,
    advisoryLockNamespace,
  }: {
    pool: Pool;
    managerConnectionFactory: () => Promise<Client>;
    schemaName?: string;
    advisoryLockNamespace?: number;
  }) {
    this.pool = pool;
    this.managerConnectionFactory = managerConnectionFactory;
    this.schemaName = schemaName ?? "workflows";
    this.advisoryLockNamespace = advisoryLockNamespace ?? 1;
    this.workerBroadcastChannel = `${this.schemaName}_worker_broadcast`;
  }
}
