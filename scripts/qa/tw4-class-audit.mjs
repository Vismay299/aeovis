#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as parser from "@babel/parser";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const ALLOW_FILE = path.resolve(REPO_ROOT, "scripts/qa/tw4-class-audit.allow.json");

if (!fs.existsSync(ALLOW_FILE)) {
  console.error(`tw4-class-audit allowlist file missing: ${ALLOW_FILE}`);
  process.exit(1);
}

const allowlist = JSON.parse(fs.readFileSync(ALLOW_FILE, "utf8"));

function isAllowed(file, token) {
  return allowlist.some((a) => a.file === file && a.token === token);
}

const PATTERNS = [
  /\b(?:shadow|rounded|blur|backdrop-blur|drop-shadow)(?:-sm)?\b(?!-)/g,
  /\boutline-none\b/g,
  /\bring\b(?!-)/g,
  /\b(?:bg|text|border|divide|placeholder)-opacity-[^\s"'`)]+/g,
  /\bflex-(?:shrink|grow)\b/g,
  /\[--[a-z][^\]]*\]/g,
  /\btransform\b/g,
  /\bspace-[xy]-[^\s"'`)]+/g,
  /\bcontainer\b/g,
];

function checkString(str, lineNum, file, findings) {
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    const matches = str.match(pattern);
    if (matches) {
      for (const token of matches) {
        if (!isAllowed(file, token)) {
          findings.push({ file, line: lineNum, token });
        }
      }
    }
  }
}

function traverse(node, insideTarget, findings, file) {
  if (!node || typeof node !== "object") return;

  let isNowTarget = insideTarget;
  if (node.type === "JSXAttribute" && node.name && node.name.name === "className") {
    isNowTarget = true;
  } else if (
    node.type === "CallExpression" &&
    node.callee &&
    (node.callee.name === "cn" || node.callee.name === "cx" || node.callee.name === "clsx" ||
      node.callee.name === "twMerge" || node.callee.name === "cva")
  ) {
    isNowTarget = true;
  }

  if (isNowTarget) {
    if (node.type === "StringLiteral") {
      checkString(node.value, node.loc?.start?.line || 1, file, findings);
    } else if (node.type === "TemplateElement") {
      const raw = node.value.raw;
      const lines = raw.split("\n");
      const startLine = node.loc?.start?.line || 1;
      for (let i = 0; i < lines.length; i++) {
        checkString(lines[i], startLine + i, file, findings);
      }
    }
  }

  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "comments") continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const child of val) traverse(child, isNowTarget, findings, file);
    } else if (val && typeof val === "object" && val.type) {
      traverse(val, isNowTarget, findings, file);
    }
  }
}

const SCRIPT_EXTS = new Set([".js", ".jsx", ".ts", ".tsx"]);
const SKIP_PREFIXES = ["src/components/ui/", "src/components/app/"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", "coverage"]);

/* Walk src/ on disk rather than asking git: `git ls-files` hides untracked
   files, so a brand-new component could carry v3 classes past this audit. */
function walk(dirAbs, out) {
  for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      walk(abs, out);
    } else if (entry.isFile()) {
      const rel = path.relative(REPO_ROOT, abs).split(path.sep).join("/");
      const ext = path.extname(entry.name);
      if (SCRIPT_EXTS.has(ext) || ext === ".css") out.push(rel);
    }
  }
}

const discovered = [];
walk(path.resolve(REPO_ROOT, "src"), discovered);

const files = discovered
  .filter((f) => !SKIP_PREFIXES.some((p) => f.startsWith(p)))
  .sort();

if (files.length === 0) {
  console.error("tw4-class-audit found no files to scan; refusing to report a clean audit.");
  process.exit(1);
}

const findings = [];
const parseErrors = [];

for (const relFile of files) {
  const absPath = path.resolve(REPO_ROOT, relFile);
  const content = fs.readFileSync(absPath, "utf8");

  /* Stylesheets reach utilities through @apply, which the JS parser cannot
     see; scan those lines directly. */
  if (path.extname(relFile) === ".css") {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("@apply")) checkString(lines[i], i + 1, relFile, findings);
    }
    continue;
  }

  try {
    const ast = parser.parse(content, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
      errorRecovery: false,
    });
    traverse(ast, false, findings, relFile);
  } catch (err) {
    /* A file this audit cannot parse is a file it has not audited. Fail
       rather than fall back to a line scan that reports a clean run. */
    parseErrors.push({ file: relFile, message: err.message });
  }
}

let failed = false;

if (parseErrors.length > 0) {
  for (const e of parseErrors) {
    console.error(`${e.file}: could not parse — ${e.message}`);
  }
  console.error(`\n${parseErrors.length} file(s) could not be parsed; audit is incomplete.`);
  failed = true;
}

if (findings.length > 0) {
  for (const f of findings) {
    console.error(`${f.file}:${f.line}: ${f.token}`);
  }
  console.error(`\n${findings.length} findings found in tw4 class audit.`);
  failed = true;
}

if (failed) process.exit(1);

console.log(`0 findings (${files.length} files scanned)`);
process.exit(0);
