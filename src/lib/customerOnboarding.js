import { normalizeCustomerBrand } from "./customerProvisioning.js";

/** Validate a new tenant claim before any customer membership is written. */
export function planCustomerOnboarding({ brandName, website, existingBrand }) {
  if (existingBrand) {
    return { error: "This brand already has a workspace. Ask your Perceev contact to assign your account.", reason: "brand_exists" };
  }
  const normalized = normalizeCustomerBrand({ brandName, website });
  if (normalized.error) return { error: normalized.error, reason: "invalid_input" };
  return { value: { brand: normalized.value } };
}