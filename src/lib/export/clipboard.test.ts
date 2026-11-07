// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/lib/clipboard.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import { copyTableToClipboard } from "./clipboard.ts";

type WrittenItem = {
  plain: string;
  html: string;
};

class FakeClipboardItem {
  types: Record<string, Promise<Blob> | Blob>;
  constructor(types: Record<string, Promise<Blob> | Blob>) {
    this.types = types;
  }
  async getType(type: string): Promise<Blob> {
    return await this.types[type];
  }
}

function mockClipboardDeps() {
  const written: WrittenItem[] = [];
  const clipboard = {
    async write(items: unknown[]): Promise<void> {
      for (const item of items as FakeClipboardItem[]) {
        const plainBlob = await item.getType("text/plain");
        const htmlBlob = await item.getType("text/html");
        written.push({
          plain: await plainBlob.text(),
          html: await htmlBlob.text(),
        });
      }
    },
  };
  return {
    written,
    deps: {
      clipboard,
      ClipboardItem: FakeClipboardItem as unknown as typeof ClipboardItem,
    },
  };
}

test("copyTableToClipboard: emits TSV with tab/newline separators and flattens them inside cells", async () => {
  const { written, deps } = mockClipboardDeps();
  await copyTableToClipboard(
    ["Keyword", "Volume"],
    [
      ["seo audit", 1200],
      ["one\ttwo\nthree", 800],
    ],
    deps,
  );
  assert.equal(
    written[0].plain,
    "Keyword\tVolume\nseo audit\t1200\none two three\t800",
  );
});

test("copyTableToClipboard: emits URL cells as HTML links for spreadsheet paste", async () => {
  const { written, deps } = mockClipboardDeps();
  await copyTableToClipboard(["URL"], [["https://example.com/tools"]], deps);
  assert.equal(written[0].plain, "URL\nhttps://example.com/tools");
  assert.ok(
    written[0].html.includes(
      '<td><a href="https://example.com/tools">https://example.com/tools</a></td>',
    ),
  );
});

test("copyTableToClipboard: sanitizes formula-injection cells with a leading apostrophe", async () => {
  const { written, deps } = mockClipboardDeps();
  await copyTableToClipboard(["Keyword"], [['=HYPERLINK("evil")']], deps);
  assert.ok(written[0].plain.includes("'=HYPERLINK"));
  assert.ok(/<td>'=HYPERLINK/.test(written[0].html));
});

test("copyTableToClipboard: escapes HTML special characters in string cells", async () => {
  const { written, deps } = mockClipboardDeps();
  await copyTableToClipboard(["Title"], [['<script>alert("x")</script>']], deps);
  assert.ok(!written[0].html.includes("<script>"));
  assert.ok(written[0].html.includes("&lt;script&gt;"));
});

test("copyTableToClipboard: throws when clipboard API is missing", async () => {
  await assert.rejects(
    async () => {
      await copyTableToClipboard(["Title"], [["Test"]], {});
    },
    {
      name: "Error",
      message: "Clipboard API not available in this browser.",
    },
  );
});
