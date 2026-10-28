import { asLang, type Lang } from "@/lib/locale";
import { reportError } from "@/lib/observe";

/**
 * WHO READS WHICH LANGUAGE (cn-v1138). profiles.language is the one source of truth; these are the
 * two reads of it a server needs: a sender writing one line per person (langOf: many ids, one
 * select, chunked at 200 so PostgREST's URL never overflows) and an action answering the person who
 * called it (callerLang). Both answer ENGLISH on any failure and never throw — a text, a push or a
 * bell line must still go out when the language read fails, and the failure is filed, not swallowed
 * (lang-of:read with the chunk's count; never an id).
 *
 * THREE COMPANIES, ONE DATABASE: langOf runs on the service client, which RLS does not scope, so a
 * sender that knows the company passes its id and the read carries `.eq("org_id", …)`; a stranger's
 * id in the list then answers "en", never that stranger's row. callerLang takes the signed-in id
 * when the caller already has it (one round trip on a punch, not two).
 *
 * Typed loosely (the PostgREST builder shape, the way lib/cron-orgs types its client) so a caller
 * can hand it the service client, the caller's session client, or a test's fake.
 */
type Client = {
  from: (table: string) => any;
  auth?: { getUser: () => Promise<{ data: { user: { id: string } | null } }> };
};

const CHUNK = 200;

/** Every requested id is in the map; one that is missing, unreadable or blank is "en". With `orgId`
 *  the read names the company (the service client reads across companies without it). */
export async function langOf(sb: Client, profileIds: string[], orgId?: string | null): Promise<Map<string, Lang>> {
  const ids = Array.from(new Set((profileIds ?? []).filter((x): x is string => typeof x === "string" && !!x)));
  const out = new Map<string, Lang>();
  for (const id of ids) out.set(id, "en");
  for (let at = 0; at < ids.length; at += CHUNK) {
    const chunk = ids.slice(at, at + CHUNK);
    try {
      let q = sb.from("profiles").select("id, language").in("id", chunk);
      if (orgId) q = q.eq("org_id", orgId);
      const { data, error } = await q;
      if (error) throw error;
      for (const row of (data ?? []) as { id?: string | null; language?: string | null }[]) {
        if (row?.id && out.has(row.id)) out.set(row.id, asLang(row.language));
      }
    } catch (e) {
      reportError("lang-of:read", e, { count: chunk.length });
    }
  }
  return out;
}

/** The signed-in person's language, or "en" when there is nobody or the read fails. A caller that
 *  already resolved the session passes `userId` and no second getUser round trip is made. */
export async function callerLang(sb: Client, userId?: string | null): Promise<Lang> {
  try {
    const id = userId || (await sb.auth?.getUser())?.data?.user?.id;
    if (!id) return "en";
    const { data, error } = await sb.from("profiles").select("language").eq("id", id).limit(1).maybeSingle();
    if (error) return "en";
    return asLang((data as { language?: string | null } | null)?.language);
  } catch {
    return "en";
  }
}
