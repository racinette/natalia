import { createWorkflowClient } from "../client";
import {
  AttemptError,
  createWorkflowClient as createWorkflowClientFromIndex,
  defineQueue,
  defineRequest,
  defineStep,
  defineTopic,
  defineWorkflow,
  defineWorkflowHeader,
  MAIN_BRANCH,
  RequestHandlerDeclaredError,
  UnrecoverableError,
} from "../index";
import type {
  Attempt,
  AttemptHandle,
  AttemptWhereTemplate,
  BranchInstanceId,
  BranchInstanceStatus,
  BranchPathItem,
  CompensationBlockInstanceId,
  CompensationBlockStatus,
  CompensationInfo,
  DeadLetteredMessage,
  ErrorValue,
  ExplicitError,
  Failure,
  FailureInfo,
  OperatorSession,
  RequestCompensationInfo,
  RequestCompensationInstanceId,
  RequestCompensationStatus,
  RetentionSetter,
  ScheduledDeliveryOptions,
  SearchQuery,
  SearchQueryNode,
  StepBoundary,
  TopicRecord,
  Unsubscribe,
} from "../index";
import {
  createMockSessionRaw,
  MockStorageDriver,
} from "../src/types-regression-tests/mock-storage-driver";
import type { MockSessionRaw } from "../src/types-regression-tests/mock-storage-driver";
import { createTestWorkflowClient } from "../src/types-regression-tests/test-client";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type _DefinitionHelpers =
  | typeof defineStep
  | typeof defineWorkflow
  | typeof defineWorkflowHeader
  | typeof defineQueue
  | typeof defineRequest
  | typeof defineTopic;

type _AttemptExports =
  | Attempt
  | AttemptHandle<Attempt>
  | AttemptWhereTemplate
  | Failure
  | AttemptError
  | FailureInfo;

type _ErrorExports = ExplicitError<any, any> | ErrorValue<any>;

type _CompensationExports =
  | CompensationInfo<any>
  | CompensationBlockStatus
  | CompensationBlockInstanceId;

type _RequestCompensationExports =
  | RequestCompensationInfo<any>
  | RequestCompensationStatus
  | RequestCompensationInstanceId;

type _PrimitiveExports =
  | SearchQuery<any>
  | SearchQueryNode<any>
  | DeadLetteredMessage<any, any>
  | StepBoundary
  | BranchPathItem
  | TopicRecord<any, any>
  | ScheduledDeliveryOptions
  | RetentionSetter
  | Unsubscribe
  | BranchInstanceId
  | BranchInstanceStatus;

type _MainBranch = Assert<IsEqual<typeof MAIN_BRANCH, "MAIN_BRANCH">>;
type _RequestHandlerDeclaredError = Assert<
  typeof RequestHandlerDeclaredError extends typeof Error ? true : false
>;
type _Unrecoverable = Assert<typeof UnrecoverableError extends typeof Error ? true : false>;

const driver = new MockStorageDriver();
declare const client: import("../index").WorkflowClient<any, MockStorageDriver>;

async function sessionFirstIo(): Promise<void> {
  await client.session(async (session) => {
    const handle = client.workflows.someWorkflow.get("workflow-id");
    void handle;

    await client.workflows.someWorkflow.find(session, { limit: 1 });

    const started = await client.workflows.someWorkflow.start(session, {
      idempotencyKey: "with-session",
      args: undefined,
    });
    void started;
  });

  const raw = createMockSessionRaw();
  const adopted: OperatorSession<MockSessionRaw, "adopted"> =
    client.adoptSession(raw);
  void adopted;

  type _DriverSession = Assert<
    typeof driver.session extends <
      R,
    >(
      fn: (
        session: OperatorSession<MockSessionRaw, "engine">,
      ) => Promise<R>,
    ) => Promise<R>
      ? true
      : false
  >;
  void (0 as unknown as _DriverSession);
}

// Removed public exports.
// @ts-expect-error WorkflowError is no longer public
type _NoWorkflowError = import("../index").WorkflowError;
// @ts-expect-error StepTimeoutError is no longer public
type _NoStepTimeoutError = import("../index").StepTimeoutError;
// @ts-expect-error DurableHandle is no longer public
type _NoDurableHandle = import("../index").DurableHandle<any>;
// @ts-expect-error AtomicResult is no longer public
type _NoAtomicResult = import("../index").AtomicResult<any>;
// @ts-expect-error StepCall is no longer public
type _NoStepCall = import("../index").StepCall<any>;
// @ts-expect-error WorkflowCall is no longer public
type _NoWorkflowCall = import("../index").WorkflowCall<any>;
// @ts-expect-error RequestCall is no longer public
type _NoRequestCall = import("../index").RequestCall<any>;
// @ts-expect-error ScopeCall is no longer public
type _NoScopeCall = import("../index").ScopeCall<any>;
// @ts-expect-error FirstCall is no longer public
type _NoFirstCall = import("../index").FirstCall<any>;
// @ts-expect-error old callback failure info is no longer public
type _NoStepFailureInfo = import("../index").StepFailureInfo;
// @ts-expect-error MANUAL is no longer public
type _NoManual = import("../index").ManualSentinel;
// @ts-expect-error AttemptAccessor was removed in favour of attempt namespaces
type _NoAttemptAccessor = import("../index").AttemptAccessor;
// @ts-expect-error FindUniqueResult was removed
type _NoFindUniqueResult = import("../index").FindUniqueResult<any>;
// @ts-expect-error FindManyResult was renamed to FindResult
type _NoFindManyResult = import("../index").FindManyResult<any>;
// @ts-expect-error IWorkflowConnection is no longer public
type _NoIWorkflowConnection = import("../index").IWorkflowConnection;
// @ts-expect-error IWorkflowTransaction is no longer public
type _NoIWorkflowTransaction = import("../index").IWorkflowTransaction;

// @ts-expect-error MockStorageDriver is not a public export
type _NoMockStorageDriver = import("../index").MockStorageDriver;
// @ts-expect-error createMockSessionRaw is not a public export
type _NoCreateMockSessionRaw = typeof import("../index").createMockSessionRaw;
// @ts-expect-error MockSessionRaw is not a public export
type _NoMockSessionRaw = import("../index").MockSessionRaw;

// @ts-expect-error driver is required
createWorkflowClient({} as Record<string, never>);

void sessionFirstIo;
void AttemptError;
void createWorkflowClientFromIndex;
void createTestWorkflowClient;
