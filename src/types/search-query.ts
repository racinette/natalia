// =============================================================================
// SEARCH QUERY — ROW-SCOPED PREDICATE DSL
//
// Public predicates are authored against one row-shaped template type:
// `WhereScope<TRowTemplate>`. There is no author-facing namespace split
// (`row` / `args` / `metadata`), and no builder object.
// =============================================================================

export type WhereTemplateRecord = object;

// -----------------------------------------------------------------------------
// Field references and scope projection
// -----------------------------------------------------------------------------

declare const __predicateBrand: unique symbol;
declare const __fieldRefBrand: unique symbol;
declare const __arrayRefBrand: unique symbol;

export interface Predicate {
  readonly [__predicateBrand]: true;
}

export interface FieldRef<TValue> {
  readonly [__fieldRefBrand]: TValue;
  readonly __kind: "field";
  readonly path: string;
}

export interface ArrayRef<TElement> {
  readonly [__arrayRefBrand]: TElement;
  readonly __kind: "array";
  readonly path: string;
}

type ScopeObject<T> = T extends object
  ? T extends readonly unknown[]
    ? never
    : T extends Date
      ? never
      : T
  : never;

type StripNullish<T> = Exclude<T, null | undefined>;

type ObjectScope<T> = [ScopeObject<StripNullish<T>>] extends [never]
  ? never
  : {
      readonly [K in keyof ScopeObject<StripNullish<T>>]-?: WhereScope<
        ScopeObject<StripNullish<T>>[K]
      >;
    };

export type WhereScope<TValue> = [StripNullish<TValue>] extends [
  readonly (infer TElement)[],
]
  ? ArrayRef<TElement>
  : [ObjectScope<TValue>] extends [never]
    ? FieldRef<TValue>
    : ObjectScope<TValue>;

export type WhereFn<TRowTemplate extends WhereTemplateRecord> = (
  scope: WhereScope<TRowTemplate>,
) => Predicate | true;

/** Unconditional match within namespace scope (`WHERE TRUE`). */
export const whereTrue = <
  TRowTemplate extends WhereTemplateRecord,
>(
  _scope: WhereScope<TRowTemplate>,
): true => true;

// -----------------------------------------------------------------------------
// Type-level operator capabilities
// -----------------------------------------------------------------------------

type ComparableScalar = string | number | bigint | Date;

type HomogeneousComparable<TValue> = Extract<
  TValue,
  ComparableScalar
> extends infer TComparable
  ? [TComparable] extends [never]
    ? never
    : [TComparable] extends [string]
      ? string
      : [TComparable] extends [number]
        ? number
        : [TComparable] extends [bigint]
          ? bigint
          : [TComparable] extends [Date]
            ? Date
            : never
  : never;

type FieldValue<TField extends FieldRef<unknown>> =
  TField extends FieldRef<infer TValue> ? TValue : never;

type ArrayElement<TArray extends ArrayRef<unknown>> =
  TArray extends ArrayRef<infer TElement> ? TElement : never;

// -----------------------------------------------------------------------------
// Internal AST carrier + helpers
// -----------------------------------------------------------------------------

type PredicateNode =
  | { readonly kind: "and"; readonly nodes: readonly PredicateNode[] }
  | { readonly kind: "or"; readonly nodes: readonly PredicateNode[] }
  | { readonly kind: "not"; readonly node: PredicateNode }
  | {
      readonly kind:
        | "eq"
        | "ne"
        | "in"
        | "notIn"
        | "gt"
        | "gte"
        | "lt"
        | "lte"
        | "contains";
      readonly path: string;
      readonly value: unknown;
    }
  | {
      readonly kind: "some" | "every";
      readonly path: string;
      readonly node: PredicateNode;
    };

const asNode = (predicate: Predicate): PredicateNode =>
  (predicate as Predicate & { readonly __node: PredicateNode }).__node;

const wrapNode = (node: PredicateNode): Predicate =>
  ({ [__predicateBrand]: true, __node: node } as const) as Predicate;

// -----------------------------------------------------------------------------
// Public combinators and operators
// -----------------------------------------------------------------------------

export const and = (...predicates: readonly Predicate[]): Predicate =>
  wrapNode({ kind: "and", nodes: predicates.map(asNode) });

export const or = (...predicates: readonly Predicate[]): Predicate =>
  wrapNode({ kind: "or", nodes: predicates.map(asNode) });

export const not = (predicate: Predicate): Predicate =>
  wrapNode({ kind: "not", node: asNode(predicate) });

export const eq = <TField extends FieldRef<unknown>>(
  field: TField,
  value: FieldValue<TField>,
): Predicate =>
  wrapNode({ kind: "eq", path: field.path, value });

export const ne = <TField extends FieldRef<unknown>>(
  field: TField,
  value: FieldValue<TField>,
): Predicate =>
  wrapNode({ kind: "ne", path: field.path, value });

export const in_ = <TField extends FieldRef<unknown>>(
  field: TField,
  values: readonly FieldValue<TField>[],
): Predicate =>
  wrapNode({ kind: "in", path: field.path, value: values });

export const notIn = <TField extends FieldRef<unknown>>(
  field: TField,
  values: readonly FieldValue<TField>[],
): Predicate =>
  wrapNode({ kind: "notIn", path: field.path, value: values });

export const gt = <TField extends FieldRef<unknown>>(
  field: TField,
  value: HomogeneousComparable<FieldValue<TField>>,
): Predicate =>
  wrapNode({ kind: "gt", path: field.path, value });

