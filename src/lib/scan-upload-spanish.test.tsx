import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOGS, dict, fillText, translator } from "@/lib/i18n";
import { LangProvider } from "@/components/lang-provider";
import { DISCARD_KEPT_LABEL, jobFilingWords, keptElsewhereWords, keptWords, MODEL_LOST_WORDS, scan3dNative } from "@/lib/native-scan";
import { uploadRefusal } from "@/lib/upload-words";
import { measureNative } from "@/lib/native-measure";
import { offerLabel } from "@/lib/playbook/scope";
import { retiredLabel } from "@/lib/playbook/answers";
import { DropTarget } from "@/components/drop-target";
import { TellNort } from "@/components/tell-nort";
import { esTitleCase, titleCaseIn } from "../../tests/title-case-words";

/**
 * THE ENGLISH A SPANISH TECH STILL MET INSIDE THE SHEET (the visit-page-in-Spanish wave, cn-v1144,
 * builder E). The Inspector's own words went to the vi_ catalog (inspector-spanish.test); what was left
 * came from the libraries and the shared pieces the sheet calls — lib/native-scan's kept-model words and
 * Discard Kept 3D Model, lib/upload-words' storage refusal and the words the sheet hands it,
 * lib/native-measure's refusals, lib/playbook/scope's "Add the Deck Tasks (2)", lib/playbook/answers'
 * retired label, the drop zone's own three words, and the whole Just Tell Nort panel.
 *
 * The rule each follows: a library imports no catalog (lib/catalog-free-libs.test.ts); it keeps its
 * English inline as the default, byte for byte, and takes the caller's `lang` + translator for the
 * Spanish (lib/lang-words say) — so every caller and test that hands nothing reads what it always did.
 * The drop zone, drawn on a customer's public pages too, takes the translator as a `words` prop; Just
 * Tell Nort, drawn only inside the app, reads the Nort catalog (nt_) itself. The unit project is node
 * with no DOM, so a drag (the pill, the wrong-type line) is pinned on the source and the catalog. A .tsx,
 * like inspector-spanish.test: the provider and the drop zone take children, which JSX hands them.
 */
const es = translator("es");
const en = translator("en");
const ES = dict("es");
const EN = dict("en");
const vi_ = CATALOGS.find((c) => c.prefix === "vi_")!;
const nt_ = CATALOGS.find((c) => c.prefix === "nt_")!;
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;|’/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => textOf(m[0]));
/** English Title Case through the one judge (tests/title-case-words, cn-v1148). */
const titleCase = (s: string) => titleCaseIn(s, "en");

