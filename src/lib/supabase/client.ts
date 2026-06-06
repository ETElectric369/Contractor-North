import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser-side Supabase client (uses the public anon key).
 * Row Level Security in the database is what actually protects data.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
