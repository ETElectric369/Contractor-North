import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { fakeDb, type Row } from "@/test/fake-supabase";
import { textOf } from "@/test/rendered-page";
import { words as nav } from "@/lib/words/nav";

/**
 * AN OFFICE PAGE'S TITLE, RENDERED IN THE PERSON'S LANGUAGE (cn-v1139, the map in Spanish).
 *
 * Every office page is a server component with a session: it opens the request's Supabase client,
 * reads its profile, and since cn-v1139 asks lib/current-lang for the language its <PageHeader>
 * speaks. A test proves the words by rendering THE PAGE (react-dom/server on the real default
 * export, the way bills-page-doors.test.ts renders /bills), over the fake database in
 * test/fake-supabase and these four module stand-ins, which each page test installs with vi.mock:
 *
 *   @/lib/supabase/server   createClient → a thenable query builder over officeState.tables, with
 *                           one signed-in owner (u1) so a staff-only page never redirects;
 *   @/lib/current-lang      currentLangFor / currentLang → officeState.lang (the real ones read the
 *                           request's profile row and cookies);
 *   next/navigation         the client hooks the page's body needs, and a redirect that THROWS, so
 *                           a page that sends the fixture owner away fails loudly;
 *   next/link               a plain <a>.
 *
 * renderHeader hands back the <h1> and its line as a person reads them; pageReadsTheMap pins the
 * source: the language read once through currentLangFor(user?.id) — the page's own session, one
 * cached profile row, no second getUser — the words through nv_page_ / nv_desc_, and the old
 * literal gone. A page with no id in scope (door: "none") reads currentLang() instead, the no-id
 * door: one getUser, then the same cached row. Every name here is invented.
 */
export const ORG = "org-1";

export const officeState = {
  lang: "en" as "en" | "es",
  tables: {} as Record<string, Row[]>,
};

/** The fixture company and its owner, plus whatever rows one page wants planted. */
export function resetOfficeTables(extra: Record<string, Row[]> = {}): void {
  officeState.lang = "en";
  officeState.tables = {
    profiles: [{ id: "u1", org_id: ORG, role: "owner", active: true, full_name: "Larkspur Lee", language: null, organizations: { settings: {} } }],
    organizations: [{ id: ORG, name: "Larkspur Electric", settings: {} }],
    ...extra,
  };
}

/** What `@/lib/supabase/server` becomes: the request's client, over the fixture tables as they stand. */
export function supabaseServerModule() {
  const client = () => {
    const db = fakeDb(officeState.tables);
    return { auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) }, from: db.sb.from, rpc: db.sb.rpc };
  };
  return { createClient: async () => client(), createServiceClient: () => client() };
}

/** What `@/lib/current-lang` becomes: the language the test chose, read from nowhere. */
export function currentLangModule() {
  return {
    currentLang: async () => officeState.lang,
    currentLangFor: async () => officeState.lang,
    signedInProfile: async () => ({ data: officeState.tables.profiles?.[0] ?? null, error: null }),
  };
}

/** What `next/navigation` becomes: inert client hooks, and a redirect that fails the test. */
export function navigationModule() {
  return {
    useRouter: () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} }),
    useSearchParams: () => new URLSearchParams(),
    usePathname: () => "/",
    redirect: (to: string) => {
      throw new Error(`the page redirected the fixture owner to ${to}`);
    },
    notFound: () => {
      throw new Error("the page answered notFound()");
    },
  };
}

/** What `next/link` becomes: an <a>. */
export function linkModule() {
  return { default: ({ children, href }: { children?: unknown; href: string }) => createElement("a", { href }, children as never) };
}

/** The <h1> and the line under it, as a person reads them (entities decoded, tags dropped). */
export function headerOf(html: string): { title: string; description: string | undefined } {
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  if (!h1) throw new Error("no <h1> on the page");
  const line = /<\/h1><p class="mt-1 text-sm text-slate-500">([\s\S]*?)<\/p>/.exec(html);
  return { title: textOf(h1[1]).trim(), description: line ? textOf(line[1]).trim() : undefined };
}

/** Render the page's default export in `lang` and read its header. */
export async function renderHeader<P>(
  page: (props: P) => Promise<unknown>,
  lang: "en" | "es",
  props?: P,
): Promise<{ title: string; description: string | undefined; html: string }> {
  officeState.lang = lang;
  const html = renderToStaticMarkup((await page(props as P)) as ReactElement);
  return { ...headerOf(html), html };
}

/** The catalog's two dictionaries, for a test that compares a line to its Spanish. */
export const catalog = { en: nav.en, es: nav.es };

/**
 * The source pins: the page reads the language ONCE — through currentLangFor with the id its own
 * session already holds (no second getUser, never a second profile query for it), or, for a page
 * with no id in scope, through the no-id door currentLang() — its title and line come through the
 * map's keys, and the English literal is gone.
 */
export function pageReadsTheMap(file: string, slug: string, opts: { description?: boolean; door?: "id" | "none" } = {}): void {
  const src = readFileSync(join(process.cwd(), "src/app/(app)", file), "utf8");
  if (opts.door === "none") {
    // No id in scope: the page never calls auth.getUser() itself, so the no-id door is its one call.
    expect(src).toContain('import { currentLang } from "@/lib/current-lang";');
    expect(src).not.toContain("auth.getUser()");
    expect(src.match(/translator\(await currentLang\(\)\)/g) ?? [], `${file} reads currentLang once`).toHaveLength(1);
    expect(src).toContain("const t = translator(await currentLang());");
  } else {
    expect(src).toContain('import { currentLangFor } from "@/lib/current-lang";');
    expect(src).not.toContain("currentLang()");
    const calls = src.match(/translator\(await currentLangFor\((user\?\.id|user\.id|ctx\.userId|userId)\)\)/g) ?? [];
    expect(calls, `${file} reads currentLangFor once, with the id its session already holds`).toHaveLength(1);
    // The id came from the page's own session read, which sits above the language call.
    const session = src.search(/auth\.getUser\(\)|await requireStaff\(\)/);
    expect(session, `${file} resolves its session itself`).toBeGreaterThan(-1);
    expect(session).toBeLessThan(src.indexOf("await currentLangFor("));
  }
  expect(src).toContain(`title={t("nv_page_${slug}")}`);
  if (opts.description !== false) expect(src).toContain(`description={t("nv_desc_${slug}")}`);
  expect(src, `${file} still carries the English title literal`).not.toContain(`title="${nav.en[`nv_page_${slug}`]}"`);
}
