"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, MapPin, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";
import { useSaveInFlight } from "@/lib/saves-in-flight";
import { formatCityStateZip } from "@/lib/utils";
import { siteLines } from "@/lib/site-address";
import { jobLabelWithNumber } from "@/lib/schedule-options";
import {
  commitQuoteSite,
  quoteSiteChoices,
  quoteSiteRecordsNow,
  quoteSiteView,
  siteBoxesDiffer,
  siteBoxesFrom,
  siteBoxesPicked,
  siteBoxesReady,
  siteBoxesTyped,
  siteBoxesWrite,
  siteChoiceInUse,
  siteChoicesShort,
  siteOneLine,
  siteWriteFor,
  siteWritten,
  siteWrittenStands,
  type OtherJobSite,
  type QuoteSiteInput,
  type QuoteSiteRecords,
  type QuoteSiteSource,
  type SiteBoxes,
  type SiteChoice,
  type SiteWritten,
} from "@/lib/quote-site";
import { setQuoteSite } from "../actions";

/** What the estimate's page reads for the line (quotes/[id]/page) and the one editor hands on. */
export interface JobSiteData {
  /** The four records the paper picks its site from, each as its own five address columns. */
  records: QuoteSiteRecords;
  /** The job this estimate is on (quotes.job_id), or null. A job owns its site. */
  job: { id: string; job_number: string | null; name: string | null } | null;
  /** The customer's other jobs, newest first, for the picker. Empty when there is no customer, or a job. */
  otherJobs: OtherJobSite[];
  /** That read failed. Said in the picker: a failed read is never shown as "no other addresses". */
  otherJobsFailed: boolean;
  /** That read came back as long as it may be (lib/quote-site siteJobsReadFull), so older jobs may hold
   *  addresses it never reached. Said in the picker too: a short list says it is short. */
  otherJobsFull: boolean;
}

/** Where the printed address comes from, in a quiet word under it. */
const SOURCE_WORDS: Record<QuoteSiteSource, string> = {
  quote: "qt_siteSetHere",
  job: "qt_siteFromTheJob",
  lead: "qt_siteFromTheLead",
  customer: "qt_siteFromTheCustomer",
};

const QUIET_DOOR = "inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800";
const AMBER = "mt-1.5 rounded-md bg-amber-50 px-2 py-1 text-sm text-amber-800";

/**
 * THE JOB SITE LINE (cn-v1158). The owner, 2026-11-10, pricing a unit for a customer that owns two
 * complexes at two addresses: "i think we already have a Site option on the jobs/customers so im
 * thinking we need to have sites available to pick from on the estimate sheet, it might already be
 * in place just not visible".
 *
 * It says the address the PAPER will print (lib/quote-site quoteSiteView, the same ordered list the
 * print page reads) and, in a quiet word, where that address comes from: set on this estimate, from
 * the job, from the lead, from the customer. No job site at all, and an address short of its town,
 * are said in amber: a gap a person can see beats a partial address on signed paper. The amber line
 * about the town names the ONE thing to do about it, by where the address can be fixed: this sheet
 * for an estimate with no job, the job for an estimate on one.
 *
 * CHANGE JOB SITE opens one sheet: the addresses already on file as rows (one tap picks; the one in
 * use is marked), then A Different Address with the app's own address box and a Unit box. The first
 * row is the record the estimate falls back to (its lead, else its customer): picking it CLEARS the
 * estimate's own address, so the estimate follows that record and a correction made there reaches
 * it. Every other row, and a typed address, is written onto the estimate itself. That is the one
 * rule in lib/quote-site (siteWriteFor); the sheet only draws it. A list the read or the picker cut
 * short says so under its rows (siteChoicesShort), and points at the boxes below it.
 *
 * THE BOXES OPEN WITH THE ADDRESS THE PAPER PRINTS NOW (siteBoxesFrom), whoever's it is. The owner,
 * 2026-11-10, about a unit in a complex: "it auto-populated to both positions with no other way to
 * pick the site ... nor input a unit number other than the title". So adding a unit is Change Job
 * Site, type the unit, Use This Address: the street is never typed twice.
 *
 * WHAT WAS JUST SAVED IS WHAT IT READS. A save lands a moment before the page's own read does, so
 * the line remembers the write and reads it as the estimate's own address until that read arrives
 * (quoteSiteRecordsNow): the address beside "Saved" is the new one, and the sheet opened again in
 * that moment starts from it. State only; nothing is remounted.
 *
 * AN ESTIMATE ON A JOB HAS NO PICKER: the job owns its site, so the line shows it and opens the job.
 * The one thing it still offers is Use the Job's Address, and only when the estimate carries an
 * address of its own that is no longer the job's (the estimate's own outranks the job's on the
 * paper, so without that door the two could never be brought back together).
 *
 * One fact, one place: the lead's address used to be drawn on the customer card above. It is this
 * line's now; the card keeps Edit Lead, which is the way to correct the LEAD's own address.
 */
