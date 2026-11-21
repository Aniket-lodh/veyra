/**
 * Minimal, dependency-free subset of the [Standard Schema v1](https://standardschema.dev)
 * interfaces plus a compile-time-only schema helper.
 */

import { VeyraValidationError } from './errors.js';

/**
 * A Standard Schema v1 compatible schema (Zod, Valibot, ArkType, ...).
 *
 * @typeParam Input - Value accepted by the schema.
 * @typeParam Output - Value produced after validation.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  /** Schema metadata and validation entry point. */
  interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }

  /** Validation result: exactly one of `value` or `issues` is populated. */
  interface Result<Output> {
    readonly value?: Output | undefined;
    readonly issues?: ReadonlyArray<Issue> | undefined;
  }

  /** A single validation failure. */
  interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }

  /** Object key in an issue path. */
  interface PathSegment {
    readonly key: PropertyKey;
  }

  /** Compile-time input/output pair exposed by a schema. */
  interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }

  /** Extracts the schema input type. */
  type InferInput<Schema extends StandardSchemaV1> =
    Schema['~standard']['types'] extends Types<infer Input, any> ? Input : unknown;

  /** Extracts the schema output type. */
  type InferOutput<Schema extends StandardSchemaV1> =
    Schema['~standard']['types'] extends Types<any, infer Output> ? Output : unknown;
}

/**
 * A zero-runtime schema used purely to carry `TPayload`/`TResult` types.
 * Created with {@link staticSchema}; no validation runs.
 */
export interface StaticSchema<T> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: 'veyra';
    readonly types: StandardSchemaV1.Types<T, T>;
  };
}

/** A runtime Standard Schema or a compile-time-only {@link StaticSchema}. */
export type SchemaLike<T> = StandardSchemaV1<unknown, T> | StaticSchema<T>;

/** Extracts the output type of a {@link SchemaLike}. */
export type InferSchemaOutput<S> = S extends StandardSchemaV1<any, infer Output>
  ? Output
  : S extends StaticSchema<infer T>
    ? T
    : unknown;

/**
 * Declares payload/result types without runtime validation or dependencies.
 *
 * The returned value is `undefined` at runtime; only the type is meaningful.
 *
 * @example
 * ```ts
 * const sendEmail = defineHandler({
 *   name: 'send_email',
 *   payload: staticSchema<{ to: string }>(),
 *   result: staticSchema<{ messageId: string }>(),
 * });
 * ```
 */
export function staticSchema<T>(): StaticSchema<T> {
  return undefined as unknown as StaticSchema<T>;
}

function isRuntimeSchema<T>(
  schema: SchemaLike<T>
): schema is StandardSchemaV1<unknown, T> {
  return typeof (schema as StandardSchemaV1<unknown, T>)['~standard']?.validate === 'function';
}

/**
 * Validates `value` with a runtime Standard Schema, or returns it unchanged for
 * {@link StaticSchema} values.
 *
 * @param schema - Schema to validate with, or `undefined` to skip validation.
 * @param value - Candidate value.
 * @param label - Human-readable context included in the thrown error.
 * @returns The schema output, or `value` when no runtime schema is present.
 * @throws {VeyraValidationError} When validation produces issues.
 */
export async function validateWithSchema<T>(
  schema: SchemaLike<T> | undefined,
  value: unknown,
  label: string
): Promise<T> {
  if (!schema || !isRuntimeSchema(schema)) {
    return value as T;
  }
  const result = await schema['~standard'].validate(value);
  if (result.issues && result.issues.length > 0) {
    throw new VeyraValidationError(label, result.issues);
  }
  return result.value as T;
}
