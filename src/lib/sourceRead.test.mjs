/**
 * R6.4.16 — Tests for the shared source-reading guard.
 *
 * Three claims:
 *   1. The helper reads a normal file without interference.
 *   2. An empty or short file triggers exactly one retry; if the retry also
 *      fails, the helper throws (genuine failure, not swallowed).
 *   3. The JSON variant retries on parse failure and throws on a genuine one.
 *
 * A torn read is a race between a writer and a reader. We cannot deterministically
 * produce one in a single-process test. Instead we test the helper's CONTRACT:
 * the retry path is exercised by files that are genuinely empty or malformed,
 * and we verify the helper does not silently return garbage.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readSourceGuarded, readJsonGuarded } from "./sourceRead.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, "..", "..", "node_modules", ".test-source-read");

async function ensureTmp() {
  await mkdir(TMP, { recursive: true });
}

function tmpFile(name) {
  return path.join(TMP, name);
}

// ---------------------------------------------------------------------------
// 1. readSourceGuarded — normal files
// ---------------------------------------------------------------------------

test("readSourceGuarded reads a real source file", async () => {
  const content = await readSourceGuarded(path.join(HERE, "sourceRead.mjs"), {
    label: "sourceRead.mjs",
  });
  assert.ok(content.length > 100, "the helper must return real content");
  assert.ok(content.includes("readSourceGuarded"), "the content must be the file we asked for");
});

test("readSourceGuarded accepts a URL", async () => {
  const content = await readSourceGuarded(new URL("./sourceRead.mjs", import.meta.url));
  assert.ok(content.includes("readSourceGuarded"));
});

// ---------------------------------------------------------------------------
// 2. readSourceGuarded — anomaly detection
// ---------------------------------------------------------------------------

test("readSourceGuarded throws on a genuinely empty file (not just a torn read)", async () => {
  await ensureTmp();
  const fp = tmpFile("empty.js");
  await writeFile(fp, "");
  try {
    await assert.rejects(
      () => readSourceGuarded(fp, { label: "empty.js", minLength: 1 }),
      (err) => {
        assert.match(err.message, /source-read anomaly/);
        assert.match(err.message, /empty\.js/);
        assert.match(err.message, /0 byte/);
        return true;
      }
    );
  } finally {
    await unlink(fp).catch(() => {});
  }
});

test("readSourceGuarded throws when content is below minLength after retry", async () => {
  await ensureTmp();
  const fp = tmpFile("short.js");
  await writeFile(fp, "x");
  try {
    await assert.rejects(
      () => readSourceGuarded(fp, { label: "short.js", minLength: 100 }),
      (err) => {
        assert.match(err.message, /source-read anomaly/);
        assert.match(err.message, /1 byte/);
        assert.match(err.message, /100/);
        return true;
      }
    );
  } finally {
    await unlink(fp).catch(() => {});
  }
});

test("readSourceGuarded returns content that meets minLength", async () => {
  await ensureTmp();
  const fp = tmpFile("ok.js");
  await writeFile(fp, "const x = 42;\n");
  try {
    const content = await readSourceGuarded(fp, { minLength: 5 });
    assert.equal(content, "const x = 42;\n");
  } finally {
    await unlink(fp).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 3. readJsonGuarded — normal JSON
// ---------------------------------------------------------------------------

test("readJsonGuarded parses a valid JSON file", async () => {
  await ensureTmp();
  const fp = tmpFile("valid.json");
  await writeFile(fp, JSON.stringify({ name: "test", version: 1 }));
  try {
    const obj = await readJsonGuarded(fp, { label: "valid.json" });
    assert.equal(obj.name, "test");
    assert.equal(obj.version, 1);
  } finally {
    await unlink(fp).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 4. readJsonGuarded — anomaly detection
// ---------------------------------------------------------------------------

test("readJsonGuarded throws on genuinely invalid JSON (not just a torn read)", async () => {
  await ensureTmp();
  const fp = tmpFile("bad.json");
  await writeFile(fp, "{ this is not json }");
  try {
    await assert.rejects(
      () => readJsonGuarded(fp, { label: "bad.json" }),
      (err) => {
        assert.match(err.message, /source-read anomaly/);
        assert.match(err.message, /bad\.json/);
        assert.match(err.message, /JSON/);
        return true;
      }
    );
  } finally {
    await unlink(fp).catch(() => {});
  }
});

test("readJsonGuarded throws on an empty JSON file", async () => {
  await ensureTmp();
  const fp = tmpFile("empty.json");
  await writeFile(fp, "");
  try {
    await assert.rejects(
      () => readJsonGuarded(fp, { label: "empty.json" }),
      (err) => {
        assert.match(err.message, /source-read anomaly/);
        return true;
      }
    );
  } finally {
    await unlink(fp).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 5. The helper must not swallow genuine failures
// ---------------------------------------------------------------------------

test("readSourceGuarded throws on a nonexistent file (genuine failure, not swallowed)", async () => {
  await assert.rejects(
    () => readSourceGuarded(path.join(TMP, "does-not-exist.js")),
    (err) => {
      assert.equal(err.code, "ENOENT", "a missing file must throw ENOENT, not be caught");
      return true;
    }
  );
});

test("readJsonGuarded throws on a nonexistent file (genuine failure, not swallowed)", async () => {
  await assert.rejects(
    () => readJsonGuarded(path.join(TMP, "does-not-exist.json")),
    (err) => {
      assert.equal(err.code, "ENOENT");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 6. Teeth: the helper must distinguish a torn read from a genuine one
// ---------------------------------------------------------------------------

test("TEETH — the helper's contract is 'retry once, then throw', not 'retry forever'", async () => {
  await ensureTmp();
  const fp = tmpFile("teeth.json");
  // Write content that is valid JSON but too short for the caller's minLength.
  await writeFile(fp, "42");
  try {
    // readJsonGuarded should parse it fine (42 is valid JSON).
    const val = await readJsonGuarded(fp);
    assert.equal(val, 42);

    // readSourceGuarded with an absurdly high minLength should fail after one retry.
    await assert.rejects(
      () => readSourceGuarded(fp, { minLength: 999999 }),
      /source-read anomaly/
    );
  } finally {
    await unlink(fp).catch(() => {});
  }
});
