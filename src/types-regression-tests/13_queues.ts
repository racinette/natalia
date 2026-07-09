import { z } from "zod";
import { createTestWorkflowClient } from "./test-client";
import { eq } from "../search";
import {
  defineQueue,
  defineWorkflow,
  QueueHandlerDeclaredError,
} from "../workflow";
import type {
  BaseError,
  DeadLetterHandleExternal,
  DeadLetterNamespaceExternal,
  DeclaredQueueHandlerAttempt,
  FindResult,
  HandleWithRow,
  HandlerAttemptsReadNamespace,
  QueueEnqueueOptions,
  AttemptHandle,
  QueueHandlerAttempt,
  QueueHandlerAttemptDetails,
  QueueHandlerContext,
  QueueHandlerRegistrationOptions,
  QueueHandlerRetryPolicy,
  QueueNamespaceExternal,
  QueueRetentionContext,
  QueueRetentionPolicy,
  QueueTerminalStatus,
  UnhandledQueueHandlerAttempt,
  Unsubscribe,
} from "../types";
import type { DeadLetterId, DeadLetterReason, DeadLetterRow } from "../types/schema";
import type { HasDefaultTtl, HasQueueErrors, InferQueueErrors } from "../types/helpers";
import type { Assert, IsEqual } from "./type-assertions";
import { session } from "./test-session";

const ProviderRejectedDetails = z.object({
  code: z.string(),
  orderId: z.string(),
});

const EmailMessage = z.object({
  userId: z.string(),
  template: z.enum(["welcome", "receipt"]),
  metadata: z.object({ tenantId: z.string() }),
});

const emailQueue = defineQueue({
  name: "emailQueue",
  message: EmailMessage,
  errors: {
    InvalidTemplate: true,
    ProviderRejected: ProviderRejectedDetails,
  },
  defaultTtl: 86400,
  defaultDelay: 0,
});

type _QueueNameLiteral = Assert<IsEqual<typeof emailQueue.name, "emailQueue">>;

type _EmailQueueErrors = {
  InvalidTemplate: true;
  ProviderRejected: typeof ProviderRejectedDetails;
};

type _EmailQueueErrorsInferred = Assert<
  IsEqual<InferQueueErrors<typeof emailQueue>, _EmailQueueErrors>
>;

const enqueueOpts: QueueEnqueueOptions = {
  priority: 10,
  delay: 30,
  ttl: 3600,
};
const delayByDate: QueueEnqueueOptions = {
  delay: new Date("2027-01-01T00:00:00.000Z"),
};
const neverExpires: QueueEnqueueOptions = { ttl: null };

const retryForever: QueueHandlerRetryPolicy = {
  maxAttempts: null,
  timeoutSeconds: 30,
};

const queueWithoutDefaultTtl = defineQueue({
  name: "noDefaultTtlQueue",
  message: EmailMessage,
});

type _EmailQueueHasDefaultTtl = Assert<IsEqual<HasDefaultTtl<typeof emailQueue>, true>>;
type _NoDefaultTtlQueue = Assert<IsEqual<HasDefaultTtl<typeof queueWithoutDefaultTtl>, false>>;
type _EmailQueueHasErrors = Assert<IsEqual<HasQueueErrors<typeof emailQueue>, true>>;
type _NoErrorsQueue = Assert<IsEqual<HasQueueErrors<typeof queueWithoutDefaultTtl>, false>>;

export const queuesAcceptanceWorkflow = defineWorkflow({
  name: "queuesAcceptance",
  args: z.undefined(),
  metadata: z.undefined(),
  queues: { email: emailQueue },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    ctx.queues.email.enqueue({
      userId: "u-1",
      template: "welcome",
      metadata: { tenantId: "t-1" },
    });

    ctx.queues.email.enqueue(
      {
        userId: "u-2",
        template: "receipt",
        metadata: { tenantId: "t-1" },
      },
      { priority: 10, delay: 30, ttl: 3600 },
    );

    const _enqueueVoid = ctx.queues.email.enqueue({
      userId: "u-3",
      template: "welcome",
      metadata: { tenantId: "t-1" },
    });
    type _EnqueueReturnsVoid = Assert<IsEqual<typeof _enqueueVoid, void>>;

    // @ts-expect-error payload must match queue message schema input
    ctx.queues.email.enqueue({ userId: "u-4", template: "unknown" });

    ctx.queues.email.enqueue(
      {
        userId: "u-5",
        template: "welcome",
        metadata: { tenantId: "t-1" },
      },
      // @ts-expect-error workflow enqueue does not accept session
      { session },
    );

    return { ok: true };
  },
});

