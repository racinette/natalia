import { z } from "zod";
import { whereTrue } from "../search";
import { AttemptError, defineStep } from "../workflow";
import type {
  Attempt,
  AttemptHandle,
  Failure,
  HandlerAttemptsReadNamespace,
  JsonInput,
  OperatorAttemptsNamespaceExternal,
  StepExecuteContext,
} from "../types";
import type { Assert, IsEqual } from "./type-assertions";
import { session } from "./test-session";

// =============================================================================
// `Failure` BASE RECORD
// =============================================================================

const failure: Failure = {
  startedAt: new Date(),
  failedAt: new Date(),
  message: null,
  type: null,
  details: undefined,
};
void failure;

type _FailureDoesNotRequireAttempt = Assert<
  "attemptNumber" extends keyof Failure ? false : true
>;

// =============================================================================
// `Attempt` RECORD
// =============================================================================

const attempt: Attempt = {
  ...failure,
  attemptNumber: 1,
};
void attempt;

type _AttemptExtendsFailure = Assert<Attempt extends Failure ? true : false>;
type _AttemptShape = Assert<
  IsEqual<
    Pick<Attempt, "attemptNumber" | "message" | "type" | "details">,
    {
      readonly attemptNumber: number;
      readonly message: string | null;
      readonly type: string | null;
      readonly details: JsonInput | undefined;
    }
  >
>;

// =============================================================================
// HANDLER-RUNTIME ATTEMPT READ NAMESPACE — row materialization.
// =============================================================================

declare const handlerAttempts: HandlerAttemptsReadNamespace<Attempt>;

async function inspectHandlerAttempts(): Promise<void> {
  const _all = await handlerAttempts.find();
  type _All = Assert<IsEqual<typeof _all, readonly Attempt[]>>;

  const _projected = await handlerAttempts.find({
    fields: { type: true },
  });
  type _Projected = Assert<
    IsEqual<typeof _projected, readonly Pick<Attempt, "type">[]>
  >;

  const _count = await handlerAttempts.count();
  type _Count = Assert<IsEqual<typeof _count, number>>;

  const _viaTrue = await handlerAttempts.find(whereTrue);
  type _ViaTrue = Assert<IsEqual<typeof _viaTrue, readonly Attempt[]>>;

  for (const _item of await handlerAttempts.find()) {
    type _Item = Assert<IsEqual<typeof _item, Attempt>>;
  }
}
void inspectHandlerAttempts;

// =============================================================================
// OPERATOR ATTEMPT NAMESPACE — handle materialization.
// =============================================================================

declare const operatorAttempts: OperatorAttemptsNamespaceExternal<Attempt>;

async function inspectOperatorAttempts(): Promise<void> {
  const _handles = await operatorAttempts.find(session, {
    fields: { type: true },
  });
  type _HandleRow = Assert<
    IsEqual<
      (typeof _handles)[number],
      AttemptHandle<Attempt> & { readonly row: Pick<Attempt, "type"> }
    >
  >;

  const _syncHandle = operatorAttempts.get(1);
  type _SyncHandle = Assert<IsEqual<typeof _syncHandle, AttemptHandle<Attempt>>>;
}
void inspectOperatorAttempts;

// =============================================================================
// `AttemptError` THROWABLE
// =============================================================================

const _structured = new AttemptError({
  type: "ValidationError",
  message: "payload was invalid",
  details: { field: "email", reason: "missing" },
});
type _AttemptErrorIsError = Assert<typeof _structured extends Error ? true : false>;

const noDetails = new AttemptError({ type: "RemoteSystemDown" });
void noDetails;

const empty = new AttemptError();
void empty;

// @ts-expect-error details must be JSON-serializable (no Set/Map/etc.)
new AttemptError({ details: new Set(["not-json"]) });

const attemptNamespaceStepArgs = z.object({ id: z.string() });

defineStep({
  name: "attemptNamespaceStep",
  args: attemptNamespaceStepArgs,
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    type _CtxIsStepExecute = Assert<
      typeof ctx extends StepExecuteContext<typeof attemptNamespaceStepArgs>
        ? true
        : false
    >;
    type _ArgsDecoded = Assert<
      IsEqual<(typeof ctx)["args"], { id: string }>
    >;
    void ctx.signal;
    // @ts-expect-error step execute has no errors map
    void ctx.errors;

    if (ctx.args.id === "bad") {
      throw new AttemptError({
        type: "StepFailed",
        message: "synthetic",
        details: { id: ctx.args.id },
      });
    }
    return { ok: true };
  },
});

// =============================================================================
// REMOVED PUBLIC NAME
// =============================================================================

// @ts-expect-error AttemptAccessor was removed in favour of attempt namespaces
import type { AttemptAccessor as _RemovedAttemptAccessor } from "../types";
