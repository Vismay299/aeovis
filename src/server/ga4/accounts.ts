// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/google/GoogleAccountService.ts
//   src/server/features/google/googleDataRetention.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import {
  getGrant,
  grantImpact,
  removeGrant,
  listUnusedGrants,
  deleteUnusedGrant,
  purgeCache,
} from "./grants.ts";
import { getGa4AccessToken, revokeGoogleToken, type TokenDeps } from "./tokens.ts";

export const UNUSED_GRANT_GRACE_MS = 86_400_000; // 24 hours

export interface AccountServiceDeps extends TokenDeps {}

export async function getRemovalImpact(
  admin: any,
  userId: string,
  grantId: string,
): Promise<{ workspaces: number }> {
  return grantImpact(admin, userId, grantId);
}

export async function removeGoogleAccount(
  admin: any,
  userId: string,
  grantId: string,
  deps?: AccountServiceDeps,
): Promise<{ removed: boolean; workspacesDisconnected: number }> {
  const grant = await getGrant(admin, grantId, userId);
  if (!grant) {
    return { removed: false, workspacesDisconnected: 0 };
  }

  // Token for revocation minted before deletion
  let tokenToRevoke: string | null = null;
  try {
    tokenToRevoke = await getGa4AccessToken(admin, grant, deps);
  } catch {
    tokenToRevoke = null;
  }

  const result = await removeGrant(admin, userId, grantId);
  if (!result.removed) {
    return { removed: false, workspacesDisconnected: 0 };
  }

  const brands = result.brands || [];
  for (const brand of brands) {
    try {
      await purgeCache(admin, brand);
    } catch {
      // Cache purge failure does not block removal
    }
  }

  // Revoke at Google only when no grant for that Google account remains
  if (result.remainingForGoogleAccount === 0 && tokenToRevoke) {
    try {
      await revokeGoogleToken(tokenToRevoke, deps?.fetchImpl);
    } catch {
      // Revocation failures are logged in revokeGoogleToken, removal still succeeds
    }
  }

  return { removed: true, workspacesDisconnected: brands.length };
}

export async function purgeUnusedGrants(
  admin: any,
  options: {
    updatedBefore: Date;
    limit?: number;
    deadline?: number;
  },
  deps?: AccountServiceDeps,
): Promise<{ purged: number; revoked: number }> {
  const limit = options.limit ?? 50;
  const deadline = options.deadline ?? Infinity;
  let purged = 0;
  let revoked = 0;

  const unusedGrants = await listUnusedGrants(admin, options.updatedBefore, limit);

  for (const g of unusedGrants) {
    if (Date.now() >= deadline) {
      break;
    }

    const fullGrant = await getGrant(admin, g.id);
    let token: string | null = null;
    if (fullGrant) {
      try {
        token = await getGa4AccessToken(admin, fullGrant, deps);
      } catch {
        token = null;
      }
    }

    const delRes = await deleteUnusedGrant(admin, g.id, options.updatedBefore);
    if (!delRes.deleted) {
      continue;
    }
    purged += 1;

    if (delRes.remainingForGoogleAccount === 0 && token) {
      try {
        await revokeGoogleToken(token, deps?.fetchImpl);
        revoked += 1;
      } catch {
        // revocation failure logged in revokeGoogleToken
      }
    }
  }

  return { purged, revoked };
}

export const GoogleAccountService = {
  getRemovalImpact,
  removeGoogleAccount,
  purgeUnusedGrants,
  UNUSED_GRANT_GRACE_MS,
};
