import { isFeatureEnabled } from "../features/flags.ts";
import type { FeatureName } from "../features/names.ts";
import { registrations as memory } from "./catalog/memory.ts";
import { registrations as pricing } from "./catalog/pricing.ts";
import { registrations as questions } from "./catalog/questions.ts";
import { registrations as visibility } from "./catalog/visibility.ts";
import type { ToolRegistration } from "./types.ts";

export const TOOL_REGISTRY: readonly ToolRegistration[] = [
  ...memory,
  ...questions,
  ...visibility,
  ...pricing,
].sort((left, right) => left.def.name.localeCompare(right.def.name));

const byName = new Map(TOOL_REGISTRY.map((registration) => [registration.def.name, registration]));

export function getTool(name: string): ToolRegistration | null {
  return byName.get(name) ?? null;
}

export function filterOwnerTools(
  registrations: readonly ToolRegistration[],
  role: "owner" | "member",
): ToolRegistration[] {
  return role === "owner"
    ? [...registrations]
    : registrations.filter((registration) => !registration.ownerOnly);
}

export async function availableTools(
  ctx: { brandKey: string; role: "owner" | "member" },
  deps: { isFeatureEnabled?: typeof isFeatureEnabled } = {},
): Promise<ToolRegistration[]> {
  const enabled = deps.isFeatureEnabled ?? isFeatureEnabled;
  const featureNames = [
    ...new Set(
      TOOL_REGISTRY.map((registration) => registration.feature).filter(
        (feature): feature is FeatureName => feature !== null,
      ),
    ),
  ];
  const enabledFeatures = new Map<FeatureName, boolean>(
    await Promise.all(
      featureNames.map(async (feature) => {
        try {
          return [feature, await enabled(feature, ctx.brandKey)] as const;
        } catch {
          return [feature, false] as const;
        }
      }),
    ),
  );

  return filterOwnerTools(
    TOOL_REGISTRY.filter(
      (registration) =>
        registration.feature === null ||
        enabledFeatures.get(registration.feature) === true,
    ),
    ctx.role,
  );
}