export const queuesRequireTtlWorkflow = defineWorkflow({
  name: "queuesRequireTtl",
  args: z.undefined(),
  metadata: z.undefined(),
  queues: { email: queueWithoutDefaultTtl },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    // @ts-expect-error enqueue must pass ttl when the definition has no defaultTtl
    ctx.queues.email.enqueue({
      userId: "u-1",
      template: "welcome",
      metadata: { tenantId: "t-1" },
    });

    ctx.queues.email.enqueue(
      {
        userId: "u-2",
        template: "welcome",
        metadata: { tenantId: "t-1" },
      },
      { ttl: 3600 },
    );

    return { ok: true };
  },
});

const client = createTestWorkflowClient({ queuesAcceptance: queuesAcceptanceWorkflow });

type _QueueNamespace = Assert<
  IsEqual<
    typeof client.queues.emailQueue,
    QueueNamespaceExternal<"emailQueue", z.infer<typeof EmailMessage>, _EmailQueueErrors>
  >
>;

// Workflow-local queue aliases do not become client namespaces.
// @ts-expect-error workflow-local queue slot names are not client keys
void client.queues.email;

const unregister = client.queues.emailQueue.registerHandler(
  async (ctx) => {
    type _Ctx = Assert<
      typeof ctx extends QueueHandlerContext<_EmailQueueErrors, {
        userId: string;
        template: "welcome" | "receipt";
        metadata: { tenantId: string };
      }> ? true : false
    >;
    type _MessageDecoded = Assert<
      IsEqual<
        typeof ctx.message,
        {
          userId: string;
          template: "welcome" | "receipt";
          metadata: { tenantId: string };
        }
      >
    >;

    if (ctx.message.template === "receipt") {
      throw ctx.errors.InvalidTemplate("Receipts are not supported", {
        deadLetter: true,
      });
    }

    throw ctx.errors.ProviderRejected(
      "SMTP timed out",
      { code: "SMTP_TIMEOUT", orderId: "o-1" },
      { deadLetter: false },
    );
  },
  {
    retryPolicy: {
      timeoutSeconds: 10,
      maxAttempts: 5,
      intervalSeconds: 1,
      backoffRate: 2,
      maxIntervalSeconds: 30,
    },
    maxConcurrent: 5,
  },
);

// =============================================================================
// `ctx.errors` — QUEUE HANDLER ERROR FACTORIES
// =============================================================================

type _ProviderRejectedDetails = {
  code: string;
  orderId: string;
};

type _DetailsShape = Assert<
  IsEqual<
    QueueHandlerAttemptDetails<_ProviderRejectedDetails>,
    | {
        readonly ok: true;
        readonly status: "serialized";
        readonly result: _ProviderRejectedDetails;
      }
    | {
        readonly ok: false;
        readonly status: "serialization_error";
        readonly error: BaseError;
      }
    | { readonly ok: false; readonly status: "unspecified" }
  >
>;

type _DeclaredTrueAttempt = Assert<
  IsEqual<
    DeclaredQueueHandlerAttempt<_EmailQueueErrors, "InvalidTemplate">,
    {
      readonly attemptNumber: number;
      readonly deadLetter: boolean;
      readonly code: "InvalidTemplate";
      readonly message: string;
      readonly details: undefined;
    }
  >
>;

type _DeclaredSchemaAttempt = Assert<
  IsEqual<
    DeclaredQueueHandlerAttempt<_EmailQueueErrors, "ProviderRejected">,
    {
      readonly attemptNumber: number;
      readonly deadLetter: boolean;
      readonly code: "ProviderRejected";
      readonly message: string;
      readonly details: QueueHandlerAttemptDetails<_ProviderRejectedDetails>;
    }
  >
>;

type _UnhandledAttempt = Assert<
  IsEqual<
    UnhandledQueueHandlerAttempt,
    {
      readonly attemptNumber: number;
      readonly deadLetter: boolean;
      readonly code: null;
      readonly message: string | null;
      readonly type: string | null;
      readonly details: { readonly status: "unspecified" };
    }
  >
>;

