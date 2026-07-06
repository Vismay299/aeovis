import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { judgeDeterministic } from "./judge.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fixturePath = path.join(__dirname, "fixtures", "calibration.json");
const fixtures = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));

console.log(`Running calibration against ${fixtures.length} hand-labeled fixtures...\n`);

let mentionCorrect = 0;
let positionCorrect = 0;
let total = fixtures.length;

let truePositives = 0;
let falsePositives = 0;
let falseNegatives = 0;
let trueNegatives = 0;

const mismatches = [];

fixtures.forEach((f, idx) => {
  const result = judgeDeterministic(f.response, f.brand, f.website || "", f.competitors || []);
  
  const mMatched = result.mentioned === f.expected.mentioned;
  const pMatched = result.position === f.expected.position;
  
  if (mMatched) mentionCorrect++;
  if (pMatched) positionCorrect++;
  
  // Calculate Precision & Recall for Mentions
  if (result.mentioned && f.expected.mentioned) {
    truePositives++;
  } else if (result.mentioned && !f.expected.mentioned) {
    falsePositives++;
  } else if (!result.mentioned && f.expected.mentioned) {
    falseNegatives++;
  } else if (!result.mentioned && !f.expected.mentioned) {
    trueNegatives++;
  }

  if (!mMatched || !pMatched) {
    mismatches.push({
      index: idx + 1,
      brand: f.brand,
      response: f.response.slice(0, 50) + "...",
      expectedMention: f.expected.mentioned,
      actualMention: result.mentioned,
      expectedPos: f.expected.position,
      actualPos: result.position
    });
  }
});

const mentionAccuracy = (mentionCorrect / total) * 100;
const positionAccuracy = (positionCorrect / total) * 100;
const precision = truePositives / ((truePositives + falsePositives) || 1);
const recall = truePositives / ((truePositives + falseNegatives) || 1);
const f1 = (2 * precision * recall) / ((precision + recall) || 1);

console.log("--------------------------------------------------");
console.log("             Calibration Results Summary          ");
console.log("--------------------------------------------------");
console.log(`Total Samples Checked   : ${total}`);
console.log(`Mention Detection Acc   : ${mentionAccuracy.toFixed(1)}% (${mentionCorrect}/${total})`);
console.log(`Position Extraction Acc : ${positionAccuracy.toFixed(1)}% (${positionCorrect}/${total})`);
console.log(`Mention Precision       : ${(precision * 100).toFixed(1)}%`);
console.log(`Mention Recall          : ${(recall * 100).toFixed(1)}%`);
console.log(`Mention F1-Score        : ${(f1 * 100).toFixed(1)}%`);
console.log("--------------------------------------------------");

if (mismatches.length > 0) {
  console.log("\nMismatches Found:");
  mismatches.forEach(m => {
    console.log(`\nCase #${m.index} (Brand: ${m.brand})`);
    console.log(`Text: "${m.response}"`);
    if (m.expectedMention !== m.actualMention) {
      console.log(`  Mention mismatch  : Expected ${m.expectedMention}, Got ${m.actualMention}`);
    }
    if (m.expectedPos !== m.actualPos) {
      console.log(`  Position mismatch : Expected "${m.expectedPos}", Got "${m.actualPos}"`);
    }
  });
} else {
  console.log("\nPerfect match! Zero mismatches.");
}

console.log("");

if (mentionAccuracy < 90 || positionAccuracy < 90) {
  console.error("❌ Calibration failed! Accuracy is below target (90%).");
  process.exit(1);
} else {
  console.log("✅ Calibration successful! High-accuracy judge matches expectations.");
  process.exit(0);
}
