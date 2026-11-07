import test from "node:test";
import assert from "node:assert/strict";
import { inspectJsonLd } from "./structuredData.ts";

test("inspectJsonLd flags invalid JSON syntax or cut blocks", () => {
  const result = inspectJsonLd(["{ invalid json", "valid text/*CUT*/"], "some visible text");
  assert.equal(result.blocks.length, 2);
  assert.equal(result.blocks[0].parseState, "invalid");
  assert.equal(result.blocks[1].parseState, "invalid");
});

test("inspectJsonLd handles @graph with untyped objects and increments missingType", () => {
  const json = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        name: "Acme Corp",
        url: "https://example.com",
      },
      {
        name: "Untyped Node",
      },
    ],
  });

  const result = inspectJsonLd([json], "Acme Corp");
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].parseState, "valid");
  assert.deepEqual(result.blocks[0].types, ["Organization"]);
  assert.equal(result.missingType, 1);
});

test("inspectJsonLd detects missing required Google properties for Product", () => {
  const json = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Widget Pro",
  });

  const result = inspectJsonLd([json], "Widget Pro");
  assert.equal(result.missingRequired.length, 1);
  assert.equal(result.missingRequired[0].type, "Product");
  assert.deepEqual(result.missingRequired[0].missing, ["offers|review|aggregateRating"]);
});

test("inspectJsonLd strips schema.org type prefix", () => {
  const json = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "https://schema.org/Organization",
    name: "Perceev",
    url: "https://perceev.xyz",
  });

  const result = inspectJsonLd([json], "Perceev");
  assert.equal(result.blocks[0].types[0], "Organization");
  assert.equal(result.missingRequired.length, 0);
});

test("inspectJsonLd checks visible claims including R15 unobserved product claims", () => {
  const json = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Unobserved Product 9000",
    description: "Invisible Description in Body",
    offers: {
      "@type": "Offer",
      price: 99.99,
      sku: "SKU-999",
    },
  });

  // Only "Unobserved Product 9000" is visible in the page text
  const visibleText = "Welcome to our store. We feature Unobserved Product 9000 today.";
  const result = inspectJsonLd([json], visibleText);

  assert.equal(result.claimsNotVisible.length, 3);
  assert.ok(result.claimsNotVisible.some((c) => c.path === "$.description" && c.value === "Invisible Description in Body"));
  assert.ok(result.claimsNotVisible.some((c) => c.path === "$.offers.price" && c.value === "99.99"));
  assert.ok(result.claimsNotVisible.some((c) => c.path === "$.offers.sku" && c.value === "SKU-999"));
});