const _constructedTrueError = new QueueHandlerDeclaredError(
  "InvalidTemplate",
  "constructed for regression",
  undefined,
  true,
);
type _TrueErrorShape = Assert<
  typeof _constructedTrueError extends QueueHandlerDeclaredError<
    "InvalidTemplate",
    undefined
  >
    ? true
    : false
>;
type _TrueErrorIsError = Assert<typeof _constructedTrueError extends Error ? true : false>;
void _constructedTrueError;

const _constructedSchemaError = new QueueHandlerDeclaredError(
  "ProviderRejected",
  "constructed for regression",
  { code: "CONSTRUCTED", orderId: "o-0" },
  false,
);
type _SchemaErrorShape = Assert<
  typeof _constructedSchemaError extends QueueHandlerDeclaredError<
    "ProviderRejected",
    _ProviderRejectedDetails
  >
    ? true
    : false
>;
void _constructedSchemaError;

client.queues.emailQueue.registerHandler(
  async (ctx) => {
    type _Ctx = Assert<
      typeof ctx extends QueueHandlerContext<_EmailQueueErrors, {
        userId: string;
        template: "welcome" | "receipt";
        metadata: { tenantId: string };
      }> ? true : false
    >;

    const deadLetterErr = ctx.errors.InvalidTemplate("Receipts are not supported", {
      deadLetter: true,
    });
    type _DeadLetterErr = Assert<
      IsEqual<
        typeof deadLetterErr,
        QueueHandlerDeclaredError<"InvalidTemplate", undefined>
      >
    >;
    void deadLetterErr.deadLetter;
    void deadLetterErr.code;

    const retryErr = ctx.errors.ProviderRejected(
      "SMTP timed out",
      { code: "SMTP_TIMEOUT", orderId: "o-1" },
      { deadLetter: false },
    );
    type _RetryErr = Assert<
      typeof retryErr extends QueueHandlerDeclaredError<
        "ProviderRejected",
        _ProviderRejectedDetails
      >
        ? true
        : false
    >;
    void retryErr;

    // @ts-expect-error deadLetter is required
    ctx.errors.InvalidTemplate("missing disposition");

    // @ts-expect-error true-valued error factories accept two arguments
    ctx.errors.InvalidTemplate("bad", { deadLetter: true }, { extra: true });

    ctx.errors.ProviderRejected(
      "bad details",
      // @ts-expect-error details must match the declared schema input
      { code: 1, orderId: "o-1" },
      { deadLetter: false },
    );

    // @ts-expect-error details must include all schema fields
    ctx.errors.ProviderRejected("incomplete", { code: "X" }, { deadLetter: false });

    // @ts-expect-error unknown error code
    ctx.errors.UnknownCode("nope", { deadLetter: true });
  },
  { retryPolicy: { maxAttempts: 1 } },
);

const noErrorsQueue = defineQueue({
  name: "noErrorsQueue",
  message: EmailMessage,
  defaultTtl: 3600,
});

const noErrorsWorkflow = defineWorkflow({
  name: "noErrorsQueueWorkflow",
  args: z.undefined(),
  metadata: z.undefined(),
  queues: { notifications: noErrorsQueue },
  result: z.void(),
  async execute() {},
});

const noErrorsClient = createTestWorkflowClient({
  noErrorsQueueWorkflow: noErrorsWorkflow,
});

type _NoErrorsQueueHasErrors = Assert<IsEqual<HasQueueErrors<typeof noErrorsQueue>, false>>;
type _NoErrorsQueueErrorsInferred = Assert<
  IsEqual<InferQueueErrors<typeof noErrorsQueue>, Record<string, never>>
>;

noErrorsClient.queues.noErrorsQueue.registerHandler(
  async (_ctx) => {
    type _NoErrorsCtx = Assert<
      typeof _ctx extends QueueHandlerContext<Record<string, never>, {
        userId: string;
        template: "welcome" | "receipt";
        metadata: { tenantId: string };
      }> ? true : false
    >;
    type _AssertNoErrorsCtx = Assert<_NoErrorsCtx>;
  },
  { retryPolicy: { maxAttempts: 1 } },
);

// =============================================================================
// `retentionPolicy` — ROW RETENTION AT FINALIZE
// =============================================================================

type _DecodedEmailMessage = {
  userId: string;
  template: "welcome" | "receipt";
  metadata: { tenantId: string };
};