export function JobSiteLine({ quoteId, records, job, otherJobs, otherJobsFailed, otherJobsFull }: { quoteId: string } & JobSiteData) {
  const router = useRouter();
  const lang = useLang();
  const t = translator(lang);
  const [pending, start] = useTransition();
  // THE TAP IS A SAVE, SO IT IS COUNTED: the header's Preview waits for the count (lib/saves-in-flight),
  // and the job site is on the paper it shows. Counting only; the write itself is in save() below.
  useSaveInFlight(pending);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // The "Saved" word clears itself after two seconds; the timer dies with the line (and with a second save).
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);
  // A Different Address: the street as typed, the town a pick resolved for it, and the unit. One
  // value, changed only through lib/quote-site's own rules (siteBoxesTyped, siteBoxesPicked), so what
  // a keystroke and a pick do is tested there and never depends on which render a callback closed over.
  const [boxes, setBoxes] = useState<SiteBoxes>(() => siteBoxesFrom(records));
  // THE SAVE THE PAGE HAS NOT DRAWN YET. A save lands before the page's own read does, and until then
  // `records` is the old address: the line said Saved beside it, and the sheet opened again in that
  // moment started from it. So the write is remembered here and read in the records' place until the
  // page's read arrives (lib/quote-site quoteSiteRecordsNow). State only: nothing is remounted.
  const [written, setWritten] = useState<SiteWritten | null>(null);
  // Once the page's read has moved on, the write is FORGOTTEN, not just passed over: a later read that
  // happened to land back on the old address (somebody else's change) must not bring it back to life.
  useEffect(() => {
    if (written && !siteWrittenStands(records.quote, written)) setWritten(null);
  }, [records.quote, written]);

  // Everything below reads these: the address shown, the row in use, how the boxes open.
  const now = quoteSiteRecordsNow(records, written);
  const view = quoteSiteView(now);
  // The picker's rows: only for an estimate with no job (a job owns its site, so nothing is offered).
  const sources = { lead: records.lead, customer: records.customer, otherJobs };
  const choices = job ? [] : quoteSiteChoices(sources);
  const inUse = siteChoiceInUse(choices, now.quote);
  // A SHORT LIST SAYS IT IS SHORT: the read's limit or the picker's cap left an address out.
  const listShort = !job && siteChoicesShort({ ...sources, readFull: otherJobsFull });
  // How the boxes open: the address the paper prints now, so a unit is added without retyping the street.
  const boxesStart = siteBoxesFrom(now);
  const typedChanged = siteBoxesDiffer(boxes, boxesStart);
  const typedReady = siteBoxesReady(boxes, boxesStart);
  const townLine = formatCityStateZip(boxes.city, boxes.state, boxes.zip);

  /**
   * ONE WRITE DOOR for every way the site changes: a row, the typed address, the job's. null clears
   * the estimate's own address. A refusal stays where the person is looking (the sheet stays open and
   * says the server's sentence); a save closes the sheet and the line says Saved.
   */
  function save(site: QuoteSiteInput | null) {
    setError(null);
    setSaved(false);
    // The estimate's own address as the page has it AT THE TAP: what the remembered write is held against.
    const atTheTap = records.quote;
    start(async () => {
      const res = await commitQuoteSite(quoteId, site, { setQuoteSite, fallbackError: t("qt_couldntSave") });
      if (!res.ok) {
        setError(res.error ?? t("qt_couldntSave"));
        return;
      }
      // The line and the sheet read this until the page's own read arrives.
      setWritten(siteWritten(atTheTap, site));
      setOpen(false);
      setSaved(true);
      router.refresh();
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2000);
    });
  }

  // THE SHEET OPENS CLEAN, from the estimate as it is now. The boxes are reset with state, before it
  // opens; the sheet itself is never remounted (the Modal's own law), and it carries no key.
  function openSheet() {
    setBoxes(boxesStart);
    setError(null);
    setSaved(false);
    setOpen(true);
  }

  // CANCEL CHANGES NOTHING, AND LEAVES NOTHING BEHIND: a refusal the person read in the sheet goes with
  // the sheet, or it would turn up on the line as if it were news. (An answer that comes back AFTER the
  // sheet is gone, because Back closed it while the write was out, is still said: on the line.)
  function closeSheet() {
    setOpen(false);
    setError(null);
  }

  function pick(choice: SiteChoice) {
    // The row already in use: nothing to write, so the tap is a way out of the sheet.
    if (choice.key === inUse) {
      closeSheet();
      return;
    }
    save(siteWriteFor(choice));
  }

  function saveTyped() {
    if (!typedReady) return;
    save(siteBoxesWrite(boxes));
  }

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">{t("qt_jobSite")}</p>
        {view.site && view.source ? (
          <div className="flex items-start gap-2">
            <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
            <div className="min-w-0">
              {/* The lines the paper prints, in its order: the street, the unit, the town. */}
              {siteLines(view.site).map((line, i) => (
                <p key={i} className="text-sm text-slate-900">
                  {line}
                </p>
              ))}
              <p className="mt-0.5 text-xs text-slate-500">{t(SOURCE_WORDS[view.source])}</p>
            </div>
          </div>
        ) : (
          <p className={AMBER}>{t("qt_siteNone")}</p>
        )}
        {/* ONE ACTION, NAMED BY WHERE THE ADDRESS CAN BE FIXED: this sheet, or the job when a job owns the site. */}
        {view.incomplete && <p className={AMBER}>{t(job ? "qt_siteNoTownJob" : "qt_siteNoTown")}</p>}
        {job && view.jobDiffers && <p className={AMBER}>{fillText(t("qt_siteJobDiffers"), { address: siteOneLine(records.job) })}</p>}
        {/* A refusal with no sheet to land in is said on the line: Use the Job's Address has no sheet,
            and an answer can come back after Back closed the sheet on a write that was still out. */}
        {error && !open && (
          <p role="alert" className="mt-1.5 text-sm text-red-600">
            {error}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {saved && (
          <span role="status" className="text-xs font-medium text-emerald-600">
            {t("qt_btn_saved")}
          </span>
        )}
        {/* Only for the door that has no sheet. Never beside Saved: the sheet closes a beat before the
            transition's own flag drops, and the two words would stand together for that beat. */}
        {pending && !open && !saved && (
          <span role="status" className="text-xs text-slate-400">
            {t("qt_btn_saving")}
          </span>
        )}
        {job ? (
          <>
            {view.jobDiffers && (
              <Button variant="outline" onClick={() => save(null)} disabled={pending}>
                {t("qt_btn_useJobAddress")}
              </Button>
            )}
            <Link href={`/jobs/${job.id}`} className={QUIET_DOOR}>
              {t("ag_btn_openTheJob")}
            </Link>
          </>
        ) : (
          <button type="button" onClick={openSheet} className={QUIET_DOOR}>
            <Pencil className="h-4 w-4 shrink-0" /> {t("qt_btn_changeJobSite")}
          </button>
        )}
      </div>

      {/* ONE SHEET. holdOpen while the write is out, so the answer has somewhere to land; dirty once
          something is typed, so a stray tap outside cannot eat a half-typed address. */}
      <Modal
        open={open && !job}
        onClose={closeSheet}
        title={t("qt_btn_changeJobSite")}
        dirty={typedChanged}
        holdOpen={pending}
        footer={<ModalActions onCancel={closeSheet} onSave={saveTyped} saveLabel={t("qt_btn_useThisAddress")} saving={pending} disabled={!typedReady} />}
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-500">{t("qt_siteSheetWhy")}</p>
          {error && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
          {pending && (
            <p role="status" className="text-xs text-slate-400">
              {t("qt_btn_saving")}
            </p>
          )}
          {/* NEVER "NONE" FOR A FAILED READ: the customer's earlier jobs may hold the very address he came for. */}
          {otherJobsFailed && <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{t("qt_siteJobsNotLoaded")}</p>}
          {choices.length > 0 && (
            <ul className="space-y-2">
              {choices.map((choice) => {
                const current = choice.key === inUse;
                return (
                  <li key={choice.key}>
                    <button
                      type="button"
                      onClick={() => pick(choice)}
                      disabled={pending}
                      aria-current={current ? "true" : undefined}
                      className={`flex min-h-11 w-full items-start justify-between gap-3 rounded-lg border px-3 py-2 text-left disabled:opacity-60 ${
                        current ? "border-brand bg-brand-light/40" : "border-slate-200 hover:bg-slate-50"
                      }`}
                    >
                      <span className="min-w-0">
                        {choice.follows ? (
                          // The record the estimate falls back to: the row is named for what it does.
                          <>
                            <span className="block text-sm font-medium text-slate-900">{choice.from === "lead" ? t("qt_btn_useLeadAddress") : t("qt_btn_useCustomerAddress")}</span>
                            <span className="block text-xs text-slate-500">{siteOneLine(choice.parts)}</span>
                          </>
                        ) : (
                          // A copy: the address, and whose it is.
                          <>
                            <span className="block text-sm font-medium text-slate-900">{siteOneLine(choice.parts)}</span>
                            <span className="block text-xs text-slate-500">
                              {choice.from === "job" ? fillText(t("qt_btn_siteFromJob"), { job: jobLabelWithNumber(choice.job ?? {}, lang, t) }) : t("qt_btn_customersAddress")}
                            </span>
                          </>
                        )}
                      </span>
                      {current && (
                        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-brand">
                          <Check className="h-4 w-4" /> {t("qt_btn_siteInUse")}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {/* A SHORT LIST SAYS IT IS SHORT, under its rows: the address he came for may be on an older
              job the read never reached, or past the picker's cap. The boxes below take any address. */}
          {choices.length > 0 && listShort && <p className="text-xs text-slate-500">{t("qt_siteListShort")}</p>}
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{t("qt_differentAddress")}</p>
            <div>
              <Label htmlFor="js-address">{t("qt_address")}</Label>
              <AddressAutocomplete
                id="js-address"
                // STREET ONLY, as New Job and Edit Job use the box: the street goes in the box and the
                // city, state and zip a pick resolves into their own columns, never one blob line.
                streetOnly
                defaultValue={boxes.street}
                placeholder={t("qt_jobAddress")}
                // Typing over the street DROPS the old city, state and zip; the box's own first
                // report (the unchanged value) and the echo after a pick change nothing.
                onTextChange={(v) => setBoxes((b) => siteBoxesTyped(b, v))}
                // A pick fills the street, city, state and zip together.
                onResolved={(p) => setBoxes((b) => siteBoxesPicked(b, p))}
              />
              {/* What was stored with the street, on one grey line. */}
              {townLine && <p className="mt-1 text-xs text-slate-500">{townLine}</p>}
            </div>
            <div>
              {/* THE DWELLING: a complex is one street and many doors, and the picker never fills it. */}
              <Label htmlFor="js-unit">
                {t("ag_rail_unitApt")} <span className="font-normal text-slate-400">{t("ag_rail_optional")}</span>
              </Label>
              <Input id="js-unit" value={boxes.unit} onChange={(e) => setBoxes((b) => ({ ...b, unit: e.target.value }))} placeholder={t("ag_rail_unitExample")} maxLength={24} />
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
