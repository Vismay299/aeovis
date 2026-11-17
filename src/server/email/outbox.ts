import type { SupabaseClient } from "@supabase/supabase-js";
import { validateTemplateData, TEMPLATE_KEYS } from "./templates.ts";
import type { TransactionalTemplate } from "./types.ts";

export type EnqueueEmailInput = {
  kind: "transactional" | "event" | "contact";
  template: string;
  userId: string;
  brandKey?: string | null;
  dedupeKey: string;
  data?: Record<string, string | number | boolean>;
};

export async function enqueueEmail(
  admin: SupabaseClient,
  row: EnqueueEmailInput,
): Promise<{ created: boolean }> {
  if (row.kind === "transactional" && row.template in TEMPLATE_KEYS) {
    validateTemplateData(row.template as TransactionalTemplate, row.data ?? {});
  }

  const dbRow = {
    kind: row.kind,
    template: row.template,
    user_id: row.userId,
    brand_key: row.brandKey ?? null,
    dedupe_key: row.dedupeKey,
    data: row.data ?? {},
    status: "pending",
  };

  const { data, error } = await admin
    .from("email_outbox")
    .upsert(dbRow, { onConflict: "dedupe_key", ignoreDuplicates: true })
    .select("id");

  if (error) {
    throw error;
  }

  return { created: Array.isArray(data) && data.length > 0 };
}

export async function enqueueMany(
  admin: SupabaseClient,
  rows: EnqueueEmailInput[],
): Promise<{ createdCount: number }> {
  if (rows.length === 0) {
    return { createdCount: 0 };
  }

  let createdCount = 0;
  const BATCH_SIZE = 200;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const dbRows = chunk.map((r) => {
      if (r.kind === "transactional" && r.template in TEMPLATE_KEYS) {
        validateTemplateData(r.template as TransactionalTemplate, r.data ?? {});
      }
      return {
        kind: r.kind,
        template: r.template,
        user_id: r.userId,
        brand_key: r.brandKey ?? null,
        dedupe_key: r.dedupeKey,
        data: r.data ?? {},
        status: "pending",
      };
    });

    const { data, error } = await admin
      .from("email_outbox")
      .upsert(dbRows, { onConflict: "dedupe_key", ignoreDuplicates: true })
      .select("id");

    if (error) {
      throw error;
    }
    createdCount += Array.isArray(data) ? data.length : 0;
  }

  return { createdCount };
}
