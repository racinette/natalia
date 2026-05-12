import { z } from "zod";
import type {
  AttributeDefinitions,
  ChannelDefinitions,
  JsonInput,
  JsonInputObject,
  JsonObjectSchemaConstraint,
  StreamDefinitions,
} from "../types";
import type { SchemaInvocationInput } from "../types/context/entries";
import type { StandardSchemaV1 } from "../types/standard-schema";
import type { Assert, IsEqual } from "./type-assertions";

// =============================================================================
// STANDARD SCHEMA × JSON — compile-time regression
//
// Some persisted / cross-boundary Standard Schema slots constrain the schema's
// Standard Schema *Input* generic to `JsonInput` (channels, streams, attributes)
// or to `JsonObjectSchemaConstraint` (workflow metadata). Those are asserted here.
//
// `JsonSchemaConstraint` is `StandardSchemaV1<unknown, unknown>` and does **not**
// statically reject e.g. `bigint` in step args — libraries and runtime validation
// own that story. This file does not claim coverage for those weaker slots.
// =============================================================================

// -----------------------------------------------------------------------------
// 1. JsonInput — structural sanity
// -----------------------------------------------------------------------------

type _JsonScalar = Assert<JsonScalar extends JsonInput ? true : false>;
type JsonScalar = string | number | boolean | null;

type _JsonNestedObject = Assert<
  { readonly nested: { readonly x: string } } extends JsonInput ? true : false
>;

type _JsonTupleLike = Assert<readonly [1, "a", false] extends JsonInput ? true : false>;

type _BigintNotJsonInput = Assert<bigint extends JsonInput ? false : true>;
type _MapNotJsonInput = Assert<Map<string, string> extends JsonInput ? false : true>;
type _FnNotJsonInput = Assert<(() => void) extends JsonInput ? false : true>;
type _SymbolNotJsonInput = Assert<symbol extends JsonInput ? false : true>;

// Date is not part of the JsonInput union (opaque class instance).
type _DateNotJsonInput = Assert<Date extends JsonInput ? false : true>;

// -----------------------------------------------------------------------------
// 2. JsonInputObject — metadata-shaped JSON object
// -----------------------------------------------------------------------------

type _PlainMeta = Assert<
  { readonly region: string; readonly count: number } extends JsonInputObject
    ? true
    : false
>;

type _MetaRejectsBigintField = Assert<
  { readonly id: bigint } extends JsonInputObject ? false : true
>;

// -----------------------------------------------------------------------------
// 3. Primitive plane — channels, streams, attributes
//
// Definitions use `StandardSchemaV1<JsonInput, unknown>` so the schema's input
// side must be JSON-compatible at the type level.
// -----------------------------------------------------------------------------

const _channelOk: ChannelDefinitions = {
  ping: z.object({ msg: z.string(), n: z.number().optional() }),
};

const _streamOk: StreamDefinitions = {
  tail: z.object({ seq: z.number(), body: z.string() }),
};

const _attrOk: AttributeDefinitions = {
  revision: z.object({ version: z.number(), label: z.string() }),
};

declare const dateAsSchemaInput: StandardSchemaV1<Date, unknown>;
declare const bigintFieldSchema: StandardSchemaV1<{ id: bigint }, unknown>;
declare const mapFieldSchema: StandardSchemaV1<{ m: ReadonlyMap<string, string> }, unknown>;

const _channelRejectsDate: ChannelDefinitions = {
  // @ts-expect-error Date is not JsonInput
  bad: dateAsSchemaInput,
};

const _channelRejectsBigint: ChannelDefinitions = {
  // @ts-expect-error bigint property value is not JsonInput
  bad: bigintFieldSchema,
};

const _streamRejectsMap: StreamDefinitions = {
  // @ts-expect-error Map is not JsonInput
  bad: mapFieldSchema,
};

const _attrRejectsDate: AttributeDefinitions = {
  // @ts-expect-error Date is not JsonInput
  bad: dateAsSchemaInput,
};

// Homogeneous Record assignability: a wider map must still satisfy per-value JsonInput input.
type _ChannelMapVariance = Assert<
  Record<string, StandardSchemaV1<JsonInput, unknown>> extends ChannelDefinitions
    ? true
    : false
>;

// -----------------------------------------------------------------------------
// 4. Workflow metadata — JsonObjectSchemaConstraint
// -----------------------------------------------------------------------------

const _metadataOk: JsonObjectSchemaConstraint = z.object({
  tenant: z.string(),
  tier: z.enum(["free", "paid"]),
});

declare const nonObjectRootSchema: StandardSchemaV1<string, unknown>;

// @ts-expect-error metadata input must be JsonInputObject | void | undefined, not a string root
const _metadataRejectsScalarRoot: JsonObjectSchemaConstraint = nonObjectRootSchema;

declare const objectWithBigintSchema: StandardSchemaV1<
  { readonly trace: bigint },
  unknown
>;

// @ts-expect-error object field trace uses bigint, which is not JsonInput
const _metadataRejectsBigintField: JsonObjectSchemaConstraint = objectWithBigintSchema;

// -----------------------------------------------------------------------------
// 5. SchemaInvocationInput — encoded / wire args stay JSON-serializable
//
// When `InferInput` is `unknown` (typical for z.coerce.*), `SchemaInvocationInput`
// derives from `InferOutput` via `SerializedInputFromOutput`, mapping `Date` to
// `string | number` so call sites cannot pass raw `Date` where only JSON is safe.
// -----------------------------------------------------------------------------

const coerceDateArg = z.object({ at: z.coerce.date() });

type InvokeCoerceDate = SchemaInvocationInput<typeof coerceDateArg>;

type _CoerceDateAcceptsIsoString = Assert<
  { at: string } extends InvokeCoerceDate ? true : false
>;

type _CoerceDateAcceptsNumericEpoch = Assert<
  { at: number } extends InvokeCoerceDate ? true : false
>;

// Raw Date must not be the *only* accepted invocation shape when input is unknown.
type _CoerceDateDoesNotRequireDateInstance = Assert<
  IsEqual<InvokeCoerceDate, { at: Date }> extends true ? false : true
>;

const strictObject = z.object({ a: z.string() });

type InvokeStrict = SchemaInvocationInput<typeof strictObject>;

type _StrictUsesInferInput = Assert<IsEqual<InvokeStrict, { a: string }>>;

// -----------------------------------------------------------------------------
// 6. Positive — zod primitives used across definitions stay within JsonInput
// -----------------------------------------------------------------------------

const _zodRecordChannel: ChannelDefinitions = {
  row: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
};

void (
  _channelOk &&
  _streamOk &&
  _attrOk &&
  _metadataOk &&
  _zodRecordChannel &&
  coerceDateArg &&
  strictObject &&
  _channelRejectsDate &&
  _channelRejectsBigint &&
  _streamRejectsMap &&
  _attrRejectsDate &&
  _metadataRejectsScalarRoot &&
  _metadataRejectsBigintField
);
