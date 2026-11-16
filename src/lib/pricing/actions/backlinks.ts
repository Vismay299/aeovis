import { z } from "zod";
import {
  definePricedAction,
  type PricingContext,
  type PricedActionEstimateResult,
} from "../pricedActions.ts";
import { dataforseoPricing } from "../dataforseo.ts";
import { fromMicros, toMicros } from "../../spend/money.ts";
import { researchScopeSchema } from "../../../shared/researchScope.ts";
import { normalizeBacklinksTarget } from "../../providers/dataforseo/backlinksTarget.ts";
import { buildBacklinksDateRange } from "../../backlinks/backlinksService.ts";
import { backlinksResearchKey } from "../../backlinks/researchLog.ts";
import { findRecentResearch as defaultFindRecentResearch } from "../../projectContext/service.ts";
import { scheduledChecksPerMonth } from "../../../shared/schedule.ts";

export type BacklinksQuoteDeps = {
  findRecentResearch?: typeof defaultFindRecentResearch;
  now?: () => Date;
};

export const backlinksLookupRunInput = z.strictObject({
  target: z.string().min(1).max(2048),
  scope: researchScopeSchema.optional(),
  tab: z.enum(["backlinks", "domains", "pages"]).default("backlinks"),
  pageSize: z
    .union([z.literal(50), z.literal(100), z.literal(200)])
    .default(50),
});

export const backlinksPageInput = z.strictObject({
  tab: z.enum(["backlinks", "domains", "pages"]),
  pageSize: z
    .union([z.literal(50), z.literal(100), z.literal(200)])
    .default(50),
});

export const backlinksExpandDomainInput = z.strictObject({});

