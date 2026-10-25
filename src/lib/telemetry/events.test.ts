import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { FORBIDDEN_PROP_KEYS, code } from "./props.ts";
import {
  EVENT_REGISTRY_COUNT,
  EVENTS,
  validateEventProps,
  type EventName,
} from "./events.ts";

const NAME_RE = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/;

function walkLeaves(schema: z.ZodType, path: string, visit: (leaf: z.ZodType, path: string) => void): void {
  const anySchema = schema as unknown as {
    type?: string;
    shape?: Record<string, z.ZodType> | (() => Record<string, z.ZodType>);
    def?: { type?: string; shape?: Record<string, z.ZodType> | (() => Record<string, z.ZodType>); innerType?: z.ZodType; element?: z.ZodType };
    _def?: { type?: string; shape?: Record<string, z.ZodType> | (() => Record<string, z.ZodType>); innerType?: z.ZodType; element?: z.ZodType };
    element?: z.ZodType;
    unwrap?: () => z.ZodType;
    constructor?: { name?: string };
  };
  const def = anySchema._def ?? anySchema.def;
  const typeName = anySchema.type ?? def?.type ?? anySchema.constructor?.name ?? "";

  const rawShape = anySchema.shape ?? def?.shape;
  const shape =
    typeof rawShape === "function"
      ? rawShape()
      : rawShape && typeof rawShape === "object"
        ? rawShape
        : null;
  if (shape && typeof shape === "object") {
    for (const [key, child] of Object.entries(shape)) {
      walkLeaves(child as z.ZodType, path ? `${path}.${key}` : key, visit);
    }
    return;
  }

  const inner = def?.innerType ?? anySchema.unwrap?.() ?? null;
  if (inner && (typeName.includes("optional") || typeName.includes("nullable") || typeName === "optional" || typeName === "nullable")) {
    walkLeaves(inner, path, visit);
    return;
  }

  const el = anySchema.element ?? def?.element ?? null;
  if (el) {
    walkLeaves(el, `${path}[]`, visit);
    return;
  }

  visit(schema, path);
}

function isCodeLeaf(leaf: z.ZodType): boolean {
  // Accept our `code` brand by successfully parsing known-good values and refusing host/email.
  const sampleOk = leaf.safeParse("site_audit.run");
  const sampleHost = leaf.safeParse("snitch.com");
  const sampleEmail = leaf.safeParse("a@b.test");
  if (sampleOk.success && !sampleHost.success && !sampleEmail.success) return true;
  // enums and literals are fine string leaves
  const enumOk = leaf.safeParse;
  try {
    // z.enum accepts only its values; a random string fails
    const r = leaf.safeParse("__not_an_enum_value__");
    if (!r.success) {
      // could still be plain string - plain z.string would accept it
      const plain = leaf.safeParse("hello world with spaces!!!");
      if (!plain.success) return true; // constrained string (enum/literal/code)
    }
  } catch {
    /* ignore */
  }
  // boolean/number leaves are not strings
  if (leaf.safeParse(true).success || leaf.safeParse(1).success) return true;
  return false;
}

test("F26-AC-01 every event name matches area:action", () => {
  for (const name of Object.keys(EVENTS)) {
    assert.match(name, NAME_RE, name);
  }
});

test("F26-AC-01 every props schema is a strict object", () => {
  for (const [name, spec] of Object.entries(EVENTS)) {
    const extra = spec.props.safeParse({ __unexpected__: 1 });
    assert.equal(extra.success, false, `${name} must reject unknown keys`);
  }
});

test("F26-AC-01 no forbidden property keys and string leaves are code/enum/literal", () => {
  for (const [name, spec] of Object.entries(EVENTS)) {
    const anyProps = spec.props as unknown as { shape?: Record<string, z.ZodType> };
    const shape = anyProps.shape;
    assert.ok(shape, `${name} missing shape`);
    for (const key of Object.keys(shape)) {
      assert.equal(
        (FORBIDDEN_PROP_KEYS as readonly string[]).includes(key),
        false,
        `${name} has forbidden key ${key}`,
      );
    }
    walkLeaves(spec.props, "", (leaf, path) => {
      // skip the object root
      if (!path) return;
      const acceptsString = leaf.safeParse("x").success || leaf.safeParse("site_audit.run").success || leaf.safeParse("7d").success;
      const acceptsNumber = leaf.safeParse(1).success;
      const acceptsBool = leaf.safeParse(true).success;
      if (acceptsString && !acceptsNumber && !acceptsBool) {
        assert.equal(isCodeLeaf(leaf), true, `${name}.${path} plain ZodString leaf`);
      }
    });
  }
});

test("F26-AC-01 registry count equals the table", () => {
  assert.equal(Object.keys(EVENTS).length, EVENT_REGISTRY_COUNT);
  assert.equal(EVENT_REGISTRY_COUNT, 143);
});

test("F26-AC-02 validateEventProps rejects unknown names and bad props", () => {
  assert.deepEqual(validateEventProps("nope:event", {}), { ok: false, reason: "unknown_event" });
  assert.equal(validateEventProps("usage:page_viewed", { range: "7d", extra: 1 }).ok, false);
  assert.equal(validateEventProps("usage:page_viewed", { range: 7 }).ok, false);
  assert.equal(validateEventProps("tool:call", {
    tool: "site_audit.run",
    source: "assistant",
    success: true,
    error_code: null,
    duration_ms: 12,
    output_invalid: false,
    truncated: false,
  }).ok, true);
});

test("F26-AC-02 code type rejects hostnames and emails, accepts model and action codes", () => {
  assert.equal(code.safeParse("snitch.com").success, false);
  assert.equal(code.safeParse("a@b.test").success, false);
  assert.equal(code.safeParse("anthropic/claude-sonnet-4.5").success, true);
  assert.equal(code.safeParse("site_audit.run").success, true);
  assert.equal(code.safeParse("1.2").success, true);
});

test("empty-props events accept {}", () => {
  const name = "scan_report:cost_expanded" as EventName;
  assert.equal(validateEventProps(name, {}).ok, true);
});
