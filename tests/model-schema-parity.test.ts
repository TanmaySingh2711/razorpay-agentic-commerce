import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  INTENT_RESPONSE_JSON_SCHEMA,
  structuredPurchaseIntentSchema,
} from "@/domain/buyer-agent/intent";
import {
  SELECTION_RESPONSE_JSON_SCHEMA,
  modelSelectionSchema,
} from "@/domain/buyer-agent/decision";

/**
 * The two halves of every model contract, checked against each other.
 *
 * This project states each structured-output contract twice: once as JSON
 * Schema sent to Gemini, and once as a Zod schema that re-validates whatever
 * comes back. That duplication is deliberate and load-bearing - provider-side
 * enforcement is a convenience that can change or degrade, and a financial
 * system may not depend on a remote service's promise about its own output.
 *
 * But two statements of one contract can disagree, and when they do the model
 * is blamed for our mistake. It has now happened three times, each time
 * surfacing as an `AI_PROVIDER_INVALID_RESPONSE` that no deterministic test
 * could reproduce, because the in-memory fakes always produce payloads shaped
 * the way the validator wants:
 *
 *  1. the runtime capped a clarification question at 300 characters while the
 *     JSON Schema stated no limit, so a slightly long question was refused;
 *  2. the selection validator demanded `selectedProductId`, `quantity` and
 *     `clarificationQuestion` be present, while the JSON Schema marked all
 *     three optional - so a model that correctly omitted them for a `NO_MATCH`
 *     was refused;
 *  3. several selection bounds - the id length, the quantity range, both
 *     reason-code array limits and the summary length - existed only in Zod.
 *
 * So the two are compared mechanically rather than by eye. The rules are:
 *
 *  - **Anything the provider schema permits, the validator must accept.** A
 *    payload that satisfies the contract we published cannot be refused by the
 *    contract we kept. This is the direction that causes outages.
 *  - **Every bound the validator enforces must be declared to the provider.**
 *    Otherwise the model is being judged against a rule it was never given.
 *
 * The reverse direction is deliberately *not* asserted: the validator may be
 * stricter in ways JSON Schema cannot express, and it may refuse things the
 * provider would have allowed. That is the whole point of validating twice.
 */

interface JsonSchemaLike {
  readonly type: string;
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly required?: readonly string[];
}

const CONTRACTS = [
  {
    name: "intent",
    json: INTENT_RESPONSE_JSON_SCHEMA as unknown as JsonSchemaLike,
    zod: structuredPurchaseIntentSchema as unknown as z.ZodObject<z.ZodRawShape>,
  },
  {
    name: "selection",
    json: SELECTION_RESPONSE_JSON_SCHEMA as unknown as JsonSchemaLike,
    zod: modelSelectionSchema as unknown as z.ZodObject<z.ZodRawShape>,
  },
] as const;

/**
 * A value that satisfies one JSON Schema property.
 *
 * Small on purpose: the point is to produce something the *provider* would
 * consider valid, so that refusing it proves a disagreement rather than a bad
 * example. Bounds are respected where they are stated.
 */
function sampleFor(spec: Readonly<Record<string, unknown>>): unknown {
  const enumValues = spec["enum"];
  if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues[0];

  switch (spec["type"]) {
    case "string": {
      const pattern = spec["pattern"];
      // A pattern is a promise about shape that a generic sample cannot keep,
      // so the few patterned fields carry their own sample below.
      if (typeof pattern === "string") return undefined;
      const min = typeof spec["minLength"] === "number" ? spec["minLength"] : 1;
      return "x".repeat(Math.max(min, 1));
    }
    case "integer":
    case "number":
      return typeof spec["minimum"] === "number" ? spec["minimum"] : 1;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object": {
      const nested = spec["properties"];
      if (typeof nested !== "object" || nested === null) return {};
      return buildMinimalPayload({
        type: "object",
        properties: nested as JsonSchemaLike["properties"],
        ...(Array.isArray(spec["required"])
          ? { required: spec["required"] as readonly string[] }
          : {}),
      });
    }
    default:
      return undefined;
  }
}

