// Regression test — operator session model (REFACTOR.MD Part 19).
//
// Covers SessionCapabilities, OperatorSession, StorageDriver, InferSessionRaw,
// client.session / client.adoptSession signatures, and the snapshot vs watch IO split.

import { z } from "zod";
import { createWorkflowClient } from "../client";
import { defineWorkflow } from "../workflow";
import type {
  InferSessionRaw,
  OperatorSession,
  SessionCapabilities,
  SessionOrigin,
  StorageDriver,
  WorkflowClient,
} from "../types";
import {
  createMockSessionRaw,
  MockStorageDriver,
} from "./mock-storage-driver";
import { createTestWorkflowClient } from "./test-client";
import type { Assert, IsEqual } from "./type-assertions";
import { session } from "./test-session";

// =============================================================================
// CORE SESSION TYPES
// =============================================================================

type _SessionCapabilities = Assert<
  IsEqual<
    SessionCapabilities,
    { readonly atomic: boolean; readonly isolated: boolean }
  >
>;

type _SessionOrigin = Assert<IsEqual<SessionOrigin, "engine" | "adopted">>;

declare const engineSession: OperatorSession<unknown, "engine">;
declare const adoptedSession: OperatorSession<unknown, "adopted">;

type _EngineOrigin = Assert<IsEqual<typeof engineSession.origin, "engine">>;
type _AdoptedOrigin = Assert<IsEqual<typeof adoptedSession.origin, "adopted">>;

type _SessionHasCapabilities = Assert<
  IsEqual<
    typeof engineSession.capabilities,
    SessionCapabilities
  >
>;

type _SessionRawIsSync = Assert<IsEqual<typeof engineSession.raw, unknown>>;

// =============================================================================
// STORAGE DRIVER + INFER SESSION RAW
// =============================================================================

type _MockDriverImplementsStorageDriver = Assert<
  MockStorageDriver extends StorageDriver<infer R>
    ? IsEqual<R, import("./mock-storage-driver").MockSessionRaw>
    : false
>;

type _InferSessionRawFromMock = Assert<
  IsEqual<InferSessionRaw<MockStorageDriver>, import("./mock-storage-driver").MockSessionRaw>
>;

const driver = new MockStorageDriver();

async function driverSessionLifecycle(): Promise<void> {
  const fromSession = await driver.session(async (session) => {
    type _CallbackOrigin = Assert<
      IsEqual<typeof session.origin, "engine">
    >;
    type _CallbackRaw = Assert<
      IsEqual<
        typeof session.raw,
        import("./mock-storage-driver").MockSessionRaw
      >
    >;
    return session.raw;
  });

  type _SessionReturnsFnResult = Assert<
    IsEqual<
      typeof fromSession,
      import("./mock-storage-driver").MockSessionRaw
    >
  >;

  const raw = createMockSessionRaw();
  const adopted = driver.adoptSession(raw);

  type _AdoptedOrigin = Assert<IsEqual<typeof adopted.origin, "adopted">>;
  type _AdoptedPreservesRaw = Assert<IsEqual<typeof adopted.raw, typeof raw>>;
}

// =============================================================================
// WORKFLOW CLIENT — session entry point signatures and driver typing
// =============================================================================

const sessionWorkflow = defineWorkflow({
  name: "operatorSessionsRegressionWorkflow",
  streams: { log: z.object({ line: z.string() }) },
  events: { ready: true },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    ctx.events.ready.set();
    ctx.streams.log.write({ line: "done" });
    return { ok: true };
  },
});

const client = createTestWorkflowClient({
  operatorSessionsRegressionWorkflow: sessionWorkflow,
});

type _ClientDriverField = Assert<
  IsEqual<typeof client.driver, MockStorageDriver>
>;

declare const typedClient: WorkflowClient<
  { operatorSessionsRegressionWorkflow: typeof sessionWorkflow },
  MockStorageDriver
>;

type _TypedClientDriver = Assert<
  IsEqual<typeof typedClient.driver, MockStorageDriver>
>;

async function clientSessionEntry(): Promise<void> {
  await client.session(async (session) => {
    type _EngineSessionOrigin = Assert<
      IsEqual<typeof session.origin, "engine">
    >;
    type _ClientSessionRaw = Assert<
      IsEqual<
        typeof session.raw,
        InferSessionRaw<MockStorageDriver>
      >
    >;

    const handle = await client.workflows.operatorSessionsRegressionWorkflow.start(
      session,
      { idempotencyKey: "sessions-regression-1" },
    );

    await handle.fetchRow(session, { fields: { status: true } });
    await client.workflows.operatorSessionsRegressionWorkflow.find(session, {
      limit: 1,
    });

    // @ts-expect-error snapshot IO requires session as the first argument
    await handle.fetchRow({ fields: { status: true } });

    // @ts-expect-error snapshot IO requires session as the first argument
    await client.workflows.operatorSessionsRegressionWorkflow.find({ limit: 1 });
  });

  const raw = createMockSessionRaw();
  const adopted = client.adoptSession(raw);

  type _AdoptedClientSession = Assert<
    IsEqual<typeof adopted.origin, "adopted">
  >;
  type _AdoptedClientRaw = Assert<IsEqual<typeof adopted.raw, typeof raw>>;

  void adopted;
}

async function watchIoWithoutSession(): Promise<void> {
  const handle = client.workflows.operatorSessionsRegressionWorkflow.get(
    "sessions-regression-1",
  );

  await handle.events.ready.wait({ signal: AbortSignal.timeout(1_000) });
  await handle.streams.log.read(0, { signal: AbortSignal.timeout(1_000) });
  await handle.wait({ signal: AbortSignal.timeout(1_000) });

  await client.session(async (session) => {
    // @ts-expect-error watch IO does not accept session
    await handle.events.ready.wait(session, { signal: AbortSignal.timeout(1) });

    // @ts-expect-error watch IO does not accept session
    await handle.streams.log.read(session, 0, { signal: AbortSignal.timeout(1) });

    // @ts-expect-error watch IO does not accept session
    await handle.wait(session, { signal: AbortSignal.timeout(1) });
  });
}

// createWorkflowClient requires an explicit driver at construction time.
// @ts-expect-error driver is required
createWorkflowClient({} as Record<string, never>);

void driverSessionLifecycle;
void clientSessionEntry;
void watchIoWithoutSession;
void session;