export const gte = <TField extends FieldRef<unknown>>(
  field: TField,
  value: HomogeneousComparable<FieldValue<TField>>,
): Predicate =>
  wrapNode({ kind: "gte", path: field.path, value });

export const lt = <TField extends FieldRef<unknown>>(
  field: TField,
  value: HomogeneousComparable<FieldValue<TField>>,
): Predicate =>
  wrapNode({ kind: "lt", path: field.path, value });

export const lte = <TField extends FieldRef<unknown>>(
  field: TField,
  value: HomogeneousComparable<FieldValue<TField>>,
): Predicate =>
  wrapNode({ kind: "lte", path: field.path, value });

export const isNull = <TField extends FieldRef<unknown>>(
  field: TField & (null extends FieldValue<TField> ? unknown : never),
): Predicate => wrapNode({ kind: "eq", path: field.path, value: null });

export const isMissing = <TField extends FieldRef<unknown>>(
  field: TField & (undefined extends FieldValue<TField> ? unknown : never),
): Predicate => wrapNode({ kind: "eq", path: field.path, value: undefined });

export const isNullish = <TField extends FieldRef<unknown>>(
  field: TField &
    (null extends FieldValue<TField> ? unknown : never) &
    (undefined extends FieldValue<TField> ? unknown : never),
): Predicate =>
  or(
    wrapNode({ kind: "eq", path: field.path, value: null }),
    wrapNode({ kind: "eq", path: field.path, value: undefined }),
  );

export const contains = <TArray extends ArrayRef<unknown>>(
  arrayField: TArray,
  value: ArrayElement<TArray>,
): Predicate =>
  wrapNode({ kind: "contains", path: arrayField.path, value });

export const some = <TArray extends ArrayRef<unknown>>(
  arrayField: TArray,
  predicate: (item: WhereScope<ArrayElement<TArray>>) => Predicate,
): Predicate => {
  const itemScope = createWhereScopeProxy("") as WhereScope<ArrayElement<TArray>>;
  return wrapNode({
    kind: "some",
    path: arrayField.path,
    node: asNode(predicate(itemScope)),
  });
};

export const every = <TArray extends ArrayRef<unknown>>(
  arrayField: TArray,
  predicate: (item: WhereScope<ArrayElement<TArray>>) => Predicate,
): Predicate => {
  const itemScope = createWhereScopeProxy("") as WhereScope<ArrayElement<TArray>>;
  return wrapNode({
    kind: "every",
    path: arrayField.path,
    node: asNode(predicate(itemScope)),
  });
};

// -----------------------------------------------------------------------------
// Sort
// -----------------------------------------------------------------------------

export type SearchSortDirection = "asc" | "desc";

type SortComparablePath<TTemplate, TPath extends string> = PathValue<
  TTemplate,
  TPath
> extends infer TValue
  ? [HomogeneousComparable<TValue>] extends [never]
    ? never
    : TPath
  : never;

type JoinPath<L extends string, R extends string> = `${L}.${R}`;

type ObjectKeys<T> = T extends object
  ? T extends readonly unknown[]
    ? never
    : T extends Date
      ? never
      : Extract<keyof T, string>
  : never;

type Descend<T, K extends string> = T extends object
  ? K extends keyof T
    ? T[K]
    : never
  : never;

type AnyPath<T> = {
  [K in ObjectKeys<T>]:
    | K
    | (AnyPath<Descend<T, K>> extends infer R
        ? R extends string
          ? JoinPath<K, R>
          : never
        : never);
}[ObjectKeys<T>];

type PathValue<T, P extends string> = P extends `${infer K}.${infer R}`
  ? PathValue<Descend<T, K>, R>
  : Descend<T, P>;

type ComparablePath<TTemplate> = AnyPath<TTemplate> extends infer TPath
  ? TPath extends string
    ? SortComparablePath<TTemplate, TPath>
    : never
  : never;

export type SearchSort<TTemplate extends WhereTemplateRecord> = {
  readonly path: ComparablePath<TTemplate>;
  readonly direction: SearchSortDirection;
};

export interface SearchQuery<TTemplate extends WhereTemplateRecord> {
  readonly where?: Predicate;
  readonly sort?: readonly SearchSort<TTemplate>[];
  readonly limit?: number;
}

export const asc = (
  field: FieldRef<unknown>,
): { readonly path: string; readonly direction: "asc" } => ({
  path: field.path,
  direction: "asc",
});

export const desc = (
  field: FieldRef<unknown>,
): { readonly path: string; readonly direction: "desc" } => ({
  path: field.path,
  direction: "desc",
});

// -----------------------------------------------------------------------------
// Scope proxy helper for runtime builders (internal).
// -----------------------------------------------------------------------------

export const createWhereScopeProxy = (basePath = ""): unknown =>
  new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") {
          return undefined;
        }
        const path = basePath.length === 0 ? prop : `${basePath}.${prop}`;
        return new Proxy(
          {
            __kind: "field",
            path,
          } as const,
          {
            get(innerTarget, innerProp) {
              if (innerProp === "__kind" || innerProp === "path") {
                return innerTarget[innerProp];
              }
              if (typeof innerProp !== "string") {
                return undefined;
              }
              return (createWhereScopeProxy(path) as Record<string, unknown>)[
                innerProp
              ];
            },
          },
        );
      },
    },
  );


