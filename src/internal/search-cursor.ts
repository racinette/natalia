import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  SearchMetadataRecord,
  WorkflowSearchCursor,
  WorkflowSearchQueryNode,
  WorkflowSearchSort,
} from "../types/search-query";

export type WorkflowSearchCursorValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Date
  | bigint
  | readonly WorkflowSearchCursorValue[]
  | { readonly [key: string]: WorkflowSearchCursorValue };

export interface WorkflowSearchCursorPayloadV1<
  TMetadata extends SearchMetadataRecord = Record<string, never>,
> {
  readonly v: 1;
  readonly workflow: string;
  readonly where?: WorkflowSearchQueryNode<TMetadata>;
  readonly sort: readonly WorkflowSearchSort<TMetadata>[];
  readonly limit: number;
  readonly last: readonly WorkflowSearchCursorValue[];
  readonly tie: string;
}

interface WorkflowSearchCursorEnvelopeV1 {
  readonly v: 1;
  readonly payload: string;
  readonly signature?: string;
}

export interface WorkflowSearchCursorCodecOptions {
  readonly secret?: string;
}

type CursorSerializedValue =
  | string
  | number
  | boolean
  | null
  | readonly CursorSerializedValue[]
  | { readonly [key: string]: CursorSerializedValue };

const CURSOR_TYPE_TAG_KEY = "__wfsc_t";
const CURSOR_TYPE_VALUE_KEY = "__wfsc_v";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeCursorValue(value: unknown): CursorSerializedValue {
  if (value === undefined) {
    return { [CURSOR_TYPE_TAG_KEY]: "undefined" };
  }
  if (value instanceof Date) {
    return {
      [CURSOR_TYPE_TAG_KEY]: "date",
      [CURSOR_TYPE_VALUE_KEY]: value.toISOString(),
    };
  }
  if (typeof value === "bigint") {
    return {
      [CURSOR_TYPE_TAG_KEY]: "bigint",
      [CURSOR_TYPE_VALUE_KEY]: value.toString(),
    };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => serializeCursorValue(entry));
  }
  if (isRecord(value)) {
    const output: Record<string, CursorSerializedValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = serializeCursorValue(entry);
    }
    return output;
  }
  return value as Exclude<CursorSerializedValue, readonly CursorSerializedValue[]>;
}

function deserializeCursorValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => deserializeCursorValue(entry));
  }
  if (isRecord(value)) {
    const maybeTag = value[CURSOR_TYPE_TAG_KEY];
    if (maybeTag === "undefined") {
      return undefined;
    }
    if (maybeTag === "date") {
      const raw = value[CURSOR_TYPE_VALUE_KEY];
      if (typeof raw !== "string") {
        throw new Error("Invalid cursor payload: date tag must contain a string");
      }
      return new Date(raw);
    }
    if (maybeTag === "bigint") {
      const raw = value[CURSOR_TYPE_VALUE_KEY];
      if (typeof raw !== "string") {
        throw new Error("Invalid cursor payload: bigint tag must contain a string");
      }
      return BigInt(raw);
    }
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = deserializeCursorValue(entry);
    }
    return output;
  }
  return value;
}

function signPayload(payloadBase64Url: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(payloadBase64Url, "utf8")
    .digest("base64url");
}

function signaturesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Encode cursor payload into signed opaque branded token.
 *
 * Envelope format:
 * - outer token: base64url(JSON.stringify({ v, payload, signature }))
 * - payload: base64url(tagged JSON)
 */
export function encodeWorkflowSearchCursor<
  TMetadata extends SearchMetadataRecord = Record<string, never>,
>(
  payload: WorkflowSearchCursorPayloadV1<TMetadata>,
  options: WorkflowSearchCursorCodecOptions = {},
): WorkflowSearchCursor<TMetadata> {
  const payloadJson = JSON.stringify(serializeCursorValue(payload));
  const payloadBase64Url = Buffer.from(payloadJson, "utf8").toString("base64url");
  const signature =
    options.secret === undefined
      ? undefined
      : signPayload(payloadBase64Url, options.secret);
  const envelope: WorkflowSearchCursorEnvelopeV1 = {
    v: 1,
    payload: payloadBase64Url,
    signature,
  };
  const envelopeJson = JSON.stringify(envelope);
  return Buffer.from(envelopeJson, "utf8").toString(
    "base64url",
  ) as WorkflowSearchCursor<TMetadata>;
}

/**
 * Decode and verify signed cursor token.
 */
export function decodeWorkflowSearchCursor<
  TMetadata extends SearchMetadataRecord = Record<string, never>,
>(
  cursor: WorkflowSearchCursor<TMetadata>,
  options: WorkflowSearchCursorCodecOptions = {},
): WorkflowSearchCursorPayloadV1<TMetadata> {
  const envelopeJson = Buffer.from(cursor, "base64url").toString("utf8");
  const envelopeRaw = JSON.parse(envelopeJson) as unknown;
  if (!isRecord(envelopeRaw) || envelopeRaw.v !== 1) {
    throw new Error("Invalid cursor envelope: unsupported or missing version");
  }
  const payloadBase64Url = envelopeRaw.payload;
  const signature = envelopeRaw.signature;
  if (typeof payloadBase64Url !== "string") {
    throw new Error("Invalid cursor envelope: payload is required");
  }
  if (signature !== undefined && typeof signature !== "string") {
    throw new Error("Invalid cursor envelope: signature must be a string");
  }

  if (options.secret !== undefined) {
    if (signature === undefined) {
      throw new Error("Invalid cursor envelope: missing signature");
    }
    const expectedSignature = signPayload(payloadBase64Url, options.secret);
    if (!signaturesEqual(signature, expectedSignature)) {
      throw new Error("Invalid cursor envelope: signature mismatch");
    }
  }

  const payloadJson = Buffer.from(payloadBase64Url, "base64url").toString("utf8");
  const payloadRaw = JSON.parse(payloadJson) as unknown;
  const payload = deserializeCursorValue(payloadRaw);
  if (!isRecord(payload) || payload.v !== 1) {
    throw new Error("Invalid cursor payload: unsupported or missing version");
  }
  return payload as unknown as WorkflowSearchCursorPayloadV1<TMetadata>;
}
