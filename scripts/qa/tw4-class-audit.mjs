#!/usr/bin/env node
import { execSync } from "node:child_process";
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
    (node.callee.name === "cn" || node.callee.name === "cx")
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

// Get files from git ls-files anchored at REPO_ROOT
const rawFiles = execSync("git ls-files 'src/**/*.js' 'src/**/*.jsx' 'src/**/*.ts' 'src/**/*.tsx'", {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).trim().split("\n").filter(Boolean);

const files = rawFiles.filter(
  (f) => !f.startsWith("src/components/ui/") && !f.startsWith("src/components/app/")
);

const findings = [];

for (const relFile of files) {
  const absPath = path.resolve(REPO_ROOT, relFile);
  if (!fs.existsSync(absPath)) continue;
  const content = fs.readFileSync(absPath, "utf8");

  try {
    const ast = parser.parse(content, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
    });
    traverse(ast, false, findings, relFile);
  } catch (err) {
    // Resilient fallback for any non-standard syntax
    const lines = content.split("\n");
    let inClassAttr = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/className\s*=|(?:\bcn|\bcx)\s*\(/.test(line)) {
        inClassAttr = true;
      }
      if (inClassAttr) {
        checkString(line, i + 1, relFile, findings);
        if (/["'`]\s*\}?/.test(line) && !line.endsWith("\\")) {
          inClassAttr = false;
        }
      }
    }
  }
}

if (findings.length > 0) {
  for (const f of findings) {
    console.error(`${f.file}:${f.line}: ${f.token}`);
  }
  console.error(`\n${findings.length} findings found in tw4 class audit.`);
  process.exit(1);
} else {
  console.log("0 findings");
  process.exit(0);
}
