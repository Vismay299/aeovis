import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ALLOW_FILE = path.resolve("scripts/qa/tw4-class-audit.allow.json");
let allowlist = [];
if (fs.existsSync(ALLOW_FILE)) {
  allowlist = JSON.parse(fs.readFileSync(ALLOW_FILE, "utf8"));
}

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

// Get files from git ls-files
const rawFiles = execSync("git ls-files 'src/**/*.js' 'src/**/*.jsx' 'src/**/*.ts' 'src/**/*.tsx'", {
  encoding: "utf8",
}).trim().split("\n").filter(Boolean);

const files = rawFiles.filter(
  (f) => !f.startsWith("src/components/ui/") && !f.startsWith("src/components/app/")
);

const findings = [];

// Regex to extract candidate strings inside className="..." or className={`...`} or cx(...) or cn(...)
// We can scan lines or use a regex over the file content while tracking line numbers.
for (const relFile of files) {
  if (!fs.existsSync(relFile)) continue;
  const content = fs.readFileSync(relFile, "utf8");
  const lines = content.split("\n");

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const lineNum = lineIndex + 1;

    // We check if line contains className= or cn( or cx(
    // Or we extract all string literals on lines that have className, cn, cx
    const isTargetLine = /className\s*=|(?:\bcn|\bcx)\s*\(/.test(line);
    if (!isTargetLine) continue;

    // Check string literals in line
    const stringMatches = line.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g);
    for (const sm of stringMatches) {
      const strVal = sm[2];
      for (const pattern of PATTERNS) {
        pattern.lastIndex = 0;
        const matches = strVal.match(pattern);
        if (matches) {
          for (const token of matches) {
            if (!isAllowed(relFile, token)) {
              findings.push({ file: relFile, line: lineNum, token });
            }
          }
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
