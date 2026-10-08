/** Resolve only memberships for an already-created Supabase Auth session. */
export async function resolveCustomerContext(client) {
  if (!client) return { client: null, user: null, brands: [], error: "auth_not_configured" };

  const { data: userData, error: userError } = await client.auth.getUser();
  const user = userData?.user ?? null;
  if (userError || !user) return { client, user: null, brands: [], error: "unauthenticated" };

  const { data, error } = await client
    .from("customer_brand_memberships")
    .select("brand_key, role, customer_brands!inner(brand_key, display_name, website, website_host, aliases, is_active)")
    .eq("user_id", user.id)
    .eq("customer_brands.is_active", true)
    .order("brand_key");

  if (error) return { client, user, brands: [], error: "membership_unavailable", cause: error };

  const brands = (data || []).map((row) => ({
    brandKey: row.brand_key,
    role: row.role,
    ...(Array.isArray(row.customer_brands) ? row.customer_brands[0] : row.customer_brands),
  }));
  return { client, user, brands, error: null };
}

export function findCustomerBrand(brands, key) {
  const normalized = String(key || "").trim().toLowerCase();
  if (!normalized) return null;
  return (brands || []).find((brand) => brand.brandKey === normalized) ?? null;
}
