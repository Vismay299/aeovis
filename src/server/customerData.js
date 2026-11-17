export function hostFromUrl(value) {
  try {
    return new URL(String(value || "")).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Customer scan ownership is explicit; labels and URLs are metadata. */
export function rowBelongsToCustomerBrand(row, brand) {
  return !!row && !!brand && row.brand_key === brand.brandKey;
}
