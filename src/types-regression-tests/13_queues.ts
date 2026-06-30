import { z } from "zod";
import { createWorkflowClient } from "../client";
import { eq } from "../search";
import { defineQueue, defineWorkflow, MANUAL, QueueHandlerError } from "../workflow";
import type {
  BaseError,
  DeadLetterHandleExternal,
  DeadLetterNamespaceExternal,
  FindManyResult,
  FindUniqueResult,
  HandleWithRow,
  QueueEnqueueOptions,
  QueueHandlerAttempt,
  QueueHandlerAttemptAccessor,
  QueueHandlerContext,
  QueueHandlerErrorOptions,
  QueueHandlerRetryPolicy,
  QueueNamespaceExternal,
  Typed,
  Unsubscribe,
} from "../types";
import type { DeadLetterId, DeadLetterReason, DeadLetterRow } from "../types/schema";
import type { JsonInput } from "../types/json-input";
import type { HasDefaultTtl, HasQueueErrorSchema, InferQueueTypedError } from "../types/helpers";
import type { Assert, IsEqual } from "./type-assertions";

const QueueError = z.object({
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
  error: QueueError,
  defaultTtl: 86400,
  defaultDelay: 0,
});

type _QueueNameLiteral = Assert<IsEqual<typeof emailQueue.name, "emailQueue">>;

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

type _QueueTypedError = {
  code: string;
  orderId: string;
};

type _EmailQueueHasDefaultTtl = Assert<IsEqual<HasDefaultTtl<typeof emailQueue>, true>>;
type _NoDefaultTtlQueue = Assert<IsEqual<HasDefaultTtl<typeof queueWithoutDefaultTtl>, false>>;
type _EmailQueueHasErrorSchema = Assert<IsEqual<HasQueueErrorSchema<typeof emailQueue>, true>>;
type _EmailQueueTypedError = Assert<
  IsEqual<InferQueueTypedError<typeof emailQueue>, _QueueTypedError>
>;
type _NoErrorSchemaQueueHasErrorSchema = Assert<
  IsEqual<HasQueueErrorSchema<typeof queueWithoutDefaultTtl>, false>
>;

export const queuesAcceptanceWorkflow = defineWorkflow({
  name: "queuesAcceptance",
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
      // @ts-expect-error workflow enqueue does not accept txOrConn
      { txOrConn: undefined },
    );

    return { ok: true };
  },
});

