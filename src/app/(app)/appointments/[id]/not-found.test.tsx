import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOGS, translator } from "@/lib/i18n";
import { visitHome } from "@/lib/appointments/visit-home";
import { titleCaseIn } from "../../../../../tests/title-case-words";

/**
 * A VISIT THAT IS NOT THERE IS SAID INSIDE THE APP (cn-v1157; skeptic #60).
 *
 * Deleting a visit from its own page replaces the open SHEET's history entry with the list; the
 * visit's own entry stays under it, so one Back from the list asks for the deleted visit. Its page
 * answers notFound(), and with no boundary in its folder that was the app's ROOT 404: no dock, no top
 * bar. The boundary added beside the page keeps the (app) layout around the answer.
 *
 * The page is rendered here for the office and for a tech, in both languages. Who is looking decides
 * the sentence and the doors (lib/appointments/visit-home: a tech has neither Inspections nor the
 * Schedule; 0227: a tech reads only the visits assigned to them). The session and the profile are
 * faked; nothing here opens a database.
 */
const who = vi.hoisted(() => ({ user: { id: "u1" } as { id: string } | null, lang: "en" as "en" | "es", role: "owner" as string | null, broken: false }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (who.broken) throw new Error("no session to read");
    return { auth: { getUser: async () => ({ data: { user: who.user } }) } };
  },
}));
vi.mock("@/lib/current-lang", () => ({
  currentLangFor: async () => who.lang,
  signedInProfile: async () => ({ data: who.role ? { role: who.role } : null, error: null }),
}));

const { default: VisitNotFound } = await import("./not-found");

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const doors = (html: string) => [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ href: m[1], words: text(m[2]) }));
const page = async (over: Partial<typeof who> = {}) => {
  Object.assign(who, { user: { id: "u1" }, lang: "en", role: "owner", broken: false }, over);
  return renderToStaticMarkup(await VisitNotFound());
};

describe("the office: the visit is gone, and the two places a visit lives are one tap away", () => {
  it("English: one true sentence, then Back to Inspections and Back to Schedule", async () => {
    const html = await page({ role: "office" });
    expect(text(html)).toContain("This visit is no longer on file: it was deleted, or it never existed.");
    expect(doors(html)).toEqual([
      { href: "/inspections", words: "Back to Inspections" },
      { href: "/schedule", words: "Back to Schedule" },
    ]);
  });

  it("Spanish (tú): the same page, no English left on it", async () => {
    const html = await page({ lang: "es" });
    expect(text(html)).toContain("Esta visita ya no está en el archivo: se eliminó o nunca existió.");
    expect(doors(html)).toEqual([
      { href: "/inspections", words: "Volver a Inspecciones" },
      { href: "/schedule", words: "Volver a la Agenda" },
    ]);
    expect(text(html)).not.toMatch(/\bBack\b|\bvisit\b|Schedule|Inspections|deleted/);
  });

  it("the hrefs are the visit-home rule's own, so the way out of a missing visit is where a visit lives", async () => {
    const hrefs = doors(await page()).map((d) => d.href);
    expect(hrefs).toEqual([visitHome("inspection").href, visitHome("service_call").href]);
    for (const role of ["owner", "admin", "office"]) expect(doors(await page({ role })).map((d) => d.href), role).toEqual(hrefs);
  });
});

describe("a tech: the visit may simply not be theirs, and their way out is My Day", () => {
  it("says so in both languages and offers the one door a tech has", async () => {
    const en = await page({ role: "tech" });
    expect(text(en)).toContain("You can't open this visit: it was deleted, or it is not assigned to you.");
    expect(doors(en)).toEqual([{ href: "/planner", words: "Back to My Day" }]);
    const es = await page({ role: "tech", lang: "es" });
    expect(text(es)).toContain("No puedes abrir esta visita: se eliminó o no está asignada a ti.");
    expect(doors(es)).toEqual([{ href: "/planner", words: "Volver a Mi Día" }]);
    expect(doors(en)[0].href).toBe(visitHome(null, { staff: false }).href);
    // Never the office's doors, which would only bounce a tech back to My Day under another name.
    expect(en).not.toContain("/inspections");
    expect(en).not.toContain("/schedule");
  });

  it("why a tech's sentence differs: appointments are readable by the office, or by the person assigned (0227)", () => {
    const policy = src("supabase/migrations/0227_a_tech_can_see_their_own_appointment.sql");
    expect(policy).toContain("and (public.is_org_staff() or assigned_to = auth.uid())");
  });
});

