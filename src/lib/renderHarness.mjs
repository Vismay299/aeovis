/**
 * R6.4.11 — shared component-render harness.
 *
 * Every UI guard in this repo was a readFileSync text scan: the pattern in
 * degradedEngineBanner.test.mjs, landingHonesty.test.mjs, and
 * crawlabilityRivalOutcome.test.mjs. An inverted ternary in CrawlabilityView.jsx
 * made ALL EIGHT text-scan TESTS STILL PASS, because the guard checked the
 * import, the const, the rendered label, the rendered detail, data-outcome and
 * the whole-row prop, and an inverted ternary preserves every one of them.
 *
 * This module extracts the inline harness that engineSetChangeSurface.test.mjs
 * built (sucrase + react-dom/server) into a shared module any test can import.
 *
 * STUBBING DEFAULT: FAIL, not silent.  An import the caller has not explicitly
 * resolved throws, because a catch-all that returns an empty object is exactly
 * how a UI guard passes while the component is broken.
 *
 * DEPENDENCIES: react, react-dom, sucrase — all already in node_modules.
 * No new runtime deps.
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "sucrase";
import { readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Stub shapes
// ---------------------------------------------------------------------------

/**
 * A component that renders nothing. For icon libraries (lucide-react) and
 * any import where the test does not exercise the rendered output of that
 * subtree.
 */
export function nullComponent() {
  return null;
}

/**
 * Proxy that returns `nullComponent` for any named export. Import this when
 * the module's exports are all components you want to stub out (e.g. icon
 * sets, sidebar wrappers).
 */
export const anyNamedExport = new Proxy(
  { __esModule: true },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      return nullComponent;
    },
  }
);

/**
 * A component that renders only its children — no wrapper markup. Use this
 * for layout-only stubs (Card, Badge, Alert, etc.) when the test asserts
 * text content and data attributes, not the wrapper's styling.
 */
export function passThrough(props) {
  return props.children || null;
}

/**
 * Proxy that returns `passThrough` for any named export. Stubs out a
 * component library transparently: every component renders its children
 * without adding markup.
 */
export const passThroughExports = new Proxy(
  { __esModule: true, default: passThrough },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      return passThrough;
    },
  }
);

// ---------------------------------------------------------------------------
// useEffect shim
// ---------------------------------------------------------------------------

/**
 * A useEffect that runs synchronously during render, deps-aware.
 *
 * react-dom/server never runs effects, so a component that fills state from
 * an effect would only ever produce its loading skeleton. Calling the effect
 * during render turns its setState into a render-phase update, which React
 * re-runs the component for. The deps check is what stops that being an
 * infinite loop.
 *
 * This IS a deviation from browser behaviour. It changes WHEN the component's
 * own code runs, never WHAT it computes.
 */
export function makeUseEffectShim() {
  return function useEffectShim(fn, deps) {
    const ref = React.useRef(undefined);
    const prev = ref.current;
    const changed =
      prev === undefined ||
      deps === undefined ||
      prev.deps === undefined ||
      prev.deps.length !== deps.length ||
      deps.some((d, i) => !Object.is(d, prev.deps[i]));
    if (!changed || (prev !== undefined && deps === undefined)) return;
    ref.current = { deps };
    fn();
  };
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags so an assertion about wording is not defeated by markup.
 */
export function textOf(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Compile + evaluate
// ---------------------------------------------------------------------------

/**
 * Compile a JSX file with sucrase and evaluate it as a CommonJS module.
 *
 * @param {string} filePath  Absolute path to the .jsx file.
 * @param {object} opts
 * @param {Map<string,object>} opts.modules   Specifier → exports.  The ONLY
 *     way to resolve an import — nothing is guessed.
 * @param {string[]} [opts.autoStub]   Import prefixes resolved to
 *     `passThroughExports` (transparent children-only stubs).  Use for
 *     component libraries whose rendered output the test does not assert.
 * @param {string[]} [opts.autoNull]   Import prefixes resolved to
 *     `anyNamedExport` (null stubs).  Use for icon sets.
 * @param {boolean}  [opts.shimUseEffect]  Patch React.useEffect to run
 *     synchronously during render.  Required when the component fills state
 *     from an effect.
 * @param {string[]} [opts.exposeInternals]  Module-scope function names to
 *     add to `module.exports` so the test can render them directly.  Useful
 *     for non-exported sub-components (e.g. RivalCrawlRow inside
 *     CrawlabilityView).
 * @returns {Promise<object>} The module.exports of the compiled module.
 */
export async function compileJsx(filePath, opts = {}) {
  const source = await readFile(filePath, "utf8");
  const { code: compiledCode } = transform(source, {
    transforms: ["jsx", "imports"],
    jsxPragma: "React.createElement",
    jsxFragmentPragma: "React.Fragment",
    filePath,
  });

  let code = compiledCode;

  // Append internal function exports if requested.  These are module-scope
  // function declarations that sucrase leaves as-is; the appended assignment
  // makes them accessible to the test without modifying the source file.
  if (opts.exposeInternals && opts.exposeInternals.length > 0) {
    for (const name of opts.exposeInternals) {
      code += `\nif (typeof ${name} !== "undefined") module.exports.${name} = ${name};`;
    }
  }

  const modules = opts.modules || new Map();
  const autoStub = opts.autoStub || [];
  const autoNull = opts.autoNull || [];

  const requireShim = (specifier) => {
    if (modules.has(specifier)) return modules.get(specifier);
    for (const prefix of autoStub) {
      if (specifier.startsWith(prefix)) return passThroughExports;
    }
    for (const prefix of autoNull) {
      if (specifier.startsWith(prefix)) return anyNamedExport;
    }
    // Loud, not silent: an import this harness has not been told about would
    // otherwise resolve to an empty object and quietly render less than the
    // component does.
    throw new Error(
      `Component imports "${specifier}", which this render harness does not resolve. ` +
        `Add it to the modules map (real module) or to autoStub / autoNull, deliberately.`
    );
  };

  let reactModule = modules.get("react") || React;
  if (opts.shimUseEffect) {
    reactModule = { ...reactModule, useEffect: makeUseEffectShim(), __esModule: true };
    reactModule.default = reactModule;
  }

  const moduleRecord = { exports: {} };
  // eslint-disable-next-line no-new-func
  const factory = new Function("require", "module", "exports", "React", code);
  factory(requireShim, moduleRecord, moduleRecord.exports, reactModule);

  return moduleRecord.exports;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * Render a React component to static HTML markup.
 *
 * @param {Function} Component  A React function component.
 * @param {object}   [props]    Props to pass.
 * @returns {string} The rendered HTML string.
 */
export function renderToHtml(Component, props = {}) {
  return renderToStaticMarkup(React.createElement(Component, props));
}
