import { createClient } from "@supabase/supabase-js";

/** True when the server has the service-role key (enables admin features
 *  like creating employee logins without an email invite). */
export function adminConfigured(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL);
}

/** Service-role client — server only, bypasses RLS. Never expose to the browser. */
export function createAdminClient() {
  if (!adminConfigured()) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set.");
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
