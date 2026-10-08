import crypto from "crypto";

/**
 * AES-256-GCM encryption for OAuth tokens.
 *
 * Uses a random 12-byte nonce per record and workspace/credential identity as
 * additional authenticated data (AAD). Ciphertext, nonce, auth tag, and key
 * version are stored together. Decryption fails closed on key mismatch.
 *
 * Env: GSC_TOKEN_ENCRYPTION_KEY — 32-byte key, hex-encoded (64 hex chars).
 * Key version allows rotation; current version is 1.
 */

const ALGORITHM = "aes-256-gcm";
const NONCE_LENGTH = 12;
const CURRENT_KEY_VERSION = 1;

function getEncryptionKey() {
  const hex = (process.env.GSC_TOKEN_ENCRYPTION_KEY || "").trim();
  if (!hex || hex.length !== 64) return null;
  try {
    return Buffer.from(hex, "hex");
  } catch {
    return null;
  }
}

export function isEncryptionConfigured() {
  return !!getEncryptionKey();
}

/**
 * Encrypt a plaintext string.
 * @param {string} plaintext
 * @param {string} aad - additional authenticated data (e.g. "brand_key:credential_id")
 * @returns {{ ciphertext: string, nonce: string, tag: string, keyVersion: number }}
 */
export function encryptToken(plaintext, aad = "") {
  const key = getEncryptionKey();
  if (!key) throw new Error("GSC_TOKEN_ENCRYPTION_KEY is not configured.");

  const nonce = crypto.randomBytes(NONCE_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, nonce, { authTagLength: 16 });

  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));

  let encrypted = cipher.update(String(plaintext), "utf8", "base64");
  encrypted += cipher.final("base64");
  const tag = cipher.getAuthTag();

  return {
    ciphertext: encrypted,
    nonce: nonce.toString("base64"),
    tag: tag.toString("base64"),
    keyVersion: CURRENT_KEY_VERSION,
  };
}

/**
 * Decrypt a ciphertext.
 * @param {{ ciphertext: string, nonce: string, tag: string, keyVersion?: number }} encrypted
 * @param {string} aad - must match the AAD used during encryption
 * @returns {string} plaintext
 */
export function decryptToken(encrypted, aad = "") {
  const key = getEncryptionKey();
  if (!key) throw new Error("GSC_TOKEN_ENCRYPTION_KEY is not configured.");

  const nonce = Buffer.from(encrypted.nonce, "base64");
  const tag = Buffer.from(encrypted.tag, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce, { authTagLength: 16 });

  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));

  let decrypted = decipher.update(encrypted.ciphertext, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/**
 * Hash a value for storage (e.g. OAuth state hash).
 * @param {string} value
 * @returns {string} hex-encoded SHA-256
 */
export function hashValue(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

/**
 * Generate a cryptographically random string suitable for OAuth state.
 * @param {number} bytes
 * @returns {string} URL-safe base64 string
 */
export function generateSecureRandom(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}