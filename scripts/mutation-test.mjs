/**
 * Mutation Testing Framework for aeovis Rebuild
 * 
 * Purpose: Verify that test suites catch regressions by introducing intentional
 * bugs (mutations) into critical code paths and running tests to detect them.
 * 
 * Focus areas:
 * 1. SSRF Guard - Security-critical URL validation
 * 2. Rate Limiting - Abuse prevention
 * 3. Scoring Engine - Business logic correctness
 * 4. Database Operations - Data integrity
 * 
 * Usage: node scripts/mutation-test.mjs
 */

import { readFile, writeFile, copyFile, unlink } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Mutation definitions: file, line range, description, and expected behavior
const MUTATIONS = [
  // ============================================
  // SSRF GUARD MUTATIONS (Security Critical)
  // ============================================
  {
    id: 'SSRF-001',
    file: 'src/server/ssrfGuard.js',
    name: 'Allow file:// scheme in SSRF guard',
    mutate: (content) => content.replace(
      /const ALLOWED_PROTOCOLS = new Set\(\["http:", "https:"\]\);/,
      'const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "file:"]);'
    ),
    test: 'src/server/ssrfGuard.test.mjs',
    expected: 'fail',
    severity: 'critical',
    description: 'Removes protocol whitelist restriction, allowing file:// URLs'
  },
  {
    id: 'SSRF-002',
    file: 'src/server/ssrfGuard.js',
    name: 'Remove credential check in URL normalization',
    mutate: (content) => content.replace(
      /if \(url\.username \|\| url\.password\) \{[\s\S]*?\}/,
      '// Credentials check removed'
    ),
    test: 'src/server/ssrfGuard.test.mjs',
    expected: 'fail',
    severity: 'critical',
    description: 'Allows URLs with embedded credentials (user:pass@host)'
  },
  {
    id: 'SSRF-003',
    file: 'src/server/ssrfGuard.js',
    name: 'Bypass loopback address blocking',
    mutate: (content) => content.replace(
      /{ cidr: "127\.0\.0\.0\/8", reason: "loopback" },/,
      '// { cidr: "127.0.0.0/8", reason: "loopback" },'
    ),
    test: 'src/server/ssrfGuard.test.mjs',
    expected: 'fail',
    severity: 'critical',
    description: 'Allows 127.0.0.0/8 (loopback) addresses to pass SSRF guard'
  },
  {
    id: 'SSRF-004',
    file: 'src/server/ssrfGuard.js',
    name: 'Bypass link-local (metadata) blocking',
    mutate: (content) => content.replace(
      /{ cidr: "169\.254\.0\.0\/16", reason: "link_local" },/,
      '// { cidr: "169.254.0.0/16", reason: "link_local" },'
    ),
    test: 'src/server/ssrfGuard.test.mjs',
    expected: 'fail',
    severity: 'critical',
    description: 'Allows 169.254.0.0/16 (cloud metadata) addresses to pass'
  },
  {
    id: 'SSRF-005',
    file: 'src/server/ssrfGuard.js',
    name: 'Remove redirect validation in safeFetch',
    mutate: (content) => content.replace(
      /const location = response\.headers\?\.\get\?\("location"\);[\s\S]*?continue;/,
      'return response;'
    ),
    test: 'src/server/ssrfGuard.test.mjs',
    expected: 'fail',
    severity: 'critical',
    description: 'Follows redirects without re-validating target address'
  },
  {
    id: 'SSRF-006',
    file: 'src/server/ssrfGuard.js',
    name: 'Remove MAX_REDIRECTS limit',
    mutate: (content) => content.replace(
      /export const MAX_REDIRECTS = 5;/,
      'export const MAX_REDIRECTS = Infinity;'
    ),
    test: 'src/server/ssrfGuard.test.mjs',
    expected: 'fail',
    severity: 'high',
    description: 'Allows unlimited redirects (redirect loop vulnerability)'
  },
  {
    id: 'SSRF-007',
    file: 'src/server/ssrfGuard.js',
    name: 'Remove private IPv6 blocking (fc00::/7)',
    mutate: (content) => content.replace(
      /{ cidr: "fc00::\/7", reason: "unique_local" },/,
      '// { cidr: "fc00::/7", reason: "unique_local" },'
    ),
    test: 'src/server/ssrfGuard.test.mjs',
    expected: 'fail',
    severity: 'high',
    description: 'Allows private IPv6 ULA addresses to pass'
  },
  {
    id: 'SSRF-008',
    file: 'src/server/ssrfGuard.js',
    name: 'Remove hostname length check',
    mutate: (content) => content.replace(
      /if \(url\.hostname\.length > MAX_HOSTNAME_LENGTH\) \{[\s\S]*?\}/,
      '// Hostname length check removed'
    ),
    test: 'src/server/ssrfGuard.test.mjs',
    expected: 'fail',
    severity: 'medium',
    description: 'Allows arbitrarily long hostnames (potential buffer overflow)'
  },

  // ============================================
  // RATE LIMITING MUTATIONS (Abuse Prevention)
  // ============================================
  {
    id: 'RL-001',
    file: 'src/server/rateLimit.js',
    name: 'Remove deployment ceiling enforcement',
    mutate: (content) => content.replace(
      /export const UNVERIFIED_CEILING_MULTIPLIER = 5;/,
      'export const UNVERIFIED_CEILING_MULTIPLIER = 999999;'
    ),
    test: 'src/server/rateLimit.test.mjs',
    expected: 'fail',
    severity: 'critical',
    description: 'Removes effective deployment-wide rate limit ceiling'
  },
  {
    id: 'RL-002',
    file: 'src/server/rateLimit.js',
    name: 'Change default limit from 5 to unlimited',
    mutate: (content) => content.replace(
      /limit: 5,/,
      'limit: 999999,'
    ),
    test: 'src/server/rateLimit.test.mjs',
    expected: 'fail',
    severity: 'critical',
    description: 'Makes default rate limit effectively unlimited'
  },
  {
    id: 'RL-003',
    file: 'src/server/rateLimit.js',
    name: 'Remove trust basis distinction',
    mutate: (content) => content.replace(
      /const ATTESTED_BASES = new Set\(\[TRUST_BASIS\.DECLARED, TRUST_BASIS\.PLATFORM_UNPROVEN\]\);/,
      'const ATTESTED_BASES = new Set();'
    ),
    test: 'src/server/rateLimit.test.mjs',
    expected: 'fail',
    severity: 'high',
    description: 'All trust bases treated as unverified (weaker limits)'
  },
  {
    id: 'RL-004',
    file: 'src/server/rateLimit.js',
    name: 'Bypass address normalization',
    mutate: (content) => content.replace(
      /export function normaliseAddress\(raw\) \{[\s\S]*?return value;\n\}/,
      'export function normaliseAddress(raw) { return String(raw ?? "").trim().toLowerCase(); }'
    ),
    test: 'src/server/rateLimit.test.mjs',
    expected: 'fail',
    severity: 'high',
    description: 'Does not strip ports, allowing bucket splitting'
  },
  {
    id: 'RL-005',
    file: 'src/server/rateLimit.js',
    name: 'Remove refused IP headers',
    mutate: (content) => content.replace(
      /x-real-ip": "this module already reads it[\s\S]*?trusted as a fact",/,
      '"x-real-ip": "allowed",'
    ),
    test: 'src/server/rateLimit.test.mjs',
    expected: 'fail',
    severity: 'high',
    description: 'Allows declaring x-real-ip as trusted header'
  },

  // ============================================
  // SCORING ENGINE MUTATIONS (Business Logic)
  // ============================================
  {
    id: 'SCORE-001',
    file: 'src/shared/scoring/constants.js',
    name: 'Invert sentiment weights',
    mutate: (content) => content.replace(
      /positive: 1\.0,/,
      'positive: 0.0,'
    ),
    test: 'src/shared/scoring/computeVisibilityScore.test.mjs',
    expected: 'fail',
    severity: 'critical',
    description: 'Positive sentiment scores as 0 instead of 1.0'
  },
  {
    id: 'SCORE-002',
    file: 'src/shared/scoring/constants.js',
    name: 'Remove citation bonus',
    mutate: (content) => content.replace(
      /export const CITATION_BONUS = 0\.15;/,
      'export const CITATION_BONUS = 0.0;'
    ),
    test: 'src/shared/scoring/computeVisibilityScore.test.mjs',
    expected: 'fail',
    severity: 'high',
    description: 'Removes citation bonus from visibility score'
  },
  {
    id: 'SCORE-003',
    file: 'src/shared/scoring/constants.js',
    name: 'Invert intent weights',
    mutate: (content) => content.replace(
      /high_intent: 3\.0,/,
      'high_intent: 0.5,'
    ),
    test: 'src/shared/scoring/computeVisibilityScore.test.mjs',
    expected: 'fail',
    severity: 'high',
    description: 'High-intent queries weighted lower than exploratory'
  },
  {
    id: 'SCORE-004',
    file: 'src/shared/scoring/computeVisibilityScore.js',
    name: 'Remove citation share blending',
    mutate: (content) => content.replace(
      /const blended = \(1 - CITATION_SHARE_WEIGHT\) \* mentionVisibility \+ CITATION_SHARE_WEIGHT \* brandCitationShare;/,
      'const blended = mentionVisibility;'
    ),
    test: 'src/shared/scoring/computeVisibilityScore.test.mjs',
    expected: 'fail',
    severity: 'high',
    description: 'Ignores citation share in composite visibility score'
  },
  {
    id: 'SCORE-005',
    file: 'src/shared/scoring/computeVisibilityScore.js',
    name: 'Break score rounding',
    mutate: (content) => content.replace(
      /return Math\.round\(blended \* 10\) \/ 10;/,
      'return Math.round(blended * 100) / 100;'
    ),
    test: 'src/shared/scoring/computeVisibilityScore.test.mjs',
    expected: 'fail',
    severity: 'medium',
    description: 'Changes score precision (2 decimal places instead of 1)'
  },
  {
    id: 'SCORE-006',
    file: 'src/shared/scoring/bayesian.js',
    name: 'Break posterior calculation',
    mutate: (content) => content.replace(
      /const posteriorMean = alphaPost \/ \(alphaPost \+ betaPost\);/,
      'const posteriorMean = alphaPost / betaPost;'
    ),
    test: 'src/shared/scoring/bayesian.test.mjs',
    expected: 'fail',
    severity: 'critical',
    description: 'Incorrect Bayesian posterior mean calculation'
  },
  {
    id: 'SCORE-007',
    file: 'src/shared/scoring/judge.js',
    name: 'Invert position detection logic',
    mutate: (content) => content.replace(
      /if \(relativePos >= 0\.7\) \{[\s\S]*?return "cited";[\s\S]*?\}/,
      'if (relativePos < 0.7) { return "cited"; }'
    ),
    test: 'src/shared/scoring/judge.test.mjs',
    expected: 'fail',
    severity: 'high',
    description: 'Inverts position detection for cited brand mentions'
  },
  {
    id: 'SCORE-008',
    file: 'src/shared/scoring/judge.js',
    name: 'Break word boundary detection',
    mutate: (content) => content.replace(
      /const regexStr = \`\(\?:\^\|\[a-zA-Z0-9_\]\)\$\{escaped\}\(\?:\$\|\[a-zA-Z0-9_\]\)\`;/,
      'const regexStr = `${escaped}`;'
    ),
    test: 'src/shared/scoring/judge.test.mjs',
    expected: 'fail',
    severity: 'high',
    description: 'Removes word boundary checks from mention detection'
  },

  // ============================================
  // DATABASE OPERATIONS MUTATIONS (Data Integrity)
  // ============================================
  {
    id: 'DB-001',
    file: 'src/server/db.js',
    name: 'Remove scan write confirmation',
    mutate: (content) => content.replace(
      /function confirmScanWritten\(data, scanRecord\) \{[\s\S]*?return data;\n\}/,
      'function confirmScanWritten(data, scanRecord) { return data || []; }'
    ),
    test: 'src/server/db.test.mjs',
    expected: 'fail',
    severity: 'critical',
    description: 'Allows unconfirmed writes to be treated as successful'
  },
  {
    id: 'DB-002',
    file: 'src/server/db.js',
    name: 'Remove job alive check',
    mutate: (content) => content.replace(
      /export function isJobAlive\(job, nowMs = Date\.now\(\)\) \{[\s\S]*?return Number\.isFinite\(heartbeatMs\) && nowMs - heartbeatMs < HEARTBEAT_STALE_MS;\n\}/,
      'export function isJobAlive(job, nowMs = Date.now()) { return true; }'
    ),
    test: 'src/server/db.test.mjs',
    expected: 'fail',
    severity: 'critical',
    description: 'All jobs considered alive regardless of heartbeat'
  },
  {
    id: 'DB-003',
    file: 'src/server/db.js',
    name: 'Remove heartbeat stamping',
    mutate: (content) => content.replace(
      /const stamped = \{ \.\.\.updates, heartbeat_at: new Date\(\)\.toISOString\(\) \};/,
      'const stamped = { ...updates };'
    ),
    test: 'src/server/db.test.mjs',
    expected: 'fail',
    severity: 'high',
    description: 'Heartbeat not updated on job updates (causes false staleness)'
  },
  {
    id: 'DB-004',
    file: 'src/server/duplicateScan.js',
    name: 'Remove duplicate scan violation detection',
    mutate: (content) => content.replace(
      /export function isDuplicateScanViolation\(error\) \{[\s\S]*?return haystack\.includes\(DUPLICATE_SCAN_INDEX\);\n\}/,
      'export function isDuplicateScanViolation(error) { return false; }'
    ),
    test: 'src/server/db.test.mjs',
    expected: 'fail',
    severity: 'critical',
    description: 'Never detects duplicate scan violations'
  },
  {
    id: 'DB-005',
    file: 'src/server/duplicateScan.js',
    name: 'Always reject duplicate scans',
    mutate: (content) => content.replace(
      /export function resolveDuplicateScan\(blockingJobs, isAlive\) \{[\s\S]*?return \{ action: "reclaim"[\s\S]*?\};\n\}/,
      'export function resolveDuplicateScan(blockingJobs, isAlive) { return { action: "reject", liveJobId: null, deadJobIds: [] }; }'
    ),
    test: 'src/server/db.test.mjs',
    expected: 'fail',
    severity: 'high',
    description: 'Always rejects scans even when blocking jobs are dead'
  },
  {
    id: 'DB-006',
    file: 'src/server/db.js',
    name: 'Remove schema mismatch detection',
    mutate: (content) => content.replace(
      /function isSchemaMismatch\(error\) \{[\s\S]*?return false;\n\}/,
      'function isSchemaMismatch(error) { return false; }'
    ),
    test: 'src/server/db.test.mjs',
    expected: 'fail',
    severity: 'medium',
    description: 'Schema mismatches not detected (less informative errors)'
  },
];

// Test runner
async function runMutationTest(mutation) {
  const filePath = join(ROOT, mutation.file);
  const originalContent = await readFile(filePath, 'utf-8');
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(`MUTATION: ${mutation.id} - ${mutation.name}`);
  console.log(`File: ${mutation.file}`);
  console.log(`Severity: ${mutation.severity.toUpperCase()}`);
  console.log(`Description: ${mutation.description}`);
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
    console.log(`Running tests: ${mutation.test}`);
    const output = execSync(
      `node --import ./src/server/liveWriteGuardAuto.mjs --test "${mutation.test}"`,
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
  
  // If we expect tests to FAIL when the mutation is applied, and they DID fail → caught
  // If we expect tests to PASS (no mutation expected), and they DID pass → caught
  const caught = testResult.passed !== (mutation.expected === 'fail');
  return {
    ...mutation,
    result: caught ? 'caught' : 'missed',
    testPassed: testResult.passed,
    output: testResult.output?.slice(0, 500)
  };
}

// Main execution
async function main() {
  console.log('🧬 Mutation Testing Framework for aeovis Rebuild');
  console.log(`Testing ${MUTATIONS.length} mutations across critical code paths\n`);
  
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
  
  // Generate report
  console.log('\n\n' + '='.repeat(70));
  console.log('📊 MUTATION TESTING REPORT');
  console.log('='.repeat(70));
  
  const caught = results.filter(r => r.result === 'caught');
  const missed = results.filter(r => r.result === 'missed');
  const skipped = results.filter(r => r.result === 'skip');
  const errors = results.filter(r => r.result === 'error');
  
  console.log(`\nTotal Mutations: ${MUTATIONS.length}`);
  console.log(`✓ Caught: ${caught.length}`);
  console.log(`✗ Missed: ${missed.length}`);
  console.log(`⊘ Skipped: ${skipped.length}`);
  console.log(`⚠ Errors: ${errors.length}`);
  
  const mutationScore = ((caught.length / (MUTATIONS.length - skipped.length)) * 100).toFixed(1);
  console.log(`\nMutation Score: ${mutationScore}%`);
  
  if (missed.length > 0) {
    console.log('\n\n🚨 MISSED MUTATIONS (Test Coverage Gaps):');
    console.log('-'.repeat(70));
    for (const m of missed) {
      console.log(`\n${m.id} (${m.severity.toUpperCase()}): ${m.name}`);
      console.log(`  File: ${m.file}`);
      console.log(`  Description: ${m.description}`);
    }
  }
  
  if (caught.length > 0) {
    console.log('\n\n✅ CAUGHT MUTATIONS (Test Strength):');
    console.log('-'.repeat(70));
    for (const m of caught) {
      console.log(`${m.id} (${m.severity.toUpperCase()}): ${m.name}`);
    }
  }
  
  // Write detailed report
  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      total: MUTATIONS.length,
      caught: caught.length,
      missed: missed.length,
      skipped: skipped.length,
      errors: errors.length,
      mutationScore: `${mutationScore}%`
    },
    results: results.map(r => ({
      id: r.id,
      file: r.file,
      name: r.name,
      severity: r.severity,
      result: r.result,
      description: r.description
    }))
  };
  
  await writeFile(
    join(ROOT, 'test_reports', `mutation-test-report-${Date.now()}.json`),
    JSON.stringify(report, null, 2)
  );
  
  console.log('\n\nDetailed report saved to test_reports/');
  
  process.exit(missed.length > 0 ? 1 : 0);
}

main().catch(console.error);
