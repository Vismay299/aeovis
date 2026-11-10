import type { SpendFeature } from "../../../shared/spend-features.ts";

/**
 * Default spend feature for the F13 research entries (Labs keywords, Ads ideas).
 * F13 P2.T1.S1 adds "keywords.research" to SPEND_FEATURES; until then it is not
 * in the closed union, so it is cast here once. Remove the cast in P2.T1.S1.
 * No paid_feature_controls row exists for it, so any call is refused (403
 * feature_disabled) before a provider request is sent.
 */
export const KEYWORDS_RESEARCH_FEATURE = "keywords.research" as unknown as SpendFeature;