export async function estimateBacklinksLookupRun(
  ctx: PricingContext,
  input: z.infer<typeof backlinksLookupRunInput>,
  deps?: BacklinksQuoteDeps,
): Promise<PricedActionEstimateResult> {
  let target;
  try {
    target = normalizeBacklinksTarget(input.target, { scope: input.scope });
  } catch (err) {
    return {
      totalUsd: 0,
      expectedUsd: null,
      units: [],
      lines: [],
      monthly: null,
      warnings: [],
      blocked: {
        code: "invalid_target",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  if (input.tab === "domains" && target.scope === "subfolder") {
    return {
      totalUsd: 0,
      expectedUsd: null,
      units: [],
      lines: [],
      monthly: null,
      warnings: [],
      blocked: {
        code: "subfolder_not_supported",
        message:
          "Referring domains can't be broken down for a subfolder — use the Backlinks tab, or switch to Domain or Subdomains scope.",
      },
    };
  }

  const researchKey = backlinksResearchKey({
    apiTarget: target.apiTarget,
    scope: target.scope,
    path: target.path,
  });

  const findRecent = deps?.findRecentResearch ?? defaultFindRecentResearch;
  let recentWarning: { code: string; message: string } | null = null;
  try {
    const recent = await findRecent(ctx.admin, {
      brandKey: ctx.brandKey,
      kind: "backlinks.research",
      researchKey,
      days: 90,
    });
    if (recent) {
      recentWarning = {
        code: "recent_research",
        message: `You looked this up on ${recent.entryDate}: ${recent.summary}`,
      };
    }
  } catch {
    // Ignore lookup errors in pricing
  }

  const warnings: Array<{ code: string; message: string }> = [
    {
      code: "cache_note",
      message: "Looking up the same target again within 6 hours is free.",
    },
    ...(recentWarning ? [recentWarning] : []),
  ];

  const lines: Array<{
    label: string;
    quantity: number;
    unitUsd: number;
    totalUsd: number;
  }> = [];

  const units: Array<{
    key: string;
    label: string;
    count: number;
  }> = [];

  const now = deps?.now ? deps.now() : new Date();

  if (target.scope === "subfolder") {
    const singleRowCost = fromMicros(
      toMicros(dataforseoPricing.backlinks.rows({ limit: 1 })),
    );
    const totalsCost = fromMicros(toMicros(2 * singleRowCost));
    lines.push({
      label: "Filtered backlink totals (2 requests)",
      quantity: 2,
      unitUsd: singleRowCost,
      totalUsd: totalsCost,
    });
    units.push({
      key: "summary",
      label: "Filtered backlink totals",
      count: 2,
    });
  } else {
    const summaryCost = fromMicros(
      toMicros(dataforseoPricing.backlinks.summary({})),
    );
    lines.push({
      label: "Backlink summary",
      quantity: 1,
      unitUsd: summaryCost,
      totalUsd: summaryCost,
    });
    units.push({
      key: "summary",
      label: "Backlink summary",
      count: 1,
    });

    if (target.scope !== "exact_url") {
      const dateRange = buildBacklinksDateRange(now);
      const historyCost = fromMicros(
        toMicros(dataforseoPricing.backlinks.history(dateRange)),
      );
      lines.push({
        label: "12 months of history",
        quantity: 1,
        unitUsd: historyCost,
        totalUsd: historyCost,
      });
      units.push({
        key: "history",
        label: "Backlink history",
        count: 1,
      });
    }
  }

  if (input.tab === "backlinks") {
    const firstPageCost = fromMicros(
      toMicros(dataforseoPricing.backlinks.rows({ limit: input.pageSize })),
    );
    lines.push({
      label: `First ${input.pageSize} backlinks`,
      quantity: 1,
      unitUsd: firstPageCost,
      totalUsd: firstPageCost,
    });
    units.push({
      key: "backlinks",
      label: "Backlinks",
      count: input.pageSize,
    });
  } else if (input.tab === "domains") {
    const firstPageCost = fromMicros(
      toMicros(
        dataforseoPricing.backlinks.referringDomains({ limit: input.pageSize }),
      ),
    );
    lines.push({
      label: `First ${input.pageSize} referring domains`,
      quantity: 1,
      unitUsd: firstPageCost,
      totalUsd: firstPageCost,
    });
    units.push({
      key: "domains",
      label: "Referring domains",
      count: input.pageSize,
    });
  } else if (input.tab === "pages") {
    const firstPageCost = fromMicros(
      toMicros(
        dataforseoPricing.backlinks.domainPages({ limit: input.pageSize }),
      ),
    );
    lines.push({
      label: `First ${input.pageSize} top pages`,
      quantity: 1,
      unitUsd: firstPageCost,
      totalUsd: firstPageCost,
    });
    units.push({
      key: "pages",
      label: "Top pages",
      count: input.pageSize,
    });
  }

  const totalUsd = fromMicros(
    lines.reduce((sum, line) => sum + toMicros(line.totalUsd), 0),
  );

  return {
    totalUsd,
    expectedUsd: null,
    units,
    lines,
    monthly: null,
    warnings,
    blocked: null,
  };
}

export async function estimateBacklinksPage(
  _ctx: PricingContext,
  input: z.infer<typeof backlinksPageInput>,
): Promise<PricedActionEstimateResult> {
  let unitUsd = 0;
  let label = "";
  let unitKey = "";
  let unitLabel = "";

  if (input.tab === "backlinks") {
    unitUsd = fromMicros(
      toMicros(dataforseoPricing.backlinks.rows({ limit: input.pageSize })),
    );
    label = `${input.pageSize} backlinks`;
    unitKey = "backlinks";
    unitLabel = "Backlinks";
  } else if (input.tab === "domains") {
    unitUsd = fromMicros(
      toMicros(
        dataforseoPricing.backlinks.referringDomains({ limit: input.pageSize }),
      ),
    );
    label = `${input.pageSize} referring domains`;
    unitKey = "domains";
    unitLabel = "Referring domains";
  } else if (input.tab === "pages") {
    unitUsd = fromMicros(
      toMicros(
        dataforseoPricing.backlinks.domainPages({ limit: input.pageSize }),
      ),
    );
    label = `${input.pageSize} top pages`;
    unitKey = "pages";
    unitLabel = "Top pages";
  }

  const lines = [
    {
      label,
      quantity: 1,
      unitUsd,
      totalUsd: unitUsd,
    },
  ];

  return {
    totalUsd: unitUsd,
    expectedUsd: null,
    units: [{ key: unitKey, label: unitLabel, count: input.pageSize }],
    lines,
    monthly: null,
    warnings: [],
    blocked: null,
  };
}

export async function estimateBacklinksExpandDomain(
  _ctx: PricingContext,
  _input: z.infer<typeof backlinksExpandDomainInput>,
): Promise<PricedActionEstimateResult> {
  const unitUsd = fromMicros(
    toMicros(dataforseoPricing.backlinks.rows({ limit: 100 })),
  );
  const lines = [
    {
      label: "All links from one domain (up to 100)",
      quantity: 1,
      unitUsd,
      totalUsd: unitUsd,
    },
  ];

  return {
    totalUsd: unitUsd,
    expectedUsd: null,
    units: [{ key: "links", label: "Domain backlinks", count: 100 }],
    lines,
    monthly: null,
    warnings: [],
    blocked: null,
  };
}

export const backlinksLookupRunAction = definePricedAction({
  key: "backlinks.lookup.run",
  feature: "backlinks.research",
  input: backlinksLookupRunInput,
  requireApproval: false,
  estimate: (ctx, input) => estimateBacklinksLookupRun(ctx, input),
});

export const backlinksPageAction = definePricedAction({
  key: "backlinks.page",
  feature: "backlinks.research",
  input: backlinksPageInput,
  requireApproval: false,
  estimate: (ctx, input) => estimateBacklinksPage(ctx, input),
});

export const backlinksExpandDomainAction = definePricedAction({
  key: "backlinks.expand_domain",
  feature: "backlinks.research",
  input: backlinksExpandDomainInput,
  requireApproval: false,
  estimate: (ctx, input) => estimateBacklinksExpandDomain(ctx, input),
});

export const backlinksSnapshotsTrackInput = z.strictObject({
  target: z.string().trim().min(3).max(255),
  scope: z.enum(["domain", "subdomains"]),
  interval: z.enum(["weekly", "monthly"]),
});

export async function estimateBacklinksSnapshotsTrack(
  _ctx: PricingContext,
  input: z.infer<typeof backlinksSnapshotsTrackInput>,
): Promise<PricedActionEstimateResult> {
  const unitUsd = fromMicros(
    toMicros(dataforseoPricing.backlinks.summary({})),
  );
  const runsPerMonth = scheduledChecksPerMonth(input.interval);
  const monthlyTotalUsd = fromMicros(toMicros(unitUsd * runsPerMonth));
  return {
    totalUsd: unitUsd,
    expectedUsd: null,
    units: [{ key: "summary", label: "Backlink summary", count: 1 }],
    lines: [
      {
        label: `Backlink summary for ${input.target}`,
        quantity: 1,
        unitUsd,
        totalUsd: unitUsd,
      },
    ],
    monthly: { interval: input.interval, runsPerMonth, totalUsd: monthlyTotalUsd },
    warnings: [],
    blocked: null,
  };
}

export const backlinksSnapshotsTrackAction = definePricedAction({
  key: "backlinks.snapshots.track",
  feature: "backlinks.snapshots",
  input: backlinksSnapshotsTrackInput,
  requireApproval: true,
  estimate: (ctx, input) => estimateBacklinksSnapshotsTrack(ctx, input),
});
