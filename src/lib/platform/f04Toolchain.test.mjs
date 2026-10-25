import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("F04 Toolchain — package.json dependencies, PostCSS, and globals.css entry", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));

  const requiredDeps = {
    react: "19",
    "react-dom": "19",
    tailwindcss: "4",
    "@tailwindcss/postcss": "4",
    "tw-animate-css": "1",
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
  const postcssContent = fs.readFileSync(path.resolve("postcss.config.mjs"), "utf8");
  assert.ok(
    postcssContent.includes("@tailwindcss/postcss"),
    "postcss.config.mjs must configure @tailwindcss/postcss"
  );

  // globals.css starts with @import "tailwindcss";
  const globalsContent = fs.readFileSync(path.resolve("src/app/globals.css"), "utf8");
  assert.ok(
    globalsContent.startsWith('@import "tailwindcss";'),
    'src/app/globals.css must start with @import "tailwindcss";'
  );
});
