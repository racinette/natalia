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
import type { MockSessionRaw } from "./mock-storage-driver";
import { createTestWorkflowClient } from "./test-client";
import type { Assert, IsEqual } from "./type-assertions";
import { session } from "./test-session";
import { explicitKeyIdentity } from "./test-identity";

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

declare const _engineSession: OperatorSession<unknown, "engine">;
declare const _adoptedSession: OperatorSession<unknown, "adopted">;

type _EngineOrigin = Assert<IsEqual<typeof _engineSession.origin, "engine">>;
type _AdoptedOrigin = Assert<IsEqual<typeof _adoptedSession.origin, "adopted">>;

type _SessionHasCapabilities = Assert<
  IsEqual<
    typeof _engineSession.capabilities,
    SessionCapabilities
  >
>;

type _SessionRawIsSync = Assert<IsEqual<typeof _engineSession.raw, unknown>>;

// =============================================================================
// STORAGE DRIVER + INFER SESSION RAW
// =============================================================================

type _MockDriverImplementsStorageDriver = Assert<
  MockStorageDriver extends StorageDriver<infer R>
    ? IsEqual<R, MockSessionRaw>
    : false
>;

type _InferSessionRawFromMock = Assert<
  IsEqual<InferSessionRaw<MockStorageDriver>, MockSessionRaw>
>;

const driver = new MockStorageDriver();

async function driverSessionLifecycle(): Promise<void> {
  const _fromSession = await driver.session(async (session) => {
    type _CallbackOrigin = Assert<
      IsEqual<typeof session.origin, "engine">
    >;
    type _CallbackRaw = Assert<
      IsEqual<typeof session.raw, MockSessionRaw>
    >;
    return session.raw;
  });

  type _SessionReturnsFnResult = Assert<
    IsEqual<typeof _fromSession, MockSessionRaw>
  >;

  const raw = createMockSessionRaw();
  const _adopted = driver.adoptSession(raw);

  type _AdoptedOrigin = Assert<IsEqual<typeof _adopted.origin, "adopted">>;
  type _AdoptedPreservesRaw = Assert<IsEqual<typeof _adopted.raw, typeof raw>>;
}

// =============================================================================
// WORKFLOW CLIENT — session entry point signatures and driver typing
// =============================================================================

const sessionWorkflow = defineWorkflow({
  name: "operatorSessionsRegressionWorkflow",
  args: z.undefined(),
  metadata: z.undefined(),
  identity: explicitKeyIdentity,
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

declare const _typedClient: WorkflowClient<
  { operatorSessionsRegressionWorkflow: typeof sessionWorkflow },
  MockStorageDriver
>;

type _TypedClientDriver = Assert<
  IsEqual<typeof _typedClient.driver, MockStorageDriver>
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
      { args: undefined, metadata: undefined, identity: { key: "sessions-regression-1" } },
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
  const _adopted = client.adoptSession(raw);

  type _AdoptedClientSession = Assert<
    IsEqual<typeof _adopted.origin, "adopted">
  >;
  type _AdoptedClientRaw = Assert<IsEqual<typeof _adopted.raw, typeof raw>>;

  void _adopted;
}

async function watchIoWithoutSession(): Promise<void> {
  const handle = client.workflows.operatorSessionsRegressionWorkflow.get({
    key: "sessions-regression-1",
  });

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
