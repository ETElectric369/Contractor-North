import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * "DONE AS <JOB>?" (cn-v1175, R5): one tap asks in place, the yes is the visit's own attach door
 * (linkAppointmentTo, kind "job"), never the browser's dialog. Made-up records only.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("../appointments/actions", () => ({ linkAppointmentTo: vi.fn() }));

const { LangProvider } = await import("@/components/lang-provider");
const { translator } = await import("@/lib/i18n");
const { VisitOfferButton, VisitOfferAsk, tieVisitToJob } = await import("./visit-offer-button");

const JOB = { id: "job-900", label: "J-900 Larkspur panel" };
const decode = (s: string) => s.replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("the offer's button and its ask", () => {
  it("the button names the job, in both languages", () => {
    const en = renderToStaticMarkup(
      <LangProvider lang="en">
        <VisitOfferButton visitId="v1" job={JOB} className="x" />
      </LangProvider>,
    );
    expect(decode(en)).toBe("Done as J-900 Larkspur panel?");
    expect(en).toContain('data-offer="job-900"');
    const es = renderToStaticMarkup(
      <LangProvider lang="es">
        <VisitOfferButton visitId="v1" job={JOB} className="x" />
      </LangProvider>,
    );
    expect(decode(es)).toBe("¿Terminada como J-900 Larkspur panel?");
  });

  it("the ask in place: the question, the yes naming the job, Keep It; in both languages", () => {
    const face = (lang: "en" | "es") =>
      decode(
        renderToStaticMarkup(
          <LangProvider lang={lang}>
            <VisitOfferAsk job={JOB} pending={false} onYes={() => {}} onKeep={() => {}} />
          </LangProvider>,
        ),
      );
    expect(face("en")).toBe("Tie this inspection to J-900 Larkspur panel? It is marked Won with that job and leaves this list. Yes, Done as J-900 Larkspur panel Keep It");
    expect(face("es")).toContain("¿Unir esta inspección a J-900 Larkspur panel?");
    expect(face("es")).toContain("Sí, Terminada como J-900 Larkspur panel");
  });

  it("the yes is the existing attach door with the job, said, and the list re-reads", async () => {
    const link = vi.fn(async () => ({ ok: true, note: "Its tasks went to the job." }));
    const toast = vi.fn();
    const refresh = vi.fn();
    const landed = await tieVisitToJob("v1", JOB, { toast: toast as any, refresh, t: translator("en") }, { link: link as any });
    expect(landed).toBe(true);
    expect(link).toHaveBeenCalledWith("v1", "job", "job-900");
    expect(toast).toHaveBeenNthCalledWith(1, "Tied to J-900 Larkspur panel.", "success");
    expect(toast).toHaveBeenNthCalledWith(2, "Its tasks went to the job.", "info", undefined, { sticky: true });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a refusal is said and nothing re-reads; no connection is said in the reader's language", async () => {
    const toast = vi.fn();
    const refresh = vi.fn();
    expect(await tieVisitToJob("v1", JOB, { toast: toast as any, refresh, t: translator("en") }, { link: (async () => ({ ok: false, error: "No access." })) as any })).toBe(false);
    expect(toast).toHaveBeenLastCalledWith("No access.", "error");
    const offline = async () => {
      throw new Error("offline");
    };
    expect(await tieVisitToJob("v1", JOB, { toast: toast as any, refresh, t: translator("es") }, { link: offline as any })).toBe(false);
    expect(toast).toHaveBeenLastCalledWith(translator("es")("vp_thatDidntSave"), "error");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("never the browser's dialog; the card draws the offer in the boxed button's place", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/inspections/visit-offer-button.tsx"), "utf8");
    expect(src).not.toMatch(/\bconfirm\(|window\.confirm/);
    const card = readFileSync(join(process.cwd(), "src/app/(app)/inspections/inspection-list.tsx"), "utf8");
    expect(card).toContain("<VisitOfferButton visitId={row.id} job={row.offer} className={PRIMARY} />");
  });
});