/** Samples for the handful of fields whose shape a pattern, not a type, defines. */
const PATTERNED_SAMPLES: Readonly<Record<string, unknown>> = {
  maxAmountMinor: "300000",
  attribute: "switchType",
  sourceText: "under 3000",
};

/**
 * The smallest payload the provider schema permits: required fields only.
 *
 * This is what a model actually sends when the optional fields are meaningless
 * for the outcome it chose, and it is the exact payload that was being refused.
 */
function buildMinimalPayload(schema: JsonSchemaLike): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const key of schema.required ?? []) {
    const spec = schema.properties[key];
    if (spec === undefined) {
      throw new Error(`${key} is required but has no property definition`);
    }
    const sample = PATTERNED_SAMPLES[key] ?? sampleFor(spec);
    if (sample === undefined) {
      // Refusing loudly rather than omitting the field. Silently skipping it
      // would shrink the payload this file exists to build, and the parity
      // check would then pass by testing less than it claims to.
      throw new Error(
        `no sample could be built for the required field "${key}" ` +
          `(type ${String(spec["type"])}); add one to PATTERNED_SAMPLES`,
      );
    }
    payload[key] = sample;
  }
  return payload;
}

/** The payload with every optional field present and explicitly null. */
function buildNullOptionalPayload(schema: JsonSchemaLike): Record<string, unknown> {
  const payload = buildMinimalPayload(schema);
  for (const [key, spec] of Object.entries(schema.properties)) {
    if ((schema.required ?? []).includes(key)) continue;
    if (spec["nullable"] === true) payload[key] = null;
  }
  return payload;
}

/**
 * The payload with **every** property present, nullable or not.
 *
 * Needed because the null-filled payload above only carries the optional fields
 * the schema marks `nullable`. An optional field that is not nullable would
 * never appear in it, so deleting that field to prove it may be absent would
 * delete nothing and assert nothing.
 */
function buildCompletePayload(schema: JsonSchemaLike): Record<string, unknown> {
  const payload = buildMinimalPayload(schema);
  for (const [key, spec] of Object.entries(schema.properties)) {
    if (key in payload) continue;
    payload[key] =
      spec["nullable"] === true ? null : (PATTERNED_SAMPLES[key] ?? sampleFor(spec));
    if (payload[key] === undefined) delete payload[key];
  }
  return payload;
}

/**
 * Every field of a JSON Schema, including the ones inside nested objects.
 *
 * The intent contract carries its budget as a sub-object, and `sourceText`'s
 * length limit lives in there - the exact kind of bound whose absence caused
 * the first of the three failures this file guards against. A comparison that
 * only walked the top level would have missed it.
 */
function* walkProperties(
  schema: JsonSchemaLike,
  prefix = "",
): Generator<readonly [string, Readonly<Record<string, unknown>>]> {
  for (const [key, spec] of Object.entries(schema.properties)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    yield [path, spec];

    const nested = spec["type"] === "array" ? spec["items"] : spec;
    if (
      typeof nested === "object" &&
      nested !== null &&
      typeof (nested as Record<string, unknown>)["properties"] === "object"
    ) {
      yield* walkProperties(nested as unknown as JsonSchemaLike, path);
    }
  }
}

/**
 * Walks a Zod schema for the bounds it enforces on one field.
 *
 * Read off the schema itself rather than from a hand-kept list, so a bound
 * added in code is compared even if nobody remembers to update a test.
 */
interface ZodBounds {
  readonly maxLength?: number;
  readonly minLength?: number;
  readonly maxItems?: number;
  readonly maximum?: number;
  readonly minimum?: number;
}

/** The schema underneath any nullable / optional / default / transform wrapper. */
function coreDefOf(schema: z.ZodTypeAny): Record<string, unknown> | undefined {
  const def = (schema as unknown as { _zod?: { def?: Record<string, unknown> } })._zod
    ?.def;
  if (def === undefined) return undefined;
  const inner = def["innerType"] ?? def["in"];
  return inner === undefined ? def : coreDefOf(inner as z.ZodTypeAny);
}

