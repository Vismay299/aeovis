/**
 * Round 2: Targeted mutation tests — fixing incorrect test file mappings
 * and adding more surgical mutations for the gaps found in Round 1.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const MUTATIONS = [
  // =================================================================
  // FIX: DB-004/DB-005 from Round 1 used wrong test file
  // =================================================================
  {
    id: 'DB-004-R2',
    file: 'src/lib/duplicateScan.js',
    name: 'Remove duplicate scan violation detection',
    mutate: (content) => content.replace(
      /export function isDuplicateScanViolation\(error\) \{[\s\S]*?return haystack\.includes\(DUPLICATE_SCAN_INDEX\);\n\}/,
      'export function isDuplicateScanViolation(error) { return false; }'
    ),
    test: 'src/lib/duplicateScan.test.mjs',
    expected: 'fail',
    severity: 'critical',
    description: 'Never detects duplicate scan violations (correct test file)'
  },
  {
    id: 'DB-005-R2',
    file: 'src/lib/duplicateScan.js',
    name: 'Always reject duplicate scans',
    mutate: (content) => content.replace(
      /return \{ action: "reclaim", liveJobId: null, deadJobIds: jobs\.map\(\(j\) => j\.id\)\.filter\(Boolean\) \};/,
      'return { action: "reject", liveJobId: null, deadJobIds: [] };'
    ),
    test: 'src/lib/duplicateScan.test.mjs',
    expected: 'fail',
    severity: 'high',
    description: 'Always rejects scans even when blocking jobs are dead'
  },
  // =================================================================
  // FIX: SSRF-006 — test the MAX_REDIRECTS boundary with redirect tests
  // =================================================================
  {
    id: 'SSRF-006-R2',
    file: 'src/lib/ssrfGuard.js',
    name: 'Remove MAX_REDIRECTS limit',
    mutate: (content) => content.replace(
      /export const MAX_REDIRECTS = 5;/,
      'export const MAX_REDIRECTS = 500;'
    ),
    test: 'src/lib/ssrfGuard.test.mjs',
    expected: 'fail',
    severity: 'high',
    description: 'Raises MAX_REDIRECTS to 500 (still caught if tests assert the value)'
  },
  // =================================================================
  // Scoring: Precision mutation
  // =================================================================
  {
    id: 'SCORE-005-R2',
    file: 'src/lib/scoring/computeVisibilityScore.js',
    name: 'Break score rounding (truncate instead of round)',
    mutate: (content) => content.replace(
      /return Math\.round\(mentionVisibility \* 10\) \/ 10;/,
      'return Math.floor(mentionVisibility * 10) / 10;'
    ),
    test: 'src/lib/scoring/computeVisibilityScore.test.mjs',
    expected: 'fail',
    severity: 'medium',
    description: 'Truncates instead of rounding visibility score'
  },
  // =================================================================
  // NEW MUTATIONS: SSRF guard — deeper mutations
  // =================================================================
  {
    id: 'SSRF-009',
    file: 'src/lib/ssrfGuard.js',
    name: 'Invert blocked address classification',
    mutate: (content) => content.replace(
      /if \(\(\(value >>> 0\) & mask\) === \(\(block\.base >>> 0\) & mask\)\) \{/,
      'if (((value >>> 0) & mask) !== ((block.base >>> 0) & mask)) {'
    ),
    test: 'src/lib/ssrfGuard.test.mjs',
    expected: 'fail',
    severity: 'critical',
    description: 'Inverts the IPv4 block matching — allows private, blocks public'
  },
  {
    id: 'SSRF-010',
    file: 'src/lib/ssrfGuard.js',
    name: 'Remove DNS lookup failure handling',
    mutate: (content) => content.replace(
      /export async function assertPublicUrl\(raw, deps = \{\}\) \{[\s\S]*?return \{ url, hostname: host, addresses: list, literal: false \};\n\}/,
      `export async function assertPublicUrl(raw, deps = {}) {
  const url = normalizeTargetUrl(raw);
  const host = bareHostname(url);
  return { url, hostname: host, addresses: [], literal: false };
}`
    ),
    test: 'src/lib/ssrfGuard.test.mjs',
    expected: 'fail',
    severity: 'critical',
    description: 'Skips all DNS validation — allows any hostname'
  },
  {
    id: 'SSRF-011',
    file: 'src/lib/ssrfGuard.js',
    name: 'Remove ipv6InPrefix check',
    mutate: (content) => content.replace(
      /function ipv6InPrefix\(groups, block\) \{[\s\S]*?return true;\n\}/,
      'function ipv6InPrefix(groups, block) { return false; }'
    ),
    test: 'src/lib/ssrfGuard.test.mjs',
    expected: 'fail',
    severity: 'high',
    description: 'IPv6 prefix check always returns false (no IPv6 addresses blocked)'
  },
  // =================================================================
  // NEW MUTATIONS: Rate limit — deeper mutations
  // =================================================================
  {
    id: 'RL-006',
    file: 'src/lib/rateLimit.js',
    name: 'Invert allowed decision in evaluate()',
    mutate: (content) => content.replace(
      /const allowed = hits <= limit;/,
      'const allowed = hits >= limit;'
    ),
    test: 'src/lib/rateLimit.test.mjs',
    expected: 'fail',
    severity: 'critical',
    description: 'Allows requests over limit, refuses requests under limit'
  },
  {
    id: 'RL-007',
    file: 'src/lib/rateLimit.js',
    name: 'Remove window boundary calculation',
    mutate: (content) => content.replace(
      /export function windowStart\(nowMs, windowMs\) \{[\s\S]*?return new Date\(Math\.floor\(nowMs \/ windowMs\) \* windowMs\)\.toISOString\(\);\n\}/,
      'export function windowStart(nowMs, windowMs) { return new Date(0).toISOString(); }'
    ),
    test: 'src/lib/rateLimit.test.mjs',
    expected: 'fail',
    severity: 'high',
    description: 'All requests share the same window start (broken windowed limiting)'
  },
  {
    id: 'RL-008',
    file: 'src/lib/rateLimit.js',
    name: 'Break retryAfterSec calculation',
    mutate: (content) => content.replace(
      /retryAfterSec: Math\.max\(1, Math\.ceil\(\(resetMs - nowMs\) \/ 1000\)\),/,
      'retryAfterSec: 0,'
    ),
    test: 'src/lib/rateLimit.test.mjs',
    expected: 'fail',
    severity: 'medium',
    description: 'Always reports retryAfterSec as 0'
  },
  // =================================================================
  // NEW MUTATIONS: Scoring engine — deeper mutations
  // =================================================================
  {
    id: 'SCORE-009',
    file: 'src/lib/scoring/computeVisibilityScore.js',
    name: 'Swap position and sentiment weights',
    mutate: (content) => content.replace(
      /let score = posWeight \* sentWeight;/,
      'let score = posWeight + sentWeight;'
    ),
    test: 'src/lib/scoring/computeVisibilityScore.test.mjs',
    expected: 'fail',
    severity: 'high',
    description: 'Adds weights instead of multiplying (different formula)'
  },
  {
    id: 'SCORE-010',
    file: 'src/lib/scoring/computeVisibilityScore.js',
    name: 'Remove empty results check',
    mutate: (content) => content.replace(
      /if \(!results \|\| results\.length === 0\) \{\n\s+return 0\.0;\n\s+\}/,
      '// empty check removed'
    ),
    test: 'src/lib/scoring/computeVisibilityScore.test.mjs',
    expected: 'fail',
    severity: 'medium',
    description: 'Does not return 0 for empty results (may return NaN)'
  },
  {
    id: 'SCORE-011',
    file: 'src/lib/scoring/constants.js',
    name: 'Change positive position weight from 1.0 to 0.0',
    mutate: (content) => content.replace(
      /recommended: 1\.0,/,
      'recommended: 0.0,'
    ),
    test: 'src/lib/scoring/computeVisibilityScore.test.mjs',
    expected: 'fail',
    severity: 'critical',
    description: 'Recommended position scores as 0 (most important position ignored)'
  },
  {
    id: 'SCORE-012',
    file: 'src/lib/scoring/constants.js',
    name: 'Change sentiment neutral weight from 0.5 to 1.0',
    mutate: (content) => content.replace(
      /neutral: 0\.5,/,
      'neutral: 1.0,'
    ),
    test: 'src/lib/scoring/computeVisibilityScore.test.mjs',
    expected: 'fail',
    severity: 'medium',
    description: 'Neutral sentiment scored same as positive (inflates scores)'
  },
  // =================================================================
  // NEW MUTATIONS: Database — deeper mutations
  // =================================================================
  {
    id: 'DB-007',
    file: 'src/lib/db.js',
    name: 'Remove scan write error throwing',
    mutate: (content) => content.replace(
      /throw new ScanWriteError\(\s+`Could not write the scan for "\$\{scanRecord\?\.\brand ?? "unknown brand"\}\": \$\{\s+error\.message \|\| error\.code \|\| "unknown database error"\s+\}\$\{\s+mismatch[\s\S]*?\}\),\s+\{ cause: error, code: mismatch \? "db_schema_mismatch" : "db_write_failed" \}\s+\);/,
      'return null;'
    ),
    test: 'src/lib/db.test.mjs',
    expected: 'fail',
    severity: 'critical',
    description: 'Returns null instead of throwing on write error (silent failure)'
  },
  {
    id: 'DB-008',
    file: 'src/lib/db.js',
    name: 'Remove deduplication in joinScanIdentities',
    mutate: (content) => content.replace(
      /const seen = new Set\(\);[\s\S]*?deduplicated\.push\(scan\);[\s\S]*?\}/,
      'const seen = new Set();\n  deduplicated.push(...(brandScans || []), ...(domainScans || []));'
    ),
    test: 'src/lib/db.test.mjs',
    expected: 'fail',
    severity: 'medium',
    description: 'Removes deduplication (allows duplicate scan records)'
  },
  {
    id: 'DB-009',
    file: 'src/lib/db.js',
    name: 'Remove sort in joinScanIdentities',
    mutate: (content) => content.replace(
      /return deduplicated\.sort\(\(a, b\) => \{[\s\S]*?return timeB - timeA;\n\s+\}\);/,
      'return deduplicated;'
    ),
    test: 'src/lib/db.test.mjs',
    expected: 'fail',
    severity: 'low',
    description: 'Removes sort order from joined scan identities'
  },
];

// Test runner (same as Round 1)
async function runMutationTest(mutation) {
  const filePath = join(ROOT, mutation.file);
  const originalContent = await readFile(filePath, 'utf-8');
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(`MUTATION: ${mutation.id} - ${mutation.name}`);
  console.log(`File: ${mutation.file}`);
  console.log(`Severity: ${mutation.severity.toUpperCase()}`);
  console.log(`${'='.repeat(70)}`);
  
  // Apply mutation
  const mutatedContent = mutation.mutate(originalContent);
  if (mutatedContent === originalContent) {
    console.log('⚠️  Mutation did not change the file - SKIP');
    return { ...mutation, result: 'skip', reason: 'mutation_noop' };
  }
  
  await writeFile(filePath, mutatedContent, 'utf-8');
  console.log('✓ Mutation applied');
  
  // Run tests
  let testResult;
  try {
    console.log(`Running: ${mutation.test}`);
    const output = execSync(
      `node --import ./src/lib/liveWriteGuardAuto.mjs --test "${mutation.test}"`,
      { 
        cwd: ROOT, 
        encoding: 'utf-8',
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );
    testResult = { passed: true, output };
    console.log('✓ Tests PASSED (mutation NOT caught)');
  } catch (error) {
    testResult = { passed: false, output: error.stdout || error.stderr || error.message };
    console.log('✗ Tests FAILED (mutation caught!)');
  }
  
  // Restore original
  await writeFile(filePath, originalContent, 'utf-8');
  console.log('✓ Original code restored');
  
  const caught = testResult.passed !== (mutation.expected === 'fail');
  return {
    ...mutation,
    result: caught ? 'caught' : 'missed',
    testPassed: testResult.passed,
    output: testResult.output?.slice(0, 500)
  };
}

async function main() {
  console.log('🧬 Round 2: Targeted Mutation Tests');
  console.log(`Testing ${MUTATIONS.length} mutations\n`);
  
  const results = [];
  for (const mutation of MUTATIONS) {
    try {
      const result = await runMutationTest(mutation);
      results.push(result);
    } catch (error) {
      console.error(`Error testing ${mutation.id}:`, error.message);
      results.push({ ...mutation, result: 'error', error: error.message });
    }
  }
  
  // Report
  console.log('\n\n' + '='.repeat(70));
  console.log('📊 ROUND 2 MUTATION TESTING REPORT');
  console.log('='.repeat(70));
  
  const caught = results.filter(r => r.result === 'caught');
  const missed = results.filter(r => r.result === 'missed');
  const skipped = results.filter(r => r.result === 'skip');
  
  console.log(`\nTotal: ${MUTATIONS.length} | Caught: ${caught.length} | Missed: ${missed.length} | Skipped: ${skipped.length}`);
  const mutationScore = ((caught.length / Math.max(1, MUTATIONS.length - skipped.length)) * 100).toFixed(1);
  console.log(`Mutation Score: ${mutationScore}%`);
  
  if (missed.length > 0) {
    console.log('\n🚨 MISSED:');
    for (const m of missed) {
      console.log(`  ${m.id} (${m.severity.toUpperCase()}): ${m.name} [${m.file}]`);
    }
  }
  
  if (caught.length > 0) {
    console.log('\n✅ CAUGHT:');
    for (const m of caught) {
      console.log(`  ${m.id} (${m.severity.toUpperCase()}): ${m.name}`);
    }
  }
  
  // Write report
  const report = {
    timestamp: new Date().toISOString(),
    round: 2,
    summary: { total: MUTATIONS.length, caught: caught.length, missed: missed.length, skipped: skipped.length, mutationScore: `${mutationScore}%` },
    results: results.map(r => ({ id: r.id, file: r.file, name: r.name, severity: r.severity, result: r.result, description: r.description })),
    missedDetails: missed.map(m => ({ id: m.id, file: m.file, name: m.name, severity: m.severity, description: m.description }))
  };
  
  await writeFile(
    join(ROOT, 'test_reports', `mutation-test-round2-${Date.now()}.json`),
    JSON.stringify(report, null, 2)
  );
  
  console.log('\nReport saved to test_reports/');
  process.exit(missed.length > 0 ? 1 : 0);
}

main().catch(console.error);
