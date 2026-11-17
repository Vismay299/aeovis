import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmailCategory } from "./types.ts";
import { readPreferencesMany } from "./preferences.ts";

export async function workspaceRecipients(
  admin: SupabaseClient,
  brandKey: string,
  i: { role: "owner" | "any"; category: EmailCategory },
): Promise<{ userId: string }[]> {
  // Check that the brand exists and is active
  const { data: brand, error: brandError } = await admin
    .from("customer_brands")
    .select("brand_key, is_active")
    .eq("brand_key", brandKey)
    .maybeSingle();

  if (brandError) {
    throw brandError;
  }
  if (!brand || !brand.is_active) {
    return [];
  }

  let query = admin
    .from("customer_brand_memberships")
    .select("user_id, role")
    .eq("brand_key", brandKey);

  if (i.role === "owner") {
    query = query.eq("role", "owner");
  }

  const { data: members, error: membersError } = await query;
  if (membersError) {
    throw membersError;
  }
  if (!members || members.length === 0) {
    return [];
  }

  const userIds = members.map((m) => m.user_id);
  const prefsMap = await readPreferencesMany(admin, userIds);

  const eligible: { userId: string }[] = [];
  for (const uid of userIds) {
    const prefs = prefsMap.get(uid);
    if (!prefs) continue;

    let allowed = false;
    if (i.category === "scan_results") {
      allowed = prefs.scan_results;
    } else if (i.category === "schedule_alerts") {
      allowed = prefs.schedule_alerts;
    } else if (i.category === "spend_alerts") {
      allowed = prefs.spend_alerts;
    } else if (i.category === "product_updates") {
      allowed = prefs.product_updates;
    }

    if (allowed) {
      eligible.push({ userId: uid });
    }
  }

  return eligible;
}