type _RetentionContext = Assert<
  IsEqual<
    QueueRetentionContext<_EmailQueueErrors, _DecodedEmailMessage>,
    {
      readonly status: QueueTerminalStatus;
      readonly reason: DeadLetterReason | null;
      readonly message: _DecodedEmailMessage;
      readonly attempts: HandlerAttemptsReadNamespace<
        QueueHandlerAttempt<_EmailQueueErrors>
      >;
    }
  >
>;

const retentionPolicy: QueueRetentionPolicy<
  _EmailQueueErrors,
  _DecodedEmailMessage
> = async (ctx) => {
  type _Ctx = Assert<
    IsEqual<typeof ctx, QueueRetentionContext<_EmailQueueErrors, _DecodedEmailMessage>>
  >;

  if (ctx.status === "processed") {
    return 86400;
  }
  if (ctx.reason === "invalid_payload") {
    return 3600;
  }
  const count = await ctx.attempts.count();
  if (count > 5) {
    return 86400 * 90;
  }
  const latest = await ctx.attempts.find({
    sort: [{ path: "attemptNumber", direction: "desc" }],
    limit: 1,
  });
  const last = latest[0];
  if (last?.code === "ProviderRejected") {
    return 86400 * 30;
  }
  return null;
};

type _RetentionPolicyReturn = Assert<
  Awaited<ReturnType<typeof retentionPolicy>> extends number | null ? true : false
>;

const _registrationWithRetention: QueueHandlerRegistrationOptions<
  _EmailQueueErrors,
  _DecodedEmailMessage
> = {
  retryPolicy: { maxAttempts: 1 },
  retentionPolicy,
};
void _registrationWithRetention;

client.queues.emailQueue.registerHandler(async (_ctx) => undefined, {
  retryPolicy: { maxAttempts: 1 },
  retentionPolicy: async (ctx) => {
    type _CtxShape = Assert<
      typeof ctx extends QueueRetentionContext<_EmailQueueErrors, _DecodedEmailMessage>
        ? true
        : false
    >;
    type _AttemptsNamespace = Assert<
      typeof ctx.attempts extends HandlerAttemptsReadNamespace<
        QueueHandlerAttempt<_EmailQueueErrors>
      >
        ? true
        : false
    >;
    await ctx.attempts.find();
    return 3600;
  },
});

client.queues.emailQueue.registerHandler(async (_ctx) => undefined, {
  retryPolicy: { maxAttempts: 1 },
  // @ts-expect-error retentionPolicy must return number | null
  retentionPolicy: async () => "forever",
});

type _QueueHandlerDeclaredError = Assert<
  typeof unregister extends Unsubscribe
    ? QueueHandlerDeclaredError extends Error
      ? true
      : false
    : false
>;

// @ts-expect-error retryPolicy is required on queue handler registration
client.queues.emailQueue.registerHandler(async (_ctx) => undefined);

client.queues.emailQueue.registerHandler(
  async (_ctx) => undefined,
  // @ts-expect-error maxAttempts is required inside retryPolicy
  { retryPolicy: { timeoutSeconds: 10 } },
);

client.queues.emailQueue.registerHandler(async (_ctx) => undefined, {
  retryPolicy: retryForever,
});

// @ts-expect-error queue handlers return void
client.queues.emailQueue.registerHandler(async (_ctx) => ({ manual: true }), {
  retryPolicy: { maxAttempts: 1 },
});

client.queues.emailQueue.registerHandler(
  async (_ctx) => undefined,
  // @ts-expect-error handler registration does not accept session
  { retryPolicy: { maxAttempts: 1 }, session },
);

type _DeadLetterReasons = Assert<
  IsEqual<
    DeadLetterReason,
    "max_attempts" | "ttl_expired" | "invalid_payload" | "handler_reject"
  >
>;

type _QueueHandlerAttemptUnion = Assert<
  IsEqual<
    QueueHandlerAttempt<_EmailQueueErrors>,
    | DeclaredQueueHandlerAttempt<_EmailQueueErrors, "InvalidTemplate">
    | DeclaredQueueHandlerAttempt<_EmailQueueErrors, "ProviderRejected">
    | UnhandledQueueHandlerAttempt
  >
>;

