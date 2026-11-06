import test from "node:test";
import assert from "node:assert/strict";
import {
  isValidHreflang,
  pageHreflangProblems,
  findMissingReturnLinks,
} from "./hreflang.ts";

test("isValidHreflang validates language and region codes correctly", () => {
  // Valid codes
  assert.equal(isValidHreflang("en"), true);
  assert.equal(isValidHreflang("en-GB"), true);
  assert.equal(isValidHreflang("zh-Hant-TW"), true);
  assert.equal(isValidHreflang("x-default"), true);
  assert.equal(isValidHreflang("es-419"), true);

  // Invalid codes
  assert.equal(isValidHreflang("english"), false);
  assert.equal(isValidHreflang("en_GB"), false);
  assert.equal(isValidHreflang(""), false);
  assert.equal(isValidHreflang("123"), false);
});

test("pageHreflangProblems detects invalid entries and missing self-reference", () => {
  const pageWithSelf = {
    url: "https://example.com/en",
    hreflang: [
      { lang: "en", href: "https://example.com/en" },
      { lang: "de", href: "https://example.com/de" },
    ],
  };
  const problems1 = pageHreflangProblems(pageWithSelf);
  assert.equal(problems1.missingSelf, false);
  assert.equal(problems1.invalid.length, 0);

  const pageWithoutSelf = {
    url: "https://example.com/en",
    hreflang: [
      { lang: "de", href: "https://example.com/de" },
      { lang: "invalid_lang", href: "https://example.com/fr" },
      { lang: "es", href: "/relative-not-absolute" },
    ],
  };
  const problems2 = pageHreflangProblems(pageWithoutSelf);
  assert.equal(problems2.missingSelf, true);
  assert.equal(problems2.invalid.length, 2);
  assert.equal(problems2.invalid[0].lang, "invalid_lang");
  assert.equal(problems2.invalid[1].href, "/relative-not-absolute");
});

test("findMissingReturnLinks reports one-way links and ignores uncrawled alternates", () => {
  const pages = [
    // Page A links to B and C
    {
      url: "https://example.com/a",
      statusCode: 200,
      fetchClass: "ok",
      hreflang: [
        { lang: "en", href: "https://example.com/a" },
        { lang: "de", href: "https://example.com/b" },
        { lang: "fr", href: "https://example.com/c" }, // C was not crawled
      ],
    },
    // Page B links back to A (A <-> B mutual)
    {
      url: "https://example.com/b",
      statusCode: 200,
      fetchClass: "ok",
      hreflang: [
        { lang: "de", href: "https://example.com/b" },
        { lang: "en", href: "https://example.com/a" },
      ],
    },
    // Page D links to A, but A does not link to D (D -> A one way)
    {
      url: "https://example.com/d",
      statusCode: 200,
      fetchClass: "ok",
      hreflang: [
        { lang: "es", href: "https://example.com/d" },
        { lang: "en", href: "https://example.com/a" },
      ],
    },
  ];

  const missing = findMissingReturnLinks(pages);
  // A -> B is ok
  // A -> C: C not crawled, so ignored
  // D -> A: A crawled, but A does NOT link to D -> flagged on D
  assert.equal(missing.length, 1);
  assert.equal(missing[0].pageUrl, "https://example.com/d");
  assert.equal(missing[0].alternateUrl, "https://example.com/a");
  assert.equal(missing[0].lang, "en");
});
