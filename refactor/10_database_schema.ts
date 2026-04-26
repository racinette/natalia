import type {
  BranchInstanceId,
  BranchInstanceRecord,
  BranchInstanceStatus,
  CompensationBlockInstanceId,
  CompensationBlockRecord,
  CompensationBlockStatus,
  HaltRecord,
  HaltStatus,
  PromiseRecord,
  PromiseStatus,
  RequestCompensationInstanceId,
  RequestCompensationRecord,
  RequestCompensationStatus,
  ScopeInstanceId,
  StepInstanceId,
  StepInstanceRecord,
  WorkflowInstanceId,
} from "../types";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type _WorkflowIdIsOpaque = Assert<string extends WorkflowInstanceId ? false : true>;
type _BranchIdIsOpaque = Assert<string extends BranchInstanceId ? false : true>;
type _ScopeIdIsOpaque = Assert<string extends ScopeInstanceId ? false : true>;
type _StepIdIsOpaque = Assert<string extends StepInstanceId ? false : true>;
type _CompensationIdIsOpaque = Assert<
  string extends CompensationBlockInstanceId ? false : true
>;
type _RequestCompensationIdIsOpaque = Assert<
  string extends RequestCompensationInstanceId ? false : true
>;

type _BranchStatus = Assert<
  IsEqual<
    BranchInstanceStatus,
    "pending" | "running" | "complete" | "failed" | "halted" | "skipped"
  >
>;

type _PromiseStatus = Assert<
  IsEqual<PromiseStatus, "pending" | "fulfilled" | "rejected" | "cancelled">
>;

type _CompensationStatus = Assert<
  IsEqual<
    CompensationBlockStatus,
    "pending" | "running" | "complete" | "failed" | "halted" | "skipped"
  >
>;

type _RequestCompensationStatus = Assert<
  IsEqual<
    RequestCompensationStatus,
    "pending" | "running" | "complete" | "failed" | "manual" | "cancelled"
  >
>;

type _HaltStatus = Assert<
  IsEqual<HaltStatus, "open" | "resolved" | "skipped" | "terminated">
>;

declare const workflowId: WorkflowInstanceId;
declare const branchId: BranchInstanceId;
declare const scopeId: ScopeInstanceId;
declare const stepId: StepInstanceId;

const branchRecord: BranchInstanceRecord = {
  id: branchId,
  workflowId,
  parentScopeId: scopeId,
  name: "branch",
  status: "running",
  args: { id: "b-1" },
  result: undefined,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const stepRecord: StepInstanceRecord = {
  id: stepId,
  workflowId,
  branchId,
  name: "bookFlight",
  args: { destination: "Paris" },
  status: "running",
  result: undefined,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const promiseRecord: PromiseRecord = {
  workflowId,
  branchId,
  key: "promise:1",
  status: "pending",
  value: undefined,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const compensationRecord: CompensationBlockRecord = {
  id: "comp-1" as CompensationBlockInstanceId,
  workflowId,
  sourceStepId: stepId,
  status: "pending",
  args: { destination: "Paris" },
  forwardResult: undefined,
  result: undefined,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const requestCompensationRecord: RequestCompensationRecord = {
  id: "req-comp-1" as RequestCompensationInstanceId,
  workflowId,
  requestName: "approval",
  status: "manual",
  payload: { id: "r-1" },
  response: undefined,
  result: undefined,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const haltRecord: HaltRecord = {
  workflowId,
  target: { kind: "branch", branchId },
  status: "open",
  reason: "determinism",
  message: "Replay diverged",
  createdAt: new Date(),
  resolvedAt: undefined,
};

// @ts-expect-error status strings must match schema check constraints
const badBranchStatus: BranchInstanceRecord = { ...branchRecord, status: "done" };
// @ts-expect-error step args are persisted as JSON-compatible data
const badStepArgs: StepInstanceRecord = { ...stepRecord, args: new Set(["x"]) };
// @ts-expect-error promise statuses are constrained
const badPromiseStatus: PromiseRecord = { ...promiseRecord, status: "settled" };

void compensationRecord;
void requestCompensationRecord;
void haltRecord;
