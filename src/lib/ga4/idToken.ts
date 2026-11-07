// Patterned after openseo:src/server/features/google/googleIdToken.ts (OIDC Core 1.0 §3.1.3.7).
// Claims validation without external JWKS verification since tokens are fetched directly over TLS.

export interface IdTokenClaims {
  sub: string;
  email: string | null;
}

export function readIdTokenClaims(idToken: string, clientId: string, nowMs: number = Date.now()): IdTokenClaims {
  if (!idToken || typeof idToken !== "string") {
    throw new Error("Missing or invalid id_token");
  }
  const parts = idToken.split(".");
  if (parts.length < 2) {
    throw new Error("Malformed id_token");
  }
  let payload: Record<string, unknown>;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    payload = JSON.parse(json);
  } catch {
    throw new Error("Failed to decode id_token payload");
  }

  const { iss, aud, exp, sub, email } = payload;

  const validIssuers = ["https://accounts.google.com", "accounts.google.com"];
  if (typeof iss !== "string" || !validIssuers.includes(iss)) {
    throw new Error(`Invalid id_token issuer: ${iss}`);
  }

  const audValid = typeof aud === "string" ? aud === clientId : Array.isArray(aud) && aud.includes(clientId);
  if (!audValid) {
    throw new Error("Invalid id_token audience");
  }

  const nowSec = Math.floor(nowMs / 1000);
  if (typeof exp !== "number" || exp <= nowSec) {
    throw new Error("id_token has expired");
  }

  if (typeof sub !== "string" || !sub.trim()) {
    throw new Error("Missing or empty id_token sub");
  }

  const userEmail = typeof email === "string" && email.trim() ? email.trim() : null;

  return {
    sub: sub.trim(),
    email: userEmail,
  };
}
