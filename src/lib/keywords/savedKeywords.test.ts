import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../http/errors.ts";
import { createMemorySavedKeywordsRepository } from "./memoryRepository.ts";
import {
  saveKeywords,
  getSavedKeywords,
  exportSavedKeywords,
  updateSavedKeywordTags,
  updateSavedKeywordTag,
  deleteSavedKeywordTag,
  removeSavedKeywords,
} from "./savedKeywords.ts";

describe("savedKeywords service", () => {
  // Case 1: Ported from upstream saved-keywords.test.ts: attaches tags after saving (normalises and dedupes keywords)
  test("attaches tags to saved keyword rows after saving (normalises & dedupes)", async () => {
    const repo = createMemorySavedKeywordsRepository();

    const result = await saveKeywords(repo, {
      brandKey: "brand_1",
      keywords: [" Technical SEO ", "technical seo", "Content SEO"],
      locationCode: 2840,
      languageCode: "en",
      tagMode: "append",
      tags: ["Content", "BOFU"],
    });

    assert.equal(result.savedKeywordIds.length, 2);
    assert.equal(result.created, 2);

    const saved = repo.getKeywords();
    assert.equal(saved.length, 2);
    assert.deepEqual(
      saved.map((k) => k.keyword).sort(),
      ["content seo", "technical seo"],
    );

    const tags = repo.getTags();
    assert.equal(tags.length, 2);
    assert.deepEqual(
      tags.map((t) => t.name).sort(),
      ["BOFU", "Content"],
    );
  });

  // Case 2: Ported from upstream saved-keywords.test.ts: replaces tags when tagMode is replace
  test("replaces tags when tagMode is replace", async () => {
    const repo = createMemorySavedKeywordsRepository();

    // First save with initial tag
    await saveKeywords(repo, {
      brandKey: "brand_1",
      keywords: ["technical seo"],
      locationCode: 2840,
      languageCode: "en",
      tags: ["InitialTag"],
    });

    // Replace tags
    const result = await saveKeywords(repo, {
      brandKey: "brand_1",
      keywords: ["technical seo"],
      locationCode: 2840,
      languageCode: "en",
      tags: ["US"],
      tagMode: "replace",
    });

    assert.equal(result.savedKeywordIds.length, 1);
    const list = await getSavedKeywords(repo, { brandKey: "brand_1" });
    assert.equal(list.rows[0].tags.length, 1);
    assert.equal(list.rows[0].tags[0].name, "US");
  });

  // Case 3: Ported from upstream saved-keywords.test.ts: rejects replace mode without replacement tags
  test("rejects replace mode without replacement tags", async () => {
    const repo = createMemorySavedKeywordsRepository();

    await assert.rejects(
      async () => {
        await saveKeywords(repo, {
          brandKey: "brand_1",
          keywords: ["technical seo"],
          locationCode: 2840,
          languageCode: "en",
          tagMode: "replace",
        });
      },
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.status, 400);
        assert.equal(err.code, "invalid_request");
        assert(err.message.includes("Replacement tags are required"));
        return true;
      },
    );
  });

  // Case 4: F13-AC-07 - metrics never forwarded from client
  test("rejects client metrics with 400 invalid_request", async () => {
    const repo = createMemorySavedKeywordsRepository();

    await assert.rejects(
      async () => {
        await saveKeywords(repo, {
          brandKey: "brand_1",
          keywords: ["seo tools"],
          locationCode: 2840,
          languageCode: "en",
          metrics: [{ searchVolume: 1000 }],
        } as any);
      },
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.status, 400);
        assert.equal(err.code, "invalid_request");
        assert.equal(err.message, "Client metrics are not accepted.");
        return true;
      },
    );
  });

  // Case 5: F13-AC-14 - tag name filter with no match returns empty without querying keywords
  test("tag name filter with no match returns empty immediately", async () => {
    const repo = createMemorySavedKeywordsRepository();

    await saveKeywords(repo, {
      brandKey: "brand_1",
      keywords: ["keyword 1", "keyword 2"],
      locationCode: 2840,
      languageCode: "en",
      tags: ["ExistingTag"],
    });

    let listCalled = false;
    const trackingRepo = {
      ...repo,
      list: async (i: any) => {
        listCalled = true;
        return repo.list(i);
      },
    };

    const result = await getSavedKeywords(trackingRepo, {
      brandKey: "brand_1",
      tagNames: ["NonExistentTag"],
    });

    assert.equal(listCalled, false, "repo.list must NOT be called");
    assert.deepEqual(result.rows, []);
    assert.equal(result.totalCount, 0);
  });

  // Case 6: F13-AC-15 - tag_in_use message pluralisation
  test("tag_in_use message pluralises keyword count correctly", async () => {
    const repo = createMemorySavedKeywordsRepository();

    // 1 keyword attached
    await saveKeywords(repo, {
      brandKey: "brand_1",
      keywords: ["kw1"],
      locationCode: 2840,
      languageCode: "en",
      tags: ["SingleTag"],
    });
    const singleTag = repo.getTags().find((t) => t.name === "SingleTag")!;

    await assert.rejects(
      async () => {
        await deleteSavedKeywordTag(repo, {
          brandKey: "brand_1",
          tagId: singleTag.id,
        });
      },
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.status, 409);
        assert.equal(err.code, "tag_in_use");
        assert.equal(
          err.message,
          "Tag is attached to 1 keyword. Remove the tag from those keywords first.",
        );
        return true;
      },
    );

    // 2 keywords attached
    await saveKeywords(repo, {
      brandKey: "brand_1",
      keywords: ["kw1", "kw2"],
      locationCode: 2840,
      languageCode: "en",
      tags: ["PluralTag"],
    });
    const pluralTag = repo.getTags().find((t) => t.name === "PluralTag")!;

    await assert.rejects(
      async () => {
        await deleteSavedKeywordTag(repo, {
          brandKey: "brand_1",
          tagId: pluralTag.id,
        });
      },
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.status, 409);
        assert.equal(err.code, "tag_in_use");
        assert.equal(
          err.message,
          "Tag is attached to 2 keywords. Remove the tag from those keywords first.",
        );
        return true;
      },
    );
  });

  // Case 7: Update tag rename & recolor
  test("updates tag name and color, rejects empty name", async () => {
    const repo = createMemorySavedKeywordsRepository();

    await saveKeywords(repo, {
      brandKey: "brand_1",
      keywords: ["kw1"],
      locationCode: 2840,
      languageCode: "en",
      tags: ["Tag1"],
    });
    const tag = repo.getTags().find((t) => t.name === "Tag1")!;

    // Empty name rejects
    await assert.rejects(
      async () => {
        await updateSavedKeywordTag(repo, {
          brandKey: "brand_1",
          tagId: tag.id,
          name: "   ",
        });
      },
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.status, 400);
        return true;
      },
    );

    // Rename
    const renamed = await updateSavedKeywordTag(repo, {
      brandKey: "brand_1",
      tagId: tag.id,
      name: "RenamedTag",
    });
    assert.equal(renamed.tag.name, "RenamedTag");

    // Recolor
    const recolored = await updateSavedKeywordTag(repo, {
      brandKey: "brand_1",
      tagId: tag.id,
      color: "blue",
    });
    assert.equal(recolored.tag.color, "blue");
  });

  // Case 8: Export saved keywords with truncation flag
  test("export returns rows and truncated flag", async () => {
    const repo = createMemorySavedKeywordsRepository();

    await saveKeywords(repo, {
      brandKey: "brand_1",
      keywords: ["kw1", "kw2"],
      locationCode: 2840,
      languageCode: "en",
    });

    const exp = await exportSavedKeywords(repo, { brandKey: "brand_1" });
    assert.equal(exp.rows.length, 2);
    assert.equal(exp.truncated, false);

    // Unknown tag in export returns empty without error
    const expEmpty = await exportSavedKeywords(repo, {
      brandKey: "brand_1",
      tagNames: ["UnknownTag"],
    });
    assert.equal(expEmpty.rows.length, 0);
    assert.equal(expEmpty.truncated, false);
  });

  // Case 9: Bulk remove keywords
  test("bulk remove deletes specified keywords", async () => {
    const repo = createMemorySavedKeywordsRepository();

    const saveResult = await saveKeywords(repo, {
      brandKey: "brand_1",
      keywords: ["kw1", "kw2", "kw3"],
      locationCode: 2840,
      languageCode: "en",
    });

    assert.equal(saveResult.savedKeywordIds.length, 3);

    const removeResult = await removeSavedKeywords(repo, {
      brandKey: "brand_1",
      savedKeywordIds: [saveResult.savedKeywordIds[0], saveResult.savedKeywordIds[1]],
    });

    assert.equal(removeResult.deletedCount, 2);
    const remaining = await getSavedKeywords(repo, { brandKey: "brand_1" });
    assert.equal(remaining.rows.length, 1);
    assert.equal(remaining.rows[0].keyword, "kw3");
  });
});
