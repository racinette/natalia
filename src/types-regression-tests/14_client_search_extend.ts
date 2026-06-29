/**
 * Client registry typing: `createWorkflowClient`, search predicates (`eq`, `and`,
 * `or`, `in_`, `gt`, `not`, …), `findUnique` / `findMany` / `count` + `sort`
 * (typed literal paths per `SearchSort`, like `11_search_query_generalization`),
 * and **`extend`** on header-derived handles (weak root + attached child).
 */
import { z } from "zod";
import { createWorkflowClient } from "../client";
import {
  defineWorkflow,
  defineWorkflowHeader,
  defineWorkflowInterface,
} from "../workflow";
import type {
  AttachedChildWorkflowExternalHandle,
  FindManyResult,
  FindUniqueResult,
  InferWorkflowArgs,
  InferWorkflowMetadata,
  InferWorkflowResult,
  WorkflowClient,
  WorkflowHandleExternal,
} from "../types";
import type {
  AttachedChildWorkflowId,
  WorkflowWhereTemplate,
} from "../types/schema";
import {
  and,
  eq,
  gt,
  in_,
  ne,
  not,
  or,
  type SearchSort,
} from "../types/search-query";
import type { Assert, IsEqual } from "./type-assertions";

// =============================================================================
// Contracts — catalog (rich row), shadow (different args), worker header + iface
// =============================================================================

const catalogHeader = defineWorkflowHeader({
  name: "client14Catalog",
  args: z.object({ sku: z.string(), qty: z.number() }),
  result: z.object({ lineId: z.string() }),
  metadata: z.object({ region: z.string() }),
});

const catalogInterface = catalogHeader.extend({
  streams: { out: z.object({ seq: z.number() }) },
});

const catalogWorkflow = catalogInterface.implement({
  async execute() {
    return { lineId: "L1" };
  },
});

const shadowInterface = defineWorkflowInterface({
  name: "client14Shadow",
  args: z.object({ flag: z.boolean() }),
  result: z.void(),
});

const shadowWorkflow = shadowInterface.implement({
  async execute() {
    return undefined;
  },
});

const workerHeader = defineWorkflowHeader({
  name: "client14Worker",
  args: z.object({ task: z.string() }),
  result: z.number(),
});

const workerInterface = workerHeader.extend({
  streams: { progress: z.object({ pct: z.number() }) },
  events: { done: true },
});

const orchestratorHeader = defineWorkflowHeader({
  name: "client14Orchestrator",
  args: z.object({ ref: z.string() }),
  result: z.void(),
});

const orchestratorWorkflow = defineWorkflow({
  ...orchestratorHeader,
  children: { worker: workerHeader },
  async execute() {
    return undefined;
  },
});

void catalogWorkflow;
void shadowWorkflow;

const client14Registry = {
  catalog: catalogInterface,
  shadow: shadowInterface,
  orchestrator: orchestratorWorkflow,
  workerWeak: workerHeader,
} as const;

const client14 = createWorkflowClient(client14Registry);

type _ClientKeys = Assert<
  IsEqual<
    keyof typeof client14.workflows,
    "catalog" | "shadow" | "orchestrator" | "workerWeak"
  >
>;

type CatalogWhereRow = WorkflowWhereTemplate<
  InferWorkflowArgs<typeof catalogInterface>,
  InferWorkflowResult<typeof catalogInterface>,
  InferWorkflowMetadata<typeof catalogInterface>
>;

const catalogSortExample: readonly SearchSort<CatalogWhereRow>[] = [
  { path: "createdAt", direction: "asc" },
  { path: "failedAt", direction: "desc" },
];

// =============================================================================
// Search API — predicates + sort + count (typed against each workflow's row template)
// =============================================================================

