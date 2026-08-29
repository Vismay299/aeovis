/**
 * Module-resolution hooks so node:test can import the REAL worker route
 * handlers (the scan and content worker route.js files) and observe the
 * response they actually return, instead of inferring it from the gate's
 * return value.
 *
 * Two specifiers in those routes are resolved by Next's bundler, not by Node:
 *
 *   1. `@/lib/...` — the jsconfig.json path alias (`"@/*": ["./src/*"]`).
 *      Rewritten here to a real file URL under src/, with the same extension
 *      probing the bundler does.
 *   2. `next/server` — the installed package ships `next/server.js` but has no
 *      ESM exports entry for the extensionless form, so Node refuses it while
 *      webpack accepts it. Rewritten to `next/server.js`, i.e. the SAME real
 *      module: NextResponse here is Next's own, not a stand-in.
 *
 * Nothing under test is replaced. No module is stubbed, mocked or shadowed —
 * these hooks only answer "which file is this specifier", which is the one
 * thing the bundler would otherwise have answered. If this file ever starts
 * substituting behaviour, the route test stops being evidence.
 *
 * Consumed by cronAuth.route.test.mjs via node:module register().
 */
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// .../src/  — this file lives at src/lib/cronAuth.route.hooks.mjs
const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function firstExistingFile(candidates) {
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not this one; keep probing
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const base = path.join(SRC_DIR, specifier.slice(2));
    const hit = firstExistingFile([
      base,
      `${base}.js`,
      `${base}.mjs`,
      path.join(base, "index.js"),
    ]);
    if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
  }
  if (specifier === "next/server") return nextResolve("next/server.js", context);
  return nextResolve(specifier, context);
}