/**
 * Every field of a Zod object, by the same dotted path the JSON walker uses.
 *
 * Recurses through nested objects and through an array's element schema, so
 * `hardRequirements.attribute` on one side lines up with
 * `hardRequirements.attribute` on the other.
 */
function* walkZodFields(
  schema: z.ZodTypeAny,
  prefix = "",
): Generator<readonly [string, z.ZodTypeAny]> {
  const def = coreDefOf(schema);
  if (def === undefined) return;

  const shape = def["shape"];
  if (typeof shape === "object" && shape !== null) {
    for (const [key, field] of Object.entries(shape as Record<string, z.ZodTypeAny>)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      yield [path, field];
      yield* walkZodFields(field, path);
    }
    return;
  }

  const element = def["element"];
  if (element !== undefined) yield* walkZodFields(element as z.ZodTypeAny, prefix);
}

function boundsOf(schema: z.ZodTypeAny): ZodBounds {
  const def = coreDefOf(schema);
  if (def === undefined) return {};

  const bounds: Record<string, number> = {};
  const checks = def["checks"];
  const isArray = def["type"] === "array";
  if (!Array.isArray(checks)) return bounds;

  for (const check of checks) {
    const checkDef = (check as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
    if (checkDef === undefined) continue;

    // Length checks carry `minimum`/`maximum`; numeric comparisons carry
    // `value`. Reading only one of the two is how the first version of this
    // helper silently returned nothing for every string and every array, and
    // passed while proving no such thing.
    const lower = checkDef["minimum"] ?? checkDef["value"];
    const upper = checkDef["maximum"] ?? checkDef["value"];

    switch (checkDef["check"]) {
      case "min_length":
      case "min_size":
        if (typeof lower === "number") bounds[isArray ? "minItems" : "minLength"] = lower;
        break;
      case "max_length":
      case "max_size":
        if (typeof upper === "number") bounds[isArray ? "maxItems" : "maxLength"] = upper;
        break;
      case "greater_than":
        if (typeof lower === "number") bounds["minimum"] = lower;
        break;
      case "less_than":
        if (typeof upper === "number") bounds["maximum"] = upper;
        break;
      default:
        break;
    }
  }
  return bounds;
}

describe.each(CONTRACTS)("the $name contract, stated twice", ({ json, zod }) => {
  it("accepts the smallest payload the provider schema permits", () => {
    // The failure this exists for: a model omits every optional field, exactly
    // as the published schema allows, and our own validator refuses it.
    const parsed = zod.safeParse(buildMinimalPayload(json));
    const issues = parsed.success
      ? []
      : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.code}`);
    expect(issues).toEqual([]);
  });

  it("accepts an explicit null wherever the provider schema says nullable", () => {
    // The other flavour of the same payload. A model may say `null` rather than
    // omit, and both must mean the same thing to everything downstream.
    const parsed = zod.safeParse(buildNullOptionalPayload(json));
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });

  it("declares to the provider every bound the validator enforces, at every depth", () => {
    const declared = new Map(walkProperties(json));
    const undeclared: string[] = [];

    for (const [path, zodField] of walkZodFields(zod)) {
      const spec = declared.get(path);
      if (spec === undefined) {
        undeclared.push(`${path}: absent from the provider schema`);
        continue;
      }
      for (const [bound, value] of Object.entries(boundsOf(zodField))) {
        if (spec[bound] !== value) {
          undeclared.push(
            `${path}.${bound}: enforced ${String(value)}, declared ${String(spec[bound] ?? "none")}`,
          );
        }
      }
    }
    expect(undeclared).toEqual([]);
  });

  it("describes exactly the same set of fields, at every depth", () => {
    // Both directions, because both are bugs. A field only Zod knows about is
    // something the model is never asked for and then judged on; a field only
    // the provider schema knows about is something we ask the model to spend
    // tokens producing and then silently drop.
    //
    // This is also what guards the walkers themselves: one that quietly stopped
    // at the top level would leave the bound comparison above inspecting a
    // fraction of the contract while still passing, and the bound behind the
    // first live failure lives one level down.
    const jsonPaths = [...walkProperties(json)].map(([path]) => path).sort();
    const zodPaths = [...walkZodFields(zod)].map(([path]) => path).sort();
    expect(zodPaths).toEqual(jsonPaths);
  });

  it("requires nothing of the model that it was not told is required", () => {
    // Every field the JSON Schema omits from `required` must survive being
    // absent. This is the check that would have caught the selection bug on the
    // day it was written rather than in production.
    //
    // Built from the complete payload rather than the null-filled one: a
    // non-nullable optional field is missing from that payload already, so
    // deleting it would prove nothing at all.
    const optional = Object.keys(json.properties).filter(
      (field) => !(json.required ?? []).includes(field),
    );
    const complete = buildCompletePayload(json);
    expect(optional.every((field) => field in complete)).toBe(true);

    const refused: string[] = [];
    for (const field of optional) {
      const withoutField = { ...complete };
      delete withoutField[field];
      if (!zod.safeParse(withoutField).success) refused.push(field);
    }
    expect(refused).toEqual([]);
  });
});

describe("the bounds themselves are still enforced", () => {
  // Declaring a bound to the provider is not the same as trusting it. Each of
  // these proves the validator still refuses what it always refused - the
  // parity checks above must never be satisfiable by loosening Zod.
  it("still refuses an over-long summary", () => {
    expect(
      modelSelectionSchema.safeParse({
        outcome: "NO_MATCH",
        reasonCodes: [],
        noMatchReasonCodes: [],
        summary: "x".repeat(301),
      }).success,
    ).toBe(false);
  });

  it("still refuses an empty summary", () => {
    expect(
      modelSelectionSchema.safeParse({
        outcome: "NO_MATCH",
        reasonCodes: [],
        noMatchReasonCodes: [],
        summary: "",
      }).success,
    ).toBe(false);
  });

  it("still refuses an over-long product id", () => {
    expect(
      modelSelectionSchema.safeParse({
        outcome: "SELECT",
        selectedProductId: "x".repeat(65),
        reasonCodes: [],
        noMatchReasonCodes: [],
        summary: "A keyboard.",
      }).success,
    ).toBe(false);
  });

  it("still refuses a quantity outside the permitted range", () => {
    for (const quantity of [0, -1, 101, 1.5]) {
      expect(
        modelSelectionSchema.safeParse({
          outcome: "SELECT",
          quantity,
          reasonCodes: [],
          noMatchReasonCodes: [],
          summary: "A keyboard.",
        }).success,
        `quantity ${String(quantity)}`,
      ).toBe(false);
    }
  });

  it("still refuses an unknown reason code", () => {
    expect(
      modelSelectionSchema.safeParse({
        outcome: "SELECT",
        reasonCodes: ["PRICE_LOOKED_FINE"],
        noMatchReasonCodes: [],
        summary: "A keyboard.",
      }).success,
    ).toBe(false);
  });

  it("still refuses more reason codes than the vocabulary allows", () => {
    expect(
      modelSelectionSchema.safeParse({
        outcome: "SELECT",
        reasonCodes: Array.from({ length: 9 }, () => "IN_STOCK"),
        noMatchReasonCodes: [],
        summary: "A keyboard.",
      }).success,
    ).toBe(false);
  });

  it("normalises an absent optional field to null rather than undefined", () => {
    // Downstream code compares with `=== null`. Leaving the field undefined
    // would make every one of those comparisons quietly wrong.
    const parsed = modelSelectionSchema.parse({
      outcome: "NO_MATCH",
      reasonCodes: [],
      noMatchReasonCodes: [],
      summary: "Nothing matched.",
    });
    expect(parsed.selectedProductId).toBeNull();
    expect(parsed.quantity).toBeNull();
    expect(parsed.clarificationQuestion).toBeNull();
  });
});
