import {
  AttemptError,
  defineQueue,
  defineRequest,
  defineStep,
  defineTopic,
  defineWorkflow,
  defineWorkflowHeader,
  MAIN_BRANCH,
  MANUAL,
  UnrecoverableError,
} from "../index";
import type {
  Attempt,
  AttemptAccessor,
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
  FindUniqueResult,
  IWorkflowConnection,
  IWorkflowTransaction,
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
  | AttemptAccessor
  | Failure
  | AttemptError
  | FailureInfo;

type _ErrorExports = ExplicitError<any, any> | ErrorValue<any>;

type _CompensationExports =
  | CompensationInfo<any>
  | CompensationBlockStatus
  | CompensationBlockInstanceId
  | FindUniqueResult<any>;

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
type _Manual = Assert<IsEqual<typeof MANUAL, import("../index").ManualSentinel>>;
type _Unrecoverable = Assert<typeof UnrecoverableError extends typeof Error ? true : false>;
type _ConnectionOpaque = Assert<string extends IWorkflowConnection ? false : true>;
type _TransactionOpaque = Assert<string extends IWorkflowTransaction ? false : true>;

declare const tx: IWorkflowTransaction;
declare const conn: IWorkflowConnection;
declare const client: import("../index").WorkflowClient<any>;

async function txOrConnUsage(): Promise<void> {
  await client.workflows.someWorkflow.get("workflow-id", tx);
  await client.workflows.someWorkflow.get("workflow-id", conn);
  await client.workflows.someWorkflow.search({ limit: 1 }, tx);
  await client.workflows.someWorkflow.start(
    { idempotencyKey: "with-tx", args: undefined },
    conn,
  );
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
// @ts-expect-error old compensation closure result info is no longer public
type _NoStepCompensationResult = import("../index").StepCompensationResult<any>;

void txOrConnUsage;
void AttemptError;