describe("it never fails to draw", () => {
  it("nobody signed in, a role that cannot be read, a session that will not open: the office's page, in English", async () => {
    for (const over of [{ user: null }, { role: null }, { broken: true }] as Partial<typeof who>[]) {
      const html = await page(over);
      expect(text(html), JSON.stringify(over)).toContain("This visit is no longer on file");
      expect(doors(html).map((d) => d.href), JSON.stringify(over)).toEqual(["/inspections", "/schedule"]);
    }
  });
});

describe("the doors", () => {
  it("are Title Case in both languages (the significant words)", () => {
    for (const key of ["vp_btn_backToInspections", "vp_btn_backToSchedule", "vp_btn_backToMyDay"]) {
      for (const lang of ["en", "es"] as const) {
        const words = translator(lang)(key);
        expect(titleCaseIn(words, lang), `${lang}:${key} "${words}"`).toBe(true);
      }
    }
    expect(translator("en")("vp_btn_backToInspections")).not.toBe(translator("es")("vp_btn_backToInspections"));
  });

  it("are 44px tall: each is the house Button at its default size, inside its link", async () => {
    for (const role of ["owner", "tech"]) {
      const html = await page({ role });
      const links = html.match(/<a[^>]*href=/g) ?? [];
      const tall = html.match(/<a[^>]*href="[^"]+"[^>]*><button[^>]*class="[^"]*\bh-11\b[^"]*"/g) ?? [];
      expect(tall, role).toHaveLength(links.length);
      expect(links.length, role).toBe(role === "tech" ? 1 : 2);
    }
  });
});

describe("where it sits, and what it answers", () => {
  it("the boundary is in the visit's own folder, so the (app) layout stays around it; the page still answers notFound()", () => {
    expect(existsSync(join(process.cwd(), "src/app/(app)/appointments/[id]/not-found.tsx"))).toBe(true);
    expect(src("src/app/(app)/appointments/[id]/page.tsx")).toContain("if (!appt) notFound();");
    // The root page is the one with no shell: its only door is the dashboard, and it stays for every other address.
    expect(src("src/app/not-found.tsx")).toContain('<Link href="/planner" className="mt-5">');
    // A not-found boundary takes no props and exports its page only.
    const file = src("src/app/(app)/appointments/[id]/not-found.tsx");
    expect(file).toContain("export default async function VisitNotFound() {");
    expect(file.match(/^export /gm)).toHaveLength(1);
  });

  it("the delete door's comment says what the replace really replaces (the sheet's entry, not the visit's)", () => {
    const form = src("src/app/(app)/appointments/appointment-button.tsx");
    const remove = form.slice(form.indexOf("function remove()"), form.indexOf("\n  return (", form.indexOf("function remove()")));
    expect(remove).toContain("WHAT THE REPLACE REPLACES IS THE SHEET'S ENTRY, NOT THE VISIT'S.");
    expect(remove).toContain("ONE BACK FROM THE LIST ASKS FOR THE");
    expect(remove).toContain("[id]/not-found.tsx");
    expect(remove).not.toContain("this entry must not be one Back can return to"); // the claim that was not true
    expect(remove).toContain('if (afterDeleteHref) return leave("replace", afterDeleteHref);');
  });

  it("the visit page's catalog names the file, so the English-leak scan reads it, and holds its three words in both languages", () => {
    const vp = CATALOGS.find((c) => c.prefix === "vp_")!;
    expect(vp.files).toContain("src/app/(app)/appointments/[id]/not-found.tsx");
    for (const key of ["vp_visitGone", "vp_visitGoneTech", "vp_btn_backToInspections"]) {
      expect(vp.en[key], key).toBeTruthy();
      expect(vp.es[key], key).toBeTruthy();
      expect(vp.es[key], key).not.toBe(vp.en[key]);
    }
  });
});
