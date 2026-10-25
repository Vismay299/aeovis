// F26 property primitives for the product-analytics event registry.
import { z } from "zod";

export const count = z.int().min(0).max(10_000_000);
export const usd = z.number().min(0).max(100_000);
export const flag = z.boolean();
export const durationMs = z.int().min(0).max(3_600_000);
export const code = z
  .string()
  .regex(/^[A-Za-z0-9_.:/-]{1,64}$/)
  .refine(
    (v) => !/@/.test(v) && !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(v),
    "looks like an email or hostname",
  );
export const codes = z.array(code).max(20);
export const oneOf = <T extends readonly [string, ...string[]]>(v: T) => z.enum(v);

/** Fifteen property names that must never appear on a registry event (F26-AC-01). */
export const FORBIDDEN_PROP_KEYS = [
  "brand_key",
  "brand",
  "domain",
  "url",
  "email",
  "name",
  "title",
  "text",
  "query",
  "question",
  "answer",
  "prompt",
  "keyword",
  "message",
  "website",
] as const;
