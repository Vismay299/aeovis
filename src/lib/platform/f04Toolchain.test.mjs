import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* Anchored to this file, not to process.cwd(), so the guard holds when run
   from a worktree or a subdirectory. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const repoFile = (rel) => path.resolve(REPO_ROOT, rel);

test("F04 Toolchain — package.json dependencies, PostCSS, and globals.css entry", () => {
  const pkg = JSON.parse(fs.readFileSync(repoFile("package.json"), "utf8"));

  const requiredDeps = {
    react: "19",
    "react-dom": "19",
    "@base-ui/react": "1",
    "class-variance-authority": "0",
    clsx: "2",
    "tailwind-merge": "3",
    recharts: "3",
    "react-markdown": "10",
    "remark-gfm": "4",
    "@tanstack/react-query": "5",
    sonner: "2",
  };

  for (const [dep, major] of Object.entries(requiredDeps)) {
    const version = pkg.dependencies[dep];
    assert.ok(version, `Missing dependency: ${dep}`);
    const cleanVer = version.replace(/^[\^~]/, "");
    assert.ok(
      cleanVer.startsWith(major),
      `Expected ${dep} major version ${major}, got ${version}`
    );
  }

  /* Build-time-only toolchain: must be devDependencies, not shipped deps. */
  const requiredDevDeps = {
    tailwindcss: "4",
    "@tailwindcss/postcss": "4",
    "tw-animate-css": "1",
    "@babel/parser": "7",
  };

  for (const [dep, major] of Object.entries(requiredDevDeps)) {
    const version = pkg.devDependencies[dep];
    assert.ok(version, `Missing devDependency: ${dep}`);
    assert.ok(
      version.replace(/^[\^~]/, "").startsWith(major),
      `Expected ${dep} major version ${major}, got ${version}`
    );
    assert.equal(
      pkg.dependencies?.[dep],
      undefined,
      `${dep} is build-time only and must not sit in dependencies`
    );
  }

  // devDependencies
  assert.equal(pkg.devDependencies.sucrase, "3.35.1", "sucrase must be pinned to 3.35.1");
  assert.ok(
    pkg.devDependencies.shadcn && pkg.devDependencies.shadcn.replace(/^[\^~]/, "").startsWith("4"),
    `shadcn must be major version 4, got ${pkg.devDependencies.shadcn}`
  );
  assert.ok(
    pkg.devDependencies["@types/react"] &&
      pkg.devDependencies["@types/react"].replace(/^[\^~]/, "").startsWith("19"),
    `@types/react must be major version 19, got ${pkg.devDependencies["@types/react"]}`
  );
  assert.ok(
    pkg.devDependencies["@types/react-dom"] &&
      pkg.devDependencies["@types/react-dom"].replace(/^[\^~]/, "").startsWith("19"),
    `@types/react-dom must be major version 19, got ${pkg.devDependencies["@types/react-dom"]}`
  );

  // no tailwindcss-animate
  assert.equal(pkg.dependencies?.["tailwindcss-animate"], undefined, "tailwindcss-animate must be removed from dependencies");
  assert.equal(pkg.devDependencies?.["tailwindcss-animate"], undefined, "tailwindcss-animate must not be in devDependencies");

  // postcss.config.mjs
  const postcssContent = fs.readFileSync(repoFile("postcss.config.mjs"), "utf8");
  assert.ok(
    postcssContent.includes("@tailwindcss/postcss"),
    "postcss.config.mjs must configure @tailwindcss/postcss"
  );

  /* globals.css must open the Tailwind 4 entry with auto source detection
     off, and then name every source tree explicitly. Without source(none),
     Tailwind walks the repo and emits utilities for docs fixtures. */
  const globalsContent = fs.readFileSync(repoFile("src/app/globals.css"), "utf8");
  assert.ok(
    globalsContent.startsWith('@import "tailwindcss" source(none);'),
    'src/app/globals.css must start with @import "tailwindcss" source(none);'
  );
  for (const src of [
    "../../src/app",
    "../../src/components",
    "../../src/lib",
    "../../src/middleware.js",
  ]) {
    assert.ok(
      globalsContent.includes(`@source "${src}";`),
      `src/app/globals.css must declare @source "${src}";`
    );
  }
});
