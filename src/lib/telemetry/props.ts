// F26 property primitives for the product-analytics event registry.
import { z } from "zod";

// Numbers clamp rather than fail: one out-of-range value must never drop a whole event.
const clampInt = (max: number) => (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.round(v), 0), max) : v;
const clampNum = (max: number) => (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(v, 0), max) : v;
export const count = z.preprocess(clampInt(10_000_000), z.int().min(0).max(10_000_000));
export const usd = z.preprocess(clampNum(100_000), z.number().min(0).max(100_000));
export const flag = z.boolean();
export const durationMs = z.preprocess(clampInt(3_600_000), z.int().min(0).max(3_600_000));
// `code` carries closed vocabularies only: spend and quote action keys (`ai_visibility.scan.run`,
// `local.grid.run`, `questions.setup.run`), `TOOL_NAMES`, skill names, template ids, error codes and
// model ids. It must NOT guess at hostnames by shape: a dotted action key is shaped exactly like
// one, and a `^label(\.label)*\.[a-z]{2,}$` refine rejects every F09 action key, which would drop
// the whole `price:*` family. An address is caught by its `@`, a host by its public suffix.
export const PUBLIC_SUFFIXES = ["com","net","org","io","co","in","ai","app","dev","me","info",
  "biz","uk","us","de","fr","nl","au","ca","test","example","invalid","localhost","local"] as const;
export const code = z.string().regex(/^[A-Za-z0-9_.:\/-]{1,64}$/)
  .refine((v) => !v.includes("@"), "looks like an email address")
  .refine((v) => !(v.includes(".")
    && (PUBLIC_SUFFIXES as readonly string[]).includes((v.split(".").pop() ?? "").toLowerCase())),
    "looks like a hostname");
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
