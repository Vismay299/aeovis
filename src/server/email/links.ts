import { createHmac, timingSafeEqual } from "node:crypto";
import type { EmailConfig } from "./config.ts";
import type { EmailCategory } from "./types.ts";

export function appLink(cfg: { appUrl: string }, path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${cfg.appUrl.replace(/\/+$/, "")}${cleanPath}`;
}

export function generateUnsubscribeSignature(
  secret: string,
  userId: string,
  category: EmailCategory | string,
): string {
  const payload = `email-unsub:v1:${userId}:${category}`;
  return createHmac("sha256", secret).update(payload).digest("base64url").slice(0, 43);
}

export function unsubscribeUrl(
  cfg: EmailConfig,
  userId: string,
  category: EmailCategory,
): string {
  if (!cfg.linkSecret) {
    return appLink(cfg, "/portal/settings/notifications");
  }
  const sig = generateUnsubscribeSignature(cfg.linkSecret, userId, category);
  const u = encodeURIComponent(userId);
  const c = encodeURIComponent(category);
  const t = encodeURIComponent(sig);
  return `${appLink(cfg, "/email/unsubscribe")}?u=${u}&c=${c}&t=${t}`;
}

export function verifyUnsubscribe(
  cfg: EmailConfig,
  userId: string,
  category: string,
  token: string,
): boolean {
  if (!cfg.linkSecret || !userId || !category || !token) {
    return false;
  }
  const expected = generateUnsubscribeSignature(cfg.linkSecret, userId, category);
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expected);
  if (tokenBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(tokenBuf, expectedBuf);
}
