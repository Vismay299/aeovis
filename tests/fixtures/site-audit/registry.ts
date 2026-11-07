// Central registry of all site-audit fixtures.

import type { Fixture, SiteId } from "./types.ts";
import { headTagsFixtures } from "./fixtures/head-tags.ts";
import { contentFixtures } from "./fixtures/content.ts";
import { indexabilityFixtures } from "./fixtures/indexability.ts";
import { httpStatusFixtures } from "./fixtures/http-status.ts";
import { redirectsFixtures } from "./fixtures/redirects.ts";
import { performanceFixtures } from "./fixtures/performance.ts";
import { structureFixtures } from "./fixtures/structure.ts";
import { kitchenSinkFixtures } from "./fixtures/kitchen-sink.ts";
import { aiAccessFixtures } from "./fixtures/ai-access.ts";
import { structuredDataFixtures } from "./fixtures/structured-data.ts";
import { socialFixtures } from "./fixtures/social.ts";
import { internationalFixtures } from "./fixtures/international.ts";
import { javascriptFixtures } from "./fixtures/javascript.ts";

export const FIXTURES: Fixture[] = [
  ...headTagsFixtures,
  ...contentFixtures,
  ...indexabilityFixtures,
  ...httpStatusFixtures,
  ...redirectsFixtures,
  ...performanceFixtures,
  ...structureFixtures,
  ...kitchenSinkFixtures,
  ...aiAccessFixtures,
  ...structuredDataFixtures,
  ...socialFixtures,
  ...internationalFixtures,
  ...javascriptFixtures,
];

export function findFixture(path: string, site: SiteId = "main"): Fixture | undefined {
  return FIXTURES.find((f) => {
    const fSite = f.site ?? "main";
    if (fSite !== site) return false;
    if (f.path === path) return true;
    if (f.extraPaths?.includes(path)) return true;
    return false;
  });
}