async function _client14SearchSurface(
  c: WorkflowClient<{
    catalog: typeof catalogInterface;
    shadow: typeof shadowInterface;
    orchestrator: typeof orchestratorWorkflow;
    workerWeak: typeof workerHeader;
  }>,
) {
  const _catalogCount = await c.workflows.catalog.count((s) =>
    in_(s.status, ["running", "pending"] as const),
  );
  type _CatalogCount = Assert<IsEqual<typeof _catalogCount, number>>;

  const _catalogUnique = await c.workflows.catalog.findUnique((s) =>
    and(
      eq(s.status, "completed"),
      eq(s.args.sku, "A-1"),
      eq(s.metadata.region, "eu"),
      not(eq(s.idempotencyKey, "exclude-me")),
      ne(s.definitionName, "other"),
    ),
  );
  type _CatalogUnique = Assert<
    IsEqual<
      typeof _catalogUnique,
      FindUniqueResult<WorkflowHandleExternal<typeof catalogInterface>>
    >
  >;

  const catalogMany = c.workflows.catalog.findMany(
    (s) =>
      or(
        eq(s.status, "halted"),
        and(eq(s.status, "failed"), gt(s.createdAt, new Date(0))),
      ),
    {
      sort: catalogSortExample,
      limit: 25,
    },
  );
  type _CatalogManyHandle = Assert<
    IsEqual<
      typeof catalogMany,
      FindManyResult<WorkflowHandleExternal<typeof catalogInterface>>
    >
  >;
  const catalogManyRows = await catalogMany;
  type _CatalogManyRows = Assert<
    IsEqual<
      typeof catalogManyRows,
      readonly WorkflowHandleExternal<typeof catalogInterface>[]
    >
  >;
  void catalogManyRows;

  const _shadowUnique = await c.workflows.shadow.findUnique((s) =>
    eq(s.args.flag, true),
  );
  type _ShadowUnique = Assert<
    IsEqual<
      typeof _shadowUnique,
      FindUniqueResult<WorkflowHandleExternal<typeof shadowInterface>>
    >
  >;

  const orch = c.workflows.orchestrator.get("idem-orch");
  type _OrchHandle = Assert<
    IsEqual<typeof orch, WorkflowHandleExternal<typeof orchestratorWorkflow>>
  >;

  const workerMany = orch.children.attached.worker.findMany((s) =>
    eq(s.args.task, "ping"),
  );
  type _WorkerManyHandle = Assert<
    IsEqual<
      typeof workerMany,
      FindManyResult<AttachedChildWorkflowExternalHandle<typeof workerHeader>>
    >
  >;
  const workerManyRows = await workerMany;
  type _WorkerManyRows = Assert<
    IsEqual<
      typeof workerManyRows,
      readonly AttachedChildWorkflowExternalHandle<typeof workerHeader>[]
    >
  >;
  void workerManyRows;

  const workerCount = await orch.children.attached.worker.count((s) =>
    gt(s.createdAt, new Date(0)),
  );
  type _WorkerCount = Assert<IsEqual<typeof workerCount, number>>;
  void workerCount;

  // @ts-expect-error — `shadow` rows have `{ flag: boolean }` args, not `sku`
  await c.workflows.shadow.findUnique((s) => eq(s.args.sku, "nope"));

  // @ts-expect-error — not a valid `WorkflowStatus` literal
  await c.workflows.catalog.findUnique((s) => eq(s.status, "not-a-status"));

  // @ts-expect-error — child namespace is typed to worker args (`task`), not catalog `sku`
  await orch.children.attached.worker.findUnique((s) => eq(s.args.sku, "x"));
}

void _client14SearchSurface(client14);

// =============================================================================
// `.extend` — header-derived weak root + attached child; second `extend` rejected
// =============================================================================

async function _client14ExtendSurface(
  c: WorkflowClient<{
    catalog: typeof catalogInterface;
    shadow: typeof shadowInterface;
    orchestrator: typeof orchestratorWorkflow;
    workerWeak: typeof workerHeader;
  }>,
) {
  const catalogRoot = c.workflows.catalog.get("idem-catalog");
  type _CatalogRoot = Assert<
    IsEqual<typeof catalogRoot, WorkflowHandleExternal<typeof catalogInterface>>
  >;
  void catalogRoot.streams.out;

  // @ts-expect-error — catalog registry entry is `WorkflowInterface`: handle has no `extend`
  void catalogRoot.extend(catalogInterface);

  const weakRoot = c.workflows.workerWeak.get("idem-worker-weak");
  type _WeakRoot = Assert<
    IsEqual<typeof weakRoot, WorkflowHandleExternal<typeof workerHeader>>
  >;

  const workerStrong = weakRoot.extend(workerInterface);
  type _WorkerStrong = Assert<
    typeof workerStrong extends WorkflowHandleExternal<typeof workerInterface>
      ? true
      : false
  >;
  void workerStrong.streams.progress.read(0);
  void workerStrong.events.done.isSet();
  // @ts-expect-error — after widen, `extend` is omitted / possibly undefined (`extend?: never`); cannot invoke
  void workerStrong.extend(workerInterface);

  const orch2 = c.workflows.orchestrator.get("idem-orch-2");
  type _Orch2Handle = Assert<
    IsEqual<typeof orch2, WorkflowHandleExternal<typeof orchestratorWorkflow>>
  >;
  // Synthetic branded id for typing `.get` / `.extend` (real ids come from the engine).
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- regression-only cast to `AttachedChildWorkflowId`
  const childId = "ch-1" as AttachedChildWorkflowId<typeof workerHeader>;
  const rawChild = orch2.children.attached.worker.get(childId);
  type _RawChild = Assert<
    IsEqual<
      typeof rawChild,
      AttachedChildWorkflowExternalHandle<typeof workerHeader>
    >
  >;

  const childStrong = rawChild.extend(workerInterface);
  type _ChildStrong = Assert<
    typeof childStrong extends AttachedChildWorkflowExternalHandle<
      typeof workerInterface
    >
      ? true
      : false
  >;
  void childStrong.streams.progress;
  void childStrong.events.done;

  // @ts-expect-error — widened handle is no longer header-derived: no second `extend`
  void childStrong.extend(workerInterface);
}

