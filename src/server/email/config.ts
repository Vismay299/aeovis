import type { TransactionalTemplate } from "./types.ts";

export type EmailConfig = {
  apiKey: string | null;
  productUpdatesListId: string | null;
  templateIds: Record<TransactionalTemplate, string | null>;
  linkSecret: string | null;
  appUrl: string;
};

export function readEmailConfig(
  env: Record<string, string | undefined> = process.env,
): EmailConfig {
  const apiKey = env.LOOPS_API_KEY?.trim() || null;
  const productUpdatesListId = env.LOOPS_PRODUCT_UPDATES_LIST_ID?.trim() || null;
  const templateIds: Record<TransactionalTemplate, string | null> = {
    scan_finished: env.LOOPS_TX_SCAN_FINISHED_ID?.trim() || null,
    schedule_skipped: env.LOOPS_TX_SCHEDULE_SKIPPED_ID?.trim() || null,
    spend_cap_reached: env.LOOPS_TX_SPEND_CAP_ID?.trim() || null,
  };
  const rawSecret = env.EMAIL_LINK_SECRET?.trim() || null;
  const linkSecret = rawSecret && rawSecret.length >= 32 ? rawSecret : null;
  const rawAppUrl = env.NEXT_PUBLIC_APP_URL?.trim() || env.APP_URL?.trim() || "https://perceev.com";
  const appUrl = rawAppUrl.replace(/\/+$/, "");

  return {
    apiKey,
    productUpdatesListId,
    templateIds,
    linkSecret,
    appUrl,
  };
}
