// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/email/loops.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueEmail } from "./outbox.ts";

export type SignupUserInput = {
  id: string;
  email?: string | null;
  user_metadata?: {
    full_name?: string;
    name?: string;
  };
};

export async function enqueueSignupEmails(
  admin: SupabaseClient,
  user: SignupUserInput,
): Promise<void> {
  try {
    // 1. Upsert default preferences on conflict do nothing
    const { error: prefsError } = await admin.from("user_email_preferences").upsert(
      {
        user_id: user.id,
        product_updates: false,
        product_updates_source: "signup_default",
        scan_results: true,
        schedule_alerts: true,
        spend_alerts: true,
      },
      { onConflict: "user_id", ignoreDuplicates: true },
    );
    if (prefsError) {
      console.warn("[email] signup preferences upsert failed", {
        userId: user.id,
        error: prefsError,
      });
    }

    // 2. Enqueue contact_signup outbox row
    await enqueueEmail(admin, {
      kind: "contact",
      template: "contact_signup",
      userId: user.id,
      brandKey: null,
      dedupeKey: `contact_signup:${user.id}`,
      data: {},
    });

    // 3. Enqueue event_signed_up outbox row
    await enqueueEmail(admin, {
      kind: "event",
      template: "signed_up",
      userId: user.id,
      brandKey: null,
      dedupeKey: `event_signed_up:${user.id}`,
      data: {},
    });
  } catch (error) {
    console.warn("[email] signup enqueue failed", { userId: user.id, error });
  }
}
