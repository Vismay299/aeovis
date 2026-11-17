// Module-resolution hooks for the F22 assistant route tests. They reuse the
// customer-route hooks: only the authenticated context and the Supabase admin
// client are substituted, so the real route handlers still run.
export { resolve } from "../customerRoutes.test.hooks.mjs";