export const queuesRequireTtlWorkflow = defineWorkflow({
  name: "queuesRequireTtl",
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

const client = createWorkflowClient({ queuesAcceptance: queuesAcceptanceWorkflow });

type _QueueNamespace = Assert<
  IsEqual<
    typeof client.queues.emailQueue,
    QueueNamespaceExternal<"emailQueue", z.infer<typeof EmailMessage>, _QueueTypedError>
  >
>;

// Workflow-local queue aliases do not become client namespaces.
// @ts-expect-error workflow-local queue slot names are not client keys
void client.queues.email;

const unregister = client.queues.emailQueue.registerHandler(
  async (message, handlerOpts) => {
    type _HandlerOpts = Assert<
      typeof handlerOpts extends QueueHandlerContext<_QueueTypedError> ? true : false
    >;
    type _MessageDecoded = Assert<
      IsEqual<
        typeof message,
        {
          userId: string;
          template: "welcome" | "receipt";
          metadata: { tenantId: string };
        }
      >
    >;

    if (message.template === "receipt") {
      throw handlerOpts.error({
        deadLetter: true,
        type: "InvalidTemplate",
        message: "Receipts are not supported",
      });
    }

    throw handlerOpts.error({
      typed: { code: "SMTP_TIMEOUT", orderId: "o-1" },
      deadLetter: false,
      type: "SmtpError",
      message: "SMTP timed out",
    });
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
// `ctx.error` — QUEUE HANDLER ERROR FACTORY
//
// Queue handlers report intentional outcomes via `throw ctx.error({...})`.
// `deadLetter` is required. When the queue declares an `error` schema, `typed`
// is optional and validated against it. Without an `error` schema, `typed` is
// absent from `ctx.error` options entirely. Unhandled throws remain separate.
// =============================================================================

type _WithSchemaHasTypedKey = Assert<
  'typed' extends keyof QueueHandlerErrorOptions<_QueueTypedError> ? true : false
>;

type _WithoutSchemaOmitsTypedKey = Assert<
  'typed' extends keyof QueueHandlerErrorOptions<never> ? false : true
>;

type _TypedNeverIsUnspecifiedOnly = Assert<
  IsEqual<Typed<never>, { readonly ok: false; readonly status: "unspecified" }>
>;

const _constructedQueueError = new QueueHandlerError<_QueueTypedError>({
  deadLetter: true,
  typed: { code: "CONSTRUCTED", orderId: "o-0" },
  type: "HandlerReject",
  message: "constructed for regression",
  details: { source: "test" },
});
type _QueueHandlerErrorIsError = Assert<
  typeof _constructedQueueError extends Error ? true : false
>;
type _QueueHandlerErrorFields = Assert<
  IsEqual<
    Pick<
      typeof _constructedQueueError,
      "typed" | "deadLetter" | "errorType" | "details" | "message"
    >,
    {
      readonly typed: _QueueTypedError | undefined;
      readonly deadLetter: boolean;
      readonly errorType: string | null;
      readonly details: JsonInput | undefined;
      message: string;
    }
  >
>;
void _constructedQueueError;

// @ts-expect-error details must be JSON-serializable
new QueueHandlerError({ deadLetter: false, details: new Set(["not-json"]) });

// @ts-expect-error queues without an error schema cannot pass typed
new QueueHandlerError<never>({ deadLetter: false, typed: { x: 1 } });

const _constructedNoSchemaError = new QueueHandlerError<never>({
  deadLetter: true,
  message: "no schema",
});
type _NoSchemaErrorTypedField = Assert<
  IsEqual<typeof _constructedNoSchemaError.typed, undefined>
>;
void _constructedNoSchemaError;

client.queues.emailQueue.registerHandler(
  async (_message, ctx) => {
    type _Ctx = Assert<
      typeof ctx extends QueueHandlerContext<_QueueTypedError> ? true : false
    >;

    const deadLetterErr = ctx.error({
      deadLetter: true,
      type: "InvalidTemplate",
      message: "Receipts are not supported",
    });
    type _DeadLetterErr = Assert<
      IsEqual<typeof deadLetterErr, QueueHandlerError<_QueueTypedError>>
    >;
    type _DeadLetterErrIsError = Assert<typeof deadLetterErr extends Error ? true : false>;
    void deadLetterErr.deadLetter;
    void deadLetterErr.errorType;

    const retryErr = ctx.error({
      typed: { code: "SMTP_TIMEOUT", orderId: "o-1" },
      deadLetter: false,
      type: "SmtpError",
      message: "SMTP timed out",
      details: { host: "smtp.example" },
    });
    type _RetryTyped = Assert<
      typeof retryErr.typed extends _QueueTypedError | undefined ? true : false
    >;
    void retryErr;

    const minimalRetry = ctx.error({ deadLetter: false });
    type _MinimalRetry = Assert<
      typeof minimalRetry extends QueueHandlerError<_QueueTypedError> ? true : false
    >;
    void minimalRetry;

    // @ts-expect-error deadLetter is required
    ctx.error({ typed: { code: "X", orderId: "o-1" } });

    // @ts-expect-error typed must match the queue error schema
    ctx.error({ deadLetter: false, typed: { code: 1, orderId: "o-1" } });

    // @ts-expect-error typed must include all schema fields
    ctx.error({ deadLetter: false, typed: { code: "X" } });

    // @ts-expect-error details must be JSON-serializable
    ctx.error({ deadLetter: true, details: new Map([["k", "v"]]) });
  },
  { retryPolicy: { maxAttempts: 1 } },
);

const untypedErrorQueue = defineQueue({
  name: "untypedErrorQueue",
  message: EmailMessage,
  defaultTtl: 3600,
});

const untypedErrorWorkflow = defineWorkflow({
  name: "untypedErrorQueueWorkflow",
  queues: { notifications: untypedErrorQueue },
  result: z.void(),
  async execute() {},
});

const untypedErrorClient = createWorkflowClient({
  untypedErrorQueueWorkflow: untypedErrorWorkflow,
});

type _NoSchemaQueueHasErrorSchema = Assert<
  IsEqual<HasQueueErrorSchema<typeof untypedErrorQueue>, false>
>;
type _NoSchemaQueueTypedError = Assert<
  IsEqual<InferQueueTypedError<typeof untypedErrorQueue>, never>
>;

untypedErrorClient.queues.untypedErrorQueue.registerHandler(
  async (_message, ctx) => {
    type _UntypedCtx = Assert<typeof ctx extends QueueHandlerContext<never> ? true : false>;

    // @ts-expect-error queues without an error schema do not accept typed
    ctx.error({ deadLetter: false, typed: { arbitrary: true, count: 1 } });

    const err = ctx.error({ deadLetter: true, message: "no schema queue" });
    type _ErrNever = Assert<IsEqual<typeof err, QueueHandlerError<never>>>;
    type _ErrNeverTypedField = Assert<IsEqual<typeof err.typed, undefined>>;
    void err;
  },
  { retryPolicy: { maxAttempts: 1 } },
);

type _QueueHandlerError = Assert<
  typeof unregister extends Unsubscribe
    ? QueueHandlerError<_QueueTypedError> extends Error
      ? true
      : false
    : false
>;

// @ts-expect-error retryPolicy is required on queue handler registration
client.queues.emailQueue.registerHandler(async () => undefined);

client.queues.emailQueue.registerHandler(
  async () => undefined,
  // @ts-expect-error maxAttempts is required inside retryPolicy
  { retryPolicy: { timeoutSeconds: 10 } },
);

client.queues.emailQueue.registerHandler(async () => undefined, {
  retryPolicy: retryForever,
});

// @ts-expect-error queue handlers do not use MANUAL
client.queues.emailQueue.registerHandler(async () => MANUAL, {
  retryPolicy: { maxAttempts: 1 },
});

client.queues.emailQueue.registerHandler(
  async () => undefined,
  // @ts-expect-error handler registration does not accept txOrConn
  { retryPolicy: { maxAttempts: 1 }, txOrConn: undefined },
);

type _DeadLetterReasons = Assert<
  IsEqual<
    DeadLetterReason,
    "max_attempts" | "ttl_expired" | "invalid_payload" | "handler_reject"
  >
>;

type _TypedShape = Assert<
  IsEqual<
    Typed<_QueueTypedError>,
    | { readonly ok: true; readonly status: "serialized"; readonly result: _QueueTypedError }
    | {
        readonly ok: false;
        readonly status: "serialization_error";
        readonly error: BaseError;
      }
    | { readonly ok: false; readonly status: "unspecified" }
  >
>;

type _QueueHandlerAttempt = Assert<
  IsEqual<
    QueueHandlerAttempt<_QueueTypedError>,
    BaseError & {
      readonly attempt: number;
      readonly typed: Typed<_QueueTypedError>;
      readonly deadLetter: boolean;
    }
  >
>;

async function inspectDeadLetters(): Promise<void> {
  const deadLetterMany = client.queues.emailQueue.deadLetters.findMany(
    ({ reason }) => eq(reason, "handler_reject"),
    {
      fields: { id: true, payload: true },
      limit: 1,
      txOrConn: undefined,
    },
  );

  type _DeadLetterMany = Assert<
    IsEqual<
      typeof deadLetterMany,
      FindManyResult<
        HandleWithRow<
          DeadLetterHandleExternal<
            "emailQueue",
            {
              userId: string;
              template: "welcome" | "receipt";
              metadata: { tenantId: string };
            },
            _QueueTypedError
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

  const attemptAccessor = await deadLetter.attempts();
  type _AttemptAccessor = Assert<
    IsEqual<typeof attemptAccessor, FindUniqueResult<QueueHandlerAttemptAccessor<_QueueTypedError>>>
  >;
  if (attemptAccessor.status === "unique") {
    const last = await attemptAccessor.value.last();
    if (last.typed.ok) {
      const _code: string = last.typed.result.code;
      void _code;
    }
  }

  await deadLetter.retry({ txOrConn: undefined });
  await deadLetter.purge({ txOrConn: undefined });

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- regression-only cast to branded `DeadLetterId`
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
        _QueueTypedError
      >
    >
  >;

  const fetched = await deadLetterHandle.fetchRow({ payload: true, reason: true });
  type _Fetched = Assert<
    IsEqual<
      typeof fetched,
      FindUniqueResult<
        Pick<
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
      >
    >
  >;
  void fetched;

  const count = await client.queues.emailQueue.deadLetters.count(
    ({ reason }) => eq(reason, "max_attempts"),
    { txOrConn: undefined },
  );
  type _Count = Assert<IsEqual<typeof count, number>>;
  void count;

  const found = await client.queues.emailQueue.deadLetters.findUnique(
    ({ payload }) => eq(payload.userId, "u-1"),
    { txOrConn: undefined },
  );
  type _Found = Assert<
    IsEqual<
      typeof found,
      FindUniqueResult<
        DeadLetterHandleExternal<
          "emailQueue",
          {
            userId: string;
            template: "welcome" | "receipt";
            metadata: { tenantId: string };
          },
          _QueueTypedError
        >
      >
    >
  >;
  void found;

  // @ts-expect-error dead-letter ids are branded by queue definition name
  client.queues.emailQueue.deadLetters.get("plain-id");
  // @ts-expect-error get is synchronous and does not accept txOrConn
  client.queues.emailQueue.deadLetters.get(deadLetterId, { txOrConn: undefined });
  client.queues.emailQueue.deadLetters.findMany(
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
      _QueueTypedError
    >
  >
>;

void enqueueOpts;
void delayByDate;
void neverExpires;
void untypedErrorClient;
void unregister;
void inspectDeadLetters();
