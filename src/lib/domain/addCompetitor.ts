import type { SupabaseClient } from "@supabase/supabase-js";
import {
  applyContextUpdates as defaultApplyContextUpdates,
  declaredCompetitors as defaultDeclaredCompetitors,
  type WorkspaceBrand,
} from "../projectContext/service.ts";
import { normalizeCompetitorDomain } from "../projectContext/normalize.ts";

export type AddCompetitorBrandInput = {
  brandKey?: string;
  brand_key?: string;
  display_name?: string;
  name?: string;
  website?: string;
  website_host?: string;
  aliases?: string[];
};

export type AddDomainAsCompetitorDeps = {
  declaredCompetitors?: typeof defaultDeclaredCompetitors;
  applyContextUpdates?: typeof defaultApplyContextUpdates;
};

export async function addDomainAsCompetitor(
  admin: SupabaseClient,
  brand: AddCompetitorBrandInput,
  user: { id: string },
  input: { domain: string; name?: string },
  deps?: AddDomainAsCompetitorDeps,
): Promise<{
  competitor: { domain: string; name: string | null };
  added: boolean;
}> {
  const brandKey = brand.brandKey ?? brand.brand_key ?? "";
  const brandRow: WorkspaceBrand = {
    brandKey,
    display_name: brand.display_name ?? brand.name ?? brandKey,
    website: brand.website ?? "",
    website_host: brand.website_host ?? "",
    aliases: Array.isArray(brand.aliases) ? brand.aliases : [],
  };

  const normalizedDomain = normalizeCompetitorDomain(input.domain);

  const declaredFn = deps?.declaredCompetitors ?? defaultDeclaredCompetitors;
  const existing = await declaredFn(admin, brandKey);
  const alreadyDeclared = existing.some(
    (c) => c.domain.toLowerCase() === normalizedDomain.toLowerCase(),
  );

  const applyFn = deps?.applyContextUpdates ?? defaultApplyContextUpdates;
  const trimmedName = input.name?.trim() ? input.name.trim() : undefined;

  await applyFn(
    admin,
    brandRow,
    [
      {
        addCompetitors: [
          {
            domain: input.domain,
            name: trimmedName,
          },
        ],
      },
    ],
    "user",
    user.id,
  );

  return {
    competitor: {
      domain: normalizedDomain,
      name: trimmedName ?? null,
    },
    added: !alreadyDeclared,
  };
}