async function inspectDeadLetters(): Promise<void> {
  const deadLetterMany = client.queues.emailQueue.deadLetters.find(
    session,
    ({ reason }) => eq(reason, "handler_reject"),
    {
      fields: { id: true, payload: true },
      limit: 1,
    },
  );

  type _DeadLetterMany = Assert<
    IsEqual<
      typeof deadLetterMany,
      FindResult<
        HandleWithRow<
          DeadLetterHandleExternal<
            "emailQueue",
            {
              userId: string;
              template: "welcome" | "receipt";
              metadata: { tenantId: string };
            },
            _EmailQueueErrors
          >,
          Pick<
            DeadLetterRow<
              "emailQueue",
              {
                userId: string;
                template: "welcome" | "receipt";
                metadata: { tenantId: string };
              }
            >,
            "id" | "payload"
          >
        >
      >
    >
  >;

  const deadLetters = await deadLetterMany;
  const deadLetter = deadLetters[0];
  if (!deadLetter) {
    return;
  }

  const attemptRows = await deadLetter.attempts.find(session, {
    sort: [{ path: "attemptNumber", direction: "desc" }],
    limit: 1,
    fields: { code: true, message: true, details: true },
  });
  type _AttemptHandles = Assert<
    IsEqual<
      (typeof attemptRows)[number],
      HandleWithRow<
        AttemptHandle<QueueHandlerAttempt<_EmailQueueErrors>>,
        Pick<
          QueueHandlerAttempt<_EmailQueueErrors>,
          "code" | "message" | "details"
        >
      >
    >
  >;
  void (0 as unknown as _AttemptHandles);
  const lastRow = attemptRows[0]?.row;
  if (lastRow?.code === "ProviderRejected") {
    const details = lastRow.details;
    if (details && "ok" in details && details.ok === true) {
      const _orderId: string = details.result.orderId;
      void _orderId;
    }
  }
  if (lastRow?.code === null) {
    const _nullableMessage: string | null = lastRow.message;
    void _nullableMessage;
  }

  await deadLetter.retry(session);
  await deadLetter.purge(session);

   
  const deadLetterId = "dead-letter-id" as DeadLetterId<"emailQueue">;
  const deadLetterHandle = client.queues.emailQueue.deadLetters.get(deadLetterId);
  type _DeadLetterHandle = Assert<
    IsEqual<
      typeof deadLetterHandle,
      DeadLetterHandleExternal<
        "emailQueue",
        {
          userId: string;
          template: "welcome" | "receipt";
          metadata: { tenantId: string };
        },
        _EmailQueueErrors
      >
    >
  >;

  const fetched = await deadLetterHandle.fetchRow(session, {
    fields: { payload: true, reason: true },
  });
  type _Fetched = Assert<
    IsEqual<
      typeof fetched,
      | Pick<
          DeadLetterRow<
            "emailQueue",
            {
              userId: string;
              template: "welcome" | "receipt";
              metadata: { tenantId: string };
            }
          >,
          "payload" | "reason"
        >
      | undefined
    >
  >;
  void fetched;

  const count = await client.queues.emailQueue.deadLetters.count(
    session,
    ({ reason }) => eq(reason, "max_attempts"),
  );
  type _Count = Assert<IsEqual<typeof count, number>>;
  void count;

  const found = await client.queues.emailQueue.deadLetters.find(
    session,
    ({ payload }) => eq(payload.userId, "u-1"),
  );
  type _Found = Assert<
    IsEqual<
      typeof found,
      readonly DeadLetterHandleExternal<
        "emailQueue",
        {
          userId: string;
          template: "welcome" | "receipt";
          metadata: { tenantId: string };
        },
        _EmailQueueErrors
      >[]
    >
  >;
  void found;

  // @ts-expect-error dead-letter ids are branded by queue definition name
  client.queues.emailQueue.deadLetters.get("plain-id");
  // @ts-expect-error get is synchronous and does not accept session
  client.queues.emailQueue.deadLetters.get(deadLetterId, { session });
  client.queues.emailQueue.deadLetters.find(
    session,
    // @ts-expect-error predicates are typed to the dead-letter payload shape
    ({ payload }) => eq(payload.unknownField, "x"),
  );
}

type _DeadLetterNamespace = Assert<
  IsEqual<
    typeof client.queues.emailQueue.deadLetters,
    DeadLetterNamespaceExternal<
      "emailQueue",
      {
        userId: string;
        template: "welcome" | "receipt";
        metadata: { tenantId: string };
      },
      _EmailQueueErrors
    >
  >
>;

void enqueueOpts;
void delayByDate;
void neverExpires;
void noErrorsClient;
void unregister;
void inspectDeadLetters();