describe("lib/native-scan speaks the reader's language when handed it, and its English without", () => {
  it("the kept-model words", () => {
    expect(keptWords(false)).toBe("It's kept on this phone — tap 3D Scan again to send it without scanning.");
    expect(keptWords(true)).toBe("The model is up on the visit, so tap 3D Scan again to save it.");
    expect(keptWords(false, "es", es)).toBe("Se quedó en este teléfono — toca Escaneo 3D de nuevo para enviarlo sin escanear.");
    expect(keptWords(true, "es", es)).toBe("El modelo ya está en la visita, así que toca Escaneo 3D de nuevo para guardarlo.");
    // The language decides, not the translator alone: an English reader with a translator in hand reads English.
    expect(keptWords(true, "en", es)).toBe(keptWords(true));
    expect(keptWords(true, "es")).toBe(keptWords(true));
    // The door the sentences name is the one Spanish door the sheet draws (3D Scan = Escaneo 3D).
    expect(ES.vi_btn_scan3d).toBe("Escaneo 3D");
    for (const k of ["vi_keptSendAgain", "vi_keptSaveAgain", "vi_keptElsewhere", "vi_modelLost"]) expect(ES[k], k).toContain("Escaneo 3D");
  });

  it("where a kept model waits: the visit, a task by name, a task that was removed (naming the Discard door in the same language)", () => {
    expect(keptElsewhereWords("the visit")).toBe("The 3D model scanned for the visit is still waiting to send. Tap 3D Scan there to send it.");
    expect(keptElsewhereWords(es("vi_theVisit"), "es", es)).toBe("El modelo 3D escaneado para la visita sigue esperando a enviarse. Toca Escaneo 3D ahí para enviarlo.");
    expect(keptElsewhereWords('"Larkspur deck"', "es", es)).toBe('El modelo 3D escaneado para "Larkspur deck" sigue esperando a enviarse. Toca Escaneo 3D ahí para enviarlo.');
    expect(keptElsewhereWords(null)).toBe(`The kept 3D model was scanned for a task that has been removed. Tap ${DISCARD_KEPT_LABEL}.`);
    expect(keptElsewhereWords(null, "es", es)).toBe("El modelo 3D guardado se escaneó para una tarea que ya se quitó. Toca Descartar el Modelo 3D Guardado.");
    expect(keptElsewhereWords(null, "es", es)).toContain(`Toca ${ES.vi_btn_discardKept3dModel}.`);
    expect(EN.vi_btn_discardKept3dModel).toBe(DISCARD_KEPT_LABEL);
  });

  it("the job's filing: no signal, no access, and everything else said only as far as it is known — in both languages", () => {
    expect(jobFilingWords(new TypeError("Failed to fetch"))).toBe("The 3D model is on the visit, but it didn't file on the job: no signal. Tell the office to file it.");
    expect(jobFilingWords(new TypeError("Failed to fetch"), "es", es)).toBe("El modelo 3D está en la visita, pero no se archivó en el trabajo: sin señal. Dile a la oficina que lo archive.");
    expect(jobFilingWords({ message: "new row violates row-level security policy" }, "es", es)).toBe(
      "El modelo 3D está en la visita, pero no se archivó en el trabajo: esta cuenta no puede archivar ahí. Dile a la oficina que lo archive.",
    );
    expect(jobFilingWords({ message: "new row violates row-level security policy" })).toContain(": this login can't file there.");
    expect(jobFilingWords(null)).toBe("The 3D model is on the visit, but it didn't file on the job. Tell the office to file it.");
    expect(jobFilingWords(null, "es", es)).toBe("El modelo 3D está en la visita, pero no se archivó en el trabajo. Dile a la oficina que lo archive.");
    // Storage's own sentence never reaches the reader in either language.
    expect(jobFilingWords({ message: "new row violates row-level security policy" }, "es", es)).not.toContain("row-level");
  });

  it("3D Scan's own refusal off the bridge (no shell under node): the English, and the Spanish when handed", async () => {
    expect(await scan3dNative()).toEqual({ ok: false, refused: "3D Scan needs the North app on an iPhone with a LiDAR sensor." });
    expect(await scan3dNative(Date.now(), "es", es)).toEqual({ ok: false, refused: "Escaneo 3D necesita la app North en un iPhone con sensor LiDAR." });
    expect(MODEL_LOST_WORDS).toBe(EN.vi_modelLost);
    expect(ES.vi_modelLost).toBe("El modelo no llegó completo desde la cámara, así que se perdió. Toca Escaneo 3D para escanear otra vez.");
    expect(ES.vi_modelTooBig).toMatch(/\{mb\} MB\)\. Escanea un área más pequeña\.$/);
    expect(ES.vi_modelTooBig.endsWith(ES.vi_scanSmallerArea)).toBe(true);
    expect(EN.vi_modelTooBig.endsWith(EN.vi_scanSmallerArea)).toBe(true);
  });
});