void _client14ExtendSurface(client14);

// =============================================================================
// `extend` — incompatible `TW` (name / channel keys / nested args / stream schema)
// =============================================================================

const extendWrongNameHeader = defineWorkflowHeader({
  name: "extContractWN",
  args: z.void(),
  result: z.void(),
});

const extendWrongNameIface = defineWorkflowInterface({
  name: "extContractWN_Other",
  args: z.void(),
  result: z.void(),
});

const extendChHeader = defineWorkflowHeader({
  name: "extContractCh",
  args: z.void(),
  result: z.void(),
  channels: { ch1: z.object({ a: z.string() }) },
});

const extendChIfaceWrongKey = defineWorkflowInterface({
  name: "extContractCh",
  args: z.void(),
  result: z.void(),
  channels: { ch2: z.object({ a: z.string() }) },
});

const extendChIfaceOk = defineWorkflowInterface({
  name: "extContractCh",
  args: z.void(),
  result: z.void(),
  channels: {
    ch1: z.object({ a: z.string() }),
    chAux: z.boolean(),
  },
});

const extendArgsHeader = defineWorkflowHeader({
  name: "extContractArgs",
  args: z.object({ a: z.array(z.object({ b: z.string() })) }),
  result: z.void(),
});

const extendArgsIfaceWrong = defineWorkflowInterface({
  name: "extContractArgs",
  args: z.object({ a: z.array(z.object({ b: z.number() })) }),
  result: z.void(),
});

/** Same channel key as the header, but incompatible decoded payload (easy to miss vs a wrong key). */
const extendChPayloadHeader = defineWorkflowHeader({
  name: "extContractChPayload",
  args: z.void(),
  result: z.void(),
  channels: { ch1: z.object({ n: z.number() }) },
});

const extendChPayloadIfaceWrong = defineWorkflowInterface({
  name: "extContractChPayload",
  args: z.void(),
  result: z.void(),
  channels: { ch1: z.object({ n: z.string() }) },
});

const extendContractClient = createWorkflowClient({
  wrongName: extendWrongNameHeader,
  wrongCh: extendChHeader,
  wrongArgs: extendArgsHeader,
  wrongChPayload: extendChPayloadHeader,
});

async function _client14ExtendWrongContract(
  cx: WorkflowClient<{
    wrongName: typeof extendWrongNameHeader;
    wrongCh: typeof extendChHeader;
    wrongArgs: typeof extendArgsHeader;
    wrongChPayload: typeof extendChPayloadHeader;
  }>,
) {
  const hN = cx.workflows.wrongName.get("idem-wn");
  // @ts-expect-error — widen target must share the same `name` literal as the header
  void hN.extend(extendWrongNameIface);

  const hC = cx.workflows.wrongCh.get("idem-ch");
  void hC.extend(extendChIfaceOk);
  // @ts-expect-error — header exposes `ch1`; widen target replaces the slot with `ch2`
  void hC.extend(extendChIfaceWrongKey);

  const hA = cx.workflows.wrongArgs.get("idem-args");
  // @ts-expect-error — decoded `args` disagree on nested `b` (`string` vs `number`)
  void hA.extend(extendArgsIfaceWrong);

  const hP = cx.workflows.wrongChPayload.get("idem-p");
  // @ts-expect-error — same channel key `ch1` but incompatible nested field type (`number` vs `string`)
  void hP.extend(extendChPayloadIfaceWrong);
}

void _client14ExtendWrongContract(extendContractClient);