describe("lib/upload-words: storage's refusal in the reader's language", () => {
  const tooBig = { message: "The object exceeded the maximum allowed size" };
  it("over the limit, no signal, storage's own sentence as it came, and nothing at all", () => {
    expect(uploadRefusal(tooBig, { what: es("vi_the3dModel"), bytes: 61_924_578, action: es("vi_scanSmallerArea") }, "es", es)).toEqual({
      sentence: "El modelo 3D es demasiado grande para enviarlo (62 MB). Escanea un área más pequeña.",
      final: true,
    });
    expect(uploadRefusal({ message: "Payload too large" }, { what: "planos.pdf", bytes: 7_480_000, action: es("vi_sendSmallerFile") }, "es", es)).toEqual({
      sentence: "planos.pdf es demasiado grande para enviarlo (7.5 MB). Envía un archivo más pequeño.",
      final: true,
    });
    expect(uploadRefusal(new TypeError("Load failed"), { what: "IMG_0412.jpeg", bytes: 400_000, action: es("vi_sendSmallerFile") }, "es", es)).toEqual({
      sentence: "IMG_0412.jpeg no se envió: sin señal. Inténtalo de nuevo donde haya señal.",
      final: false,
    });
    expect(uploadRefusal(null, { what: es("vi_theFile"), bytes: 10, action: es("vi_sendSmallerFile") }, "es", es)).toEqual({ sentence: "No se pudo subir.", final: false });
    const theirs = { message: "new row violates row-level security policy" };
    expect(uploadRefusal(theirs, { what: "a.pdf", bytes: 10, action: es("vi_sendSmallerFile") }, "es", es).sentence).toBe("new row violates row-level security policy");
    expect(uploadRefusal(theirs, { what: "a.pdf", bytes: 10, action: "Send a smaller file." }).sentence).toBe("new row violates row-level security policy");
  });

  it("the English is the default, byte for byte, with or without a translator in hand", () => {
    const o = { what: "The 3D model", bytes: 61_924_578, action: "Scan a smaller area." };
    expect(uploadRefusal(tooBig, o)).toEqual({ sentence: "The 3D model is too big to send (62 MB). Scan a smaller area.", final: true });
    expect(uploadRefusal(tooBig, o, "en", es)).toEqual(uploadRefusal(tooBig, o));
    expect(uploadRefusal(new TypeError("Failed to fetch"), { what: "IMG_0412.jpeg", bytes: 400_000, action: "Send a smaller file." })).toEqual({
      sentence: "IMG_0412.jpeg didn't go: no signal. Try again where there's service.",
      final: false,
    });
    expect(uploadRefusal(null, { what: "a.pdf", bytes: 10, action: "Send a smaller file." })).toEqual({ sentence: "Upload failed.", final: false });
    // One Spanish for "Upload failed." across the app.
    expect(ES.vi_uploadFailed).toBe(ES.sh_uploadFailed);
    expect(ES.vi_uploadFailed).toBe(ES.jb_uploadFailed);
  });
});

describe("lib/native-measure, lib/playbook/scope and lib/playbook/answers", () => {
  it("Measure's refusal off the bridge, in both languages; the caption and the unit are not words and are untouched", async () => {
    expect(await measureNative("length")).toEqual({ ok: false, refused: "Measure needs the North app on an iPhone." });
    expect(await measureNative("area", "es", es)).toEqual({ ok: false, refused: "Medir necesita la app North en un iPhone." });
    expect(ES.vi_btn_measure).toBe("Medir");
    for (const k of ["vi_measureNeedsIphone", "vi_couldntOpenMeasure", "vi_measureNoNumber", "vi_measureSameSpot"]) expect(ES[k], k).toContain("Medir");
    const src = read("src/lib/native-measure.ts");
    expect(src).toContain('const caption = `${mode === "area" ? `${value} sq ft` : feetInches(value)}${lidar ? "" : " (approx.)"}`;');
    expect(src).toContain('unit: mode === "area" ? "sq ft" : "ft",');
  });

  it("the offer row: Title Case in both languages, the company's own scope word as typed, the count in its parentheses", () => {
    expect(offerLabel("deck", 2)).toBe("Add the Deck Tasks (2)");
    expect(offerLabel("deck", 2, "es", es)).toBe("Agregar las Tareas de Deck (2)");
    expect(offerLabel("panel swap", 1, "es", es)).toBe("Agregar las Tareas de Panel Swap (1)");
    expect(offerLabel("deck", 2, "en", es)).toBe("Add the Deck Tasks (2)");
    expect(fillText(EN.vi_btn_addTheScopeTasks, { scope: "Deck", count: "(2)" })).toBe("Add the Deck Tasks (2)");
  });

  it("a retired question's label: the key's own words are data, the why is the catalog's", () => {
    expect(retiredLabel("scope__was")).toBe("Scope — choices you've since changed");
    expect(retiredLabel("scope__was", "es", es)).toBe("Scope — opciones que cambiaste después");
    expect(retiredLabel("deck_sqft__kept", "es", es)).toBe("Deck sqft — respondido antes de que cambiaras esta pregunta");
    expect(retiredLabel("materials_known", "es", es)).toBe("Materials known");
    expect(retiredLabel("deck_sqft__kept")).toBe("Deck sqft — answered before you changed this question");
    // The same "changed since" the sheet's own heading says (vi_fromQuestionsChanged).
    expect(ES.vi_fromQuestionsChanged).toContain("cambiaste después");
    expect(ES.vi_retiredWas).toContain("cambiaste después");
  });
});

describe("the sheet hands its language to every library and drop zone it calls", () => {
  const src = read("src/app/(app)/appointments/[id]/inspector.tsx");
  it("one lang, one translator, every call site", () => {
    expect(src).toContain("const lang = useLang();");
    expect(src).toContain("const t = translator(lang);");
    for (const call of [
      "measureNative(mode, lang, t)",
      "scan3dNative(Date.now(), lang, t)",
      "keptWords(true, lang, t)",
      "keptWords(false, lang, t)",
      "jobFilingWords(copyErr, lang, t)",
      "jobFilingWords(failed.why, lang, t)",
      "offerLabel(word, offer.length, lang, t)",
      "retiredLabel(k, lang, t)",
      '{t("vi_btn_discardKept3dModel")}',
      'keptElsewhereWords(at === null ? t("vi_theVisit") : forTask ? `"${forTask.name.trim() || t("vi_taskNoNameYet")}"` : null, lang, t)',
      'uploadRefusal(e, { what: model ? t("vi_the3dModel") : sending?.name ?? t("vi_theFile"), bytes: sending?.size ?? 0, action: model ? t("vi_scanSmallerArea") : t("vi_sendSmallerFile") }, lang, t)',
      'uploadRefusal(err, { what: sending?.name ?? t("vi_theFile"), bytes: sending?.size ?? 0, action: t("vi_sendSmallerFile") }, lang, t)',
    ]) expect(src, call).toContain(call);
    expect(src.split("<DropTarget ").length - 1).toBe(2);
    expect(src.split(" words={t} className=").length - 1).toBe(2); // both drop zones, the translator in hand
    // The two places a local once shadowed the translator are named for what they are.
    expect(src).not.toContain("const t = at === null");
    expect(src).not.toContain("map(([k, t])");
    expect(src).not.toContain("DISCARD_KEPT_LABEL");
    // What is stored stays as stored: the 3D model's caption and its about.
    expect(src).toContain('{ caption: "3D model", about: "3D Scan" }');
  });

  it("the libraries and the drop zone import no catalog (they ride a customer's bundle), only lib/lang-words", () => {
    for (const f of ["src/lib/native-scan.ts", "src/lib/upload-words.ts", "src/lib/native-measure.ts", "src/lib/playbook/scope.ts", "src/lib/playbook/answers.ts", "src/components/drop-target.tsx"]) {
      const s = read(f);
      expect(s, f).not.toMatch(/from\s+["'](@\/lib\/i18n|@\/lib\/words)/);
      expect(s, f).toContain('from "@/lib/lang-words"');
    }
  });
});

describe("the drop zone's own words", () => {
  const src = read("src/components/drop-target.tsx");
  it("the pill's default, the wrong-type line and the dismiss title come through `words`; the language is the provider's", () => {
    expect(src).toContain('const pill = label ?? say(lang, words, "vi_dropFilesHere", "Drop Files Here");');
    expect(src).toContain('say(lang, words, "vi_fileTypeDoesntGoHere", "That file type doesn\'t go here")');
    expect(src).toContain('title={say(lang, words, "vi_btn_tapToDismiss", "Tap to Dismiss")}');
    expect(src).toContain("const lang = useLang();");
    expect(ES.vi_dropFilesHere).toBe("Suelta los archivos aquí");
    expect(ES.vi_fileTypeDoesntGoHere).toBe("Ese tipo de archivo no va aquí");
    expect(ES.vi_btn_tapToDismiss).toBe("Toca para Cerrar");
    // Drop = Suelta, the way the sheet's own two pills say it.
    for (const k of ["vi_dropThePlans", "vi_dropPhotosPdfs3d", "vi_dropFilesHere"]) expect(ES[k], k).toMatch(/^Suelta /);
  });

  it("renders its children in Spanish with the translator in hand, and in English without", () => {
    const zone = (lang: "es" | "en") => {
      const el = (
        <DropTarget onFiles={() => {}} words={lang === "es" ? es : undefined}>
          <button type="button">{lang === "es" ? "Tomar" : "Take"}</button>
        </DropTarget>
      );
      return renderToStaticMarkup(lang === "es" ? <LangProvider lang="es">{el}</LangProvider> : el);
    };
    expect(buttons(zone("es"))).toEqual(["Tomar"]);
    expect(buttons(zone("en"))).toEqual(["Take"]);
    // No drag under node: the overlay is not drawn, so no pill of either language is in the markup.
    expect(zone("es")).not.toContain("Suelta");
    expect(zone("en")).not.toContain("Drop Files Here");
  });
});

describe("Just Tell Nort speaks Spanish", () => {
  const hear = async () => ({ ok: false, error: "unused" }) as never;
  const render = (over: Record<string, unknown> = {}, lang: "es" | "en" = "es") => {
    const el = createElement(TellNort, { hear, answers: {}, onFilled: () => {}, ...over });
    return renderToStaticMarkup(lang === "es" ? <LangProvider lang="es">{el}</LangProvider> : el);
  };

  it("the open panel: its doors, the box, the hint line, the X and the footnote", () => {
    const html = render({ defaultOpen: true });
    expect(buttons(html)).toEqual(["", "Hablar", "Llenarlo"]);
    expect(html).toContain('placeholder="Di todo el trabajo como se lo dirías a una persona: qué quieren, dónde, cuánto y cualquier cosa que estorbe…"');
    expect(html).toContain('aria-label="Cerrar"');
    expect(textOf(html)).toContain("Dilo todo, como se lo dirías a una persona.");
    expect(textOf(html)).toContain("Revisa las palabras antes de llenar — Nort solo usa lo que está escrito aquí, y no va a deducir una medida que no dijiste. Lo que no pueda ubicar va a tus notas tal cual.");
    const hinted = textOf(render({ defaultOpen: true, hint: "Which panel is it?" }));
    expect(hinted).toContain("Dilo todo — Which panel is it, y cualquier otra cosa que le dirías a alguien.");
    for (const english of ["Talk", "Fill It In", "Say the whole thing", "Check the words", "Close"]) expect(html, english).not.toContain(english);
  });

  it("closed: the door's default label, a surface's own label as it came, and the Nort-off twin without the name", () => {
    expect(buttons(render())).toEqual(["Solo Dile a Nort"]);
    expect(buttons(render({ label: "Tell Nort about your business" }))).toEqual(["Tell Nort about your business"]);
    const off = render({ nortOn: false });
    expect(buttons(off)).toEqual(["Solo Dilo"]);
    expect(off).not.toContain("Nort");
    const offOpen = render({ nortOn: false, defaultOpen: true });
    expect(textOf(offOpen)).toContain("Revisa las palabras antes de llenar — solo usa lo que está escrito aquí");
    expect(offOpen).not.toContain("Nort");
    // The same Spanish for the same door, wherever it is drawn (the sheet passes vi_btn_justTellNort).
    expect(ES.nt_btn_justTellNort).toBe(ES.vi_btn_justTellNort);
  });

  it("in English it is what it was, byte for byte — but the default label, Title Case like every door", () => {
    const html = render({ defaultOpen: true }, "en");
    expect(buttons(html)).toEqual(["", "Talk", "Fill It In"]);
    expect(html).toContain('placeholder="Say the whole job the way you&#x27;d tell a person: what they want, where, how much, and anything in the way…"');
    expect(html).toContain('aria-label="Close"');
    expect(textOf(html)).toContain("Say the whole thing, the way you'd say it to a person.");
    expect(textOf(html)).toContain("Check the words before you fill — Nort only uses what's written here, and it won't work out a measurement you didn't say. Anything it can't place goes in your notes as-is.");
    expect(buttons(render({}, "en"))).toEqual(["Just Tell Nort"]);
    expect(buttons(render({ nortOn: false }, "en"))).toEqual(["Just Say It"]);
    expect(fillText(EN.nt_filledInLook, { list: "Work, Panel" })).toBe("Filled in: Work, Panel — have a look before you price it.");
    expect(fillText(EN.nt_filledInRestInNotes, { list: "Work, Panel" })).toBe("Filled in: Work, Panel · the rest is in your notes — have a look before you price it.");
    expect(fillText(EN.nt_sayTheWholeThingHint, { hint: "Which panel is it" })).toBe("Say the whole thing — Which panel is it, and anything else you'd tell somebody.");
  });

  it("the source reads every word through t(); the Nort catalog names the panel", () => {
    const src = read("src/components/tell-nort.tsx");
    expect(src).toContain('import { useLang } from "@/components/lang-provider";');
    expect(src).toContain('import { fillText, translator } from "@/lib/i18n";');
    expect(src).toContain("const t = translator(useLang());");
    expect(src).toContain('const doorLabel = label ?? t("nt_btn_justTellNort");');
    expect(src).toContain('const boxPlaceholder = placeholder ?? t("nt_tellNortPlaceholder");');
    expect(src).not.toContain("Just tell Nort");
    expect(src).not.toMatch(/setErr\("/);
    expect(src).not.toMatch(/aria-label="[^"]*\p{L}/u);
    expect(nt_.files).toContain("src/components/tell-nort.tsx");
    // The errors the mic path says are the catalog's; the first sentence of Nort's own hear refusal is the same words.
    expect(ES.nt_hearFail.startsWith(ES.nt_couldntHearThat)).toBe(true);
    expect(EN.nt_hearFail.startsWith(EN.nt_couldntHearThat)).toBe(true);
    // Close = Cerrar, Talk = Hablar, one Spanish each, the way the shell and the jobs say them.
    expect(ES.nt_btn_close).toBe(ES.sh_close);
    expect(ES.nt_btn_close).toBe(ES.jb_close);
    expect(ES.nt_btn_talk).toBe("Hablar");
  });
});

describe("the keys this wave added", () => {
  /** Every key builder E added, and the English literal it replaced, byte for byte. */
  const VI: Record<string, string> = {
    vi_btn_discardKept3dModel: "Discard Kept 3D Model",
    vi_keptSendAgain: "It's kept on this phone — tap 3D Scan again to send it without scanning.",
    vi_keptSaveAgain: "The model is up on the visit, so tap 3D Scan again to save it.",
    vi_keptForRemovedTask: "The kept 3D model was scanned for a task that has been removed. Tap {button}.",
    vi_keptElsewhere: "The 3D model scanned for {place} is still waiting to send. Tap 3D Scan there to send it.",
    vi_theVisit: "the visit",
    vi_modelLost: "The model didn't come over from the camera whole, so it's lost. Tap 3D Scan to scan again.",
    vi_jobFiling: "The 3D model is on the visit, but it didn't file on the job. Tell the office to file it.",
    vi_jobFilingWhy: "The 3D model is on the visit, but it didn't file on the job: {why}. Tell the office to file it.",
    vi_whyNoSignal: "no signal",
    vi_whyCantFileThere: "this login can't file there",
    vi_scanNeedsLidarIphone: "3D Scan needs the North app on an iPhone with a LiDAR sensor.",
    vi_couldntOpenScan: "Couldn't open 3D Scan. Try again.",
    vi_modelCameBackEmpty: "The model came back empty. Try again with more light and a slower walk.",
    vi_modelTooBig: "The model is too big to send ({mb} MB). Scan a smaller area.",
    vi_uploadTooBig: "{what} is too big to send ({mb} MB). {action}",
    vi_uploadNoSignal: "{what} didn't go: no signal. Try again where there's service.",
    vi_uploadFailed: "Upload failed.",
    vi_the3dModel: "The 3D model",
    vi_theFile: "The file",
    vi_scanSmallerArea: "Scan a smaller area.",
    vi_sendSmallerFile: "Send a smaller file.",
    vi_measureNeedsIphone: "Measure needs the North app on an iPhone.",
    vi_couldntOpenMeasure: "Couldn't open Measure. Try again, or type the measurement.",
    vi_measureNoNumber: "Measure came back without a number. Try again.",
    vi_measureSameSpot: "Measure came back with nothing — the points sat on the same spot. Try again.",
    vi_btn_addTheScopeTasks: "Add the {scope} Tasks {count}",
    vi_retiredWas: "{base} — choices you've since changed",
    vi_retiredKept: "{base} — answered before you changed this question",
    vi_dropFilesHere: "Drop Files Here",
    vi_fileTypeDoesntGoHere: "That file type doesn't go here",
    vi_btn_tapToDismiss: "Tap to Dismiss",
  };
  const NT: Record<string, string> = {
    // The one English change of the wave: the default label was "Just tell Nort" (lowercase, a door no surface drew);
    // a door is Title Case, and the sheet already passed it so.
    nt_btn_justTellNort: "Just Tell Nort",
    nt_btn_justSayIt: "Just Say It",
    nt_tellNortPlaceholder: "Say the whole job the way you'd tell a person: what they want, where, how much, and anything in the way…",
    nt_sayTheWholeThingHint: "Say the whole thing — {hint}, and anything else you'd tell somebody.",
    nt_sayTheWholeThing: "Say the whole thing, the way you'd say it to a person.",
    nt_btn_close: "Close",
    nt_btn_writingItDown: "Writing It Down…",
    nt_btn_stop: "Stop",
    nt_btn_talk: "Talk",
    nt_btn_filling: "Filling…",
    nt_btn_fillItIn: "Fill It In",
    nt_listeningPressStop: "Listening — press Stop when you’re done.",
    nt_checkWordsNort: "Check the words before you fill — Nort only uses what’s written here, and it won’t work out a measurement you didn’t say. Anything it can’t place goes in your notes as-is.",
    nt_checkWordsPlain: "Check the words before you fill — it only uses what’s written here, and it won’t work out a measurement you didn’t say. Anything it can’t place goes in your notes as-is.",
    nt_couldntHearThat: "Couldn't hear that.",
    nt_didntCatchAnything: "Didn't catch anything.",
    nt_noMicTypeInstead: "No mic — type it instead.",
    nt_noSignalWordsStillHere: "No signal — your words are still here. Try Fill it in again when you're back in range.",
    nt_filledInLook: "Filled in: {list} — have a look before you price it.",
    nt_filledInRestInNotes: "Filled in: {list} · the rest is in your notes — have a look before you price it.",
    nt_nothingMatchedInNotes: "Nothing matched a question — it's in the notes, word for word.",
    nt_couldntPlaceAny: "Couldn't place any of that.",
  };

  it("thirty-two vi_ keys and twenty-two nt_ keys, each its English literal byte for byte, each with a Spanish that differs", () => {
    expect(Object.keys(VI)).toHaveLength(32);
    expect(Object.keys(NT)).toHaveLength(22);
    for (const [k, literal] of Object.entries({ ...VI, ...NT })) {
      expect(en(k), k).toBe(literal);
      expect(es(k), k).not.toBe(literal);
      expect(es(k), k).not.toBe(k);
    }
    for (const k of Object.keys(VI)) expect(k in vi_.en, k).toBe(true);
    for (const k of Object.keys(NT)) expect(k in nt_.en, k).toBe(true);
  });

  it("every slot is in both languages; every _btn_ key is Title Case in both; the sentences re-assembled are the old sentences", () => {
    const slots = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of [...Object.keys(VI), ...Object.keys(NT)]) expect(slots(es(k)), k).toEqual(slots(en(k)));
    for (const k of [...Object.keys(VI), ...Object.keys(NT)].filter((k) => /^(vi|nt)_btn_/.test(k))) {
      expect(titleCase(en(k)), `en:${k} "${en(k)}"`).toBe(true);
      expect(esTitleCase(es(k)), `es:${k} "${es(k)}"`).toBe(true); // Spanish: the significant words (cn-v1147)
    }
    expect(fillText(EN.vi_uploadTooBig, { what: "The 3D model", mb: "62", action: "Scan a smaller area." })).toBe("The 3D model is too big to send (62 MB). Scan a smaller area.");
    expect(fillText(EN.vi_uploadNoSignal, { what: "IMG_0412.jpeg" })).toBe("IMG_0412.jpeg didn't go: no signal. Try again where there's service.");
    expect(fillText(EN.vi_keptForRemovedTask, { button: DISCARD_KEPT_LABEL })).toBe(keptElsewhereWords(null));
    expect(fillText(EN.vi_keptElsewhere, { place: "the visit" })).toBe(keptElsewhereWords("the visit"));
    expect(fillText(EN.vi_jobFilingWhy, { why: "no signal" })).toBe(jobFilingWords(new TypeError("Failed to fetch")));
    expect(fillText(EN.vi_modelTooBig, { mb: "250" })).toBe("The model is too big to send (250 MB). Scan a smaller area.");
    expect(fillText(EN.vi_retiredWas, { base: "Scope" })).toBe(retiredLabel("scope__was"));
    expect(fillText(EN.vi_retiredKept, { base: "Deck sqft" })).toBe(retiredLabel("deck_sqft__kept"));
    expect(fillText(EN.vi_btn_addTheScopeTasks, { scope: "Deck", count: "(7)" })).toBe(offerLabel("deck", 7));
  });

  it("the house words hold across the catalogs: Sin señal, Descartar, Suelta, la oficina, Inténtalo de nuevo", () => {
    expect(ES.vi_whyNoSignal).toBe("sin señal");
    for (const k of ["vi_uploadNoSignal", "vi_jobFilingWhy"]) expect(fillText(ES[k], { what: "x", why: ES.vi_whyNoSignal }), k).toContain("sin señal");
    expect(ES.nt_noSignalWordsStillHere).toMatch(/^Sin señal — /);
    expect(ES.vi_btn_discardKept3dModel).toMatch(/^Descartar /);
    expect(ES.vi_discardKeptConfirm).toMatch(/^¿Descartar /);
    expect(ES.vi_jobFiling).toContain("la oficina");
    expect(ES.cs_theOffice).toBe("la oficina");
    for (const k of ["vi_couldntOpenScan", "vi_modelCameBackEmpty", "vi_couldntOpenMeasure", "vi_measureNoNumber", "vi_measureSameSpot", "vi_uploadNoSignal"]) expect(ES[k], k).toContain("Inténtalo de nuevo");
    expect(ES.vi_theVisit).toBe("la visita");
    expect(ES.vi_keptSaveAgain).toContain("la visita");
  });
});
