"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useOrgPublicBase } from "@/components/use-org-public-base";
import { useRouter } from "next/navigation";
import { Check, Copy, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label } from "@/components/ui/input";
import { DayField } from "@/components/day-field";
import { createInspectionNow } from "../appointments/actions";
import { convertInquiry, suggestVisitSlots } from "./actions";
import { useLang } from "@/components/lang-provider";
import { translator, fillText } from "@/lib/i18n";

/** A sentence with one person's name (or a number) set in it as a node: ONE key, its {slot} split. */
function around(words: string, slot: string, node: ReactNode) {
  const [before, after = ""] = words.split(`{${slot}}`);
  return (
    <>
      {before}
      {node}
      {after}
    </>
  );
}

/** A sensible default inspection day: 2 days out. */
function defaultInspectDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  return d.toISOString().slice(0, 10);
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** Next three weekdays at 9 AM — default options for "Let them pick" (9 AM is
 *  the inspection convention; the office fine-tunes per slot). */
function defaultSlots(): { date: string; time: string }[] {
  const out: { date: string; time: string }[] = [];
  const d = new Date();
  while (out.length < 3) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6)
      out.push({ date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, time: "09:00" });
  }
  return out;
}

/**
 * THE LEAD'S SCHEDULE SHEET (cn-v1170): one sheet, three ways, always an INSPECTION (Erik's yes,
 * 2026-11-19: Schedule on a lead always books an inspection; the straight-to-job fork went):
 *   • Book It: a firm day, 9 AM, through convertInquiry's booking.
 *   • Let Them Pick: up to 3 times -> a /pick link to text them (the appointment modal's pattern).
 *   • Start Now: the one-tap inspect-now door (createInspectionNow), straight into the visit.
 * LeadDoors (lead-doors.tsx) owns whether it is open. Once its visit stands the lead leaves the list.
 */
export function LeadScheduleSheet({
  inquiryId,
  inquiryName,
  businessPhone = null,
  open,
  onClose,
}: {
  inquiryId: string;
  inquiryName: string;
  open: boolean;
  onClose: () => void;
  /**
   * THE BUSINESS LINE (organizations.phone), so this modal can say which number the text will NOT
   * go out from. Erik: "the text prompt defaults to my personal number and it needs to default to
   * Google voice Tahoe deck number."
   *
   * It can't. `sms:` hands the message to whatever app the phone answers that scheme with, and the
   * SENDER is that app's — an href has no way to choose it, on iOS or Android. What was actually
   * broken is that nothing said so: the button looked like it was texting AS the business, and he
   * only found out it hadn't after the customer replied to his cell. Naming the business number
   * next to Copy Link is the honest version, and Copy Link is the working route to it.
   */
  businessPhone?: string | null;
}) {
  const lang = useLang();
  const t = translator(lang);
  const router = useRouter();
  const [inspectDate, setInspectDate] = useState(defaultInspectDate());
  const [mode, setMode] = useState<"book" | "pick" | "now">("book");
  const [slots, setSlots] = useState(defaultSlots);
  const [timeNote, setTimeNote] = useState("");
  // The first useState(null) here is `link` (leads-spanish.test seeds the link-ready screen through it).
  const [link, setLink] = useState<{ token: string; phone: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<null | "book" | "pick" | "now">(null);
  const [error, setError] = useState<string | null>(null);
  /* RIDE-ALONG SLOTS. The modal opens INSTANTLY on the blind defaults (60mph law), then the
     calendar's own suggestion lands async: days already holding inspections, at times that fit
     around them, the lead's town first. touchedRef is the not-annoying guard — the moment he
     edits a date by hand, a late-arriving suggestion must NOT yank the form out from under him. */
  const [slotNote, setSlotNote] = useState<string | null>(null);
  const touchedRef = useRef(false);

  async function run() {
    const way = mode;
    setBusy(way);
    setError(null);
    if (way === "now") {
      // START NOW: the lead row's old one-tap Inspection door, the same server door, into the visit.
      const res = await createInspectionNow({ inquiryId });
      if (!res.ok || !res.id) {
        setError(res.error ?? t("ld_couldntStartInspection"));
        setBusy(null);
        return;
      }
      router.push(`/appointments/${res.id}`);
      return;
    }
    const res = await convertInquiry(
      inquiryId,
      "inspection",
      way === "pick"
        ? { slots: slots.filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.date)), timeNote: timeNote.trim() || null }
        : { startDate: inspectDate },
    );
    if (res.ok && res.token) {
      // "Let them pick": the link-ready screen. NO refresh yet: the proposed visit takes the lead off
      // the list, which would unmount this sheet before the link is copied. Closing it refreshes.
      setLink({ token: res.token, phone: res.phone ?? null });
      setBusy(null);
      return;
    }
    if (res.ok && res.redirect) {
      router.push(res.redirect);
      return;
    }
    setError(res.error ?? t("ld_somethingWrong"));
    setBusy(null);
  }

  // Every opening starts clean, then the calendar's own suggestion rides in (below).
  useEffect(() => {
    if (!open) return;
    setInspectDate(defaultInspectDate());
    setSlots(defaultSlots());
    setTimeNote("");
    setLink(null);
    setError(null);
    setMode("book");
    setSlotNote(null);
    touchedRef.current = false;
    let live = true;
    suggestVisitSlots(inquiryId)
      .then((r) => {
        if (!live || !r.ok || !r.slots.length || touchedRef.current) return;
        // Clustered days first, blind defaults padding out to three options.
        const pad = defaultSlots().filter((d) => !r.slots.some((x) => x.date === d.date));
        setSlots([...r.slots, ...pad].slice(0, 3));
        setInspectDate(r.slots[0].date);
        setSlotNote(r.note ?? null);
      })
      .catch(() => { /* suggestion only — the defaults already stand */ });
    return () => {
      live = false;
    };
  }, [open, inquiryId]);

  // cn-v1170: Let Them Pick's action revalidates nothing (it would unmount this sheet with the
  // link on it), so every close refreshes the route here: Done, Cancel, the X, a tap outside and
  // the phone's back all come through this one function.
  function closeInspect() {
    if (busy !== null) return;
    setLink(null);
    onClose();
    router.refresh();
  }

  // The BUSINESS's domain, not the browser's — see useOrgPublicBase.
  const origin = useOrgPublicBase();
  const pickLink = link && origin ? `${origin}/pick/${link.token}` : null;
  // THE CUSTOMER'S TEXT STAYS ENGLISH (the Spanish waves' law: what a tenant's customer reads is the
  // tenant's English, whatever language the office seat reads the app in). leads-spanish.test pins it.
  const smsBody = `Hi! Pick a time for your site visit and we'll lock it in: ${pickLink}`;

  async function copyLink() {
    if (!pickLink) return;
    try {
      await navigator.clipboard.writeText(pickLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard denied — link is visible to select */
    }
  }

  return (
    <Modal
      open={open}
      onClose={closeInspect}
      title={link ? t("ld_btn_textThemTheseTimes") : mode === "now" ? t("ld_startNowTitle") : t("ld_btn_bookAnInspection")}
      size="sm"
      footer={
        link ? (
          <ModalActions onCancel={closeInspect} onSave={closeInspect} saveLabel={t("ld_btn_done")} hideCancel />
        ) : (
          <ModalActions
            onCancel={closeInspect}
            onSave={() => void run()}
            saving={busy !== null}
            saveLabel={mode === "pick" ? t("ld_btn_createLink") : mode === "now" ? t("ld_btn_startNow") : t("ld_btn_bookIt")}
          />
        )
      }
    >
        {link ? (
          <div className="space-y-3">
            <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
              {around(t("ld_linkReady"), "name", <strong>{inquiryName}</strong>)}
            </div>
            <code className="block break-all rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">{pickLink}</code>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={copyLink}>
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? t("ld_btn_copied") : t("ld_btn_copyLink")}
              </Button>
              <a
                // iOS convention (matches propose-dates-button): with a number the body
                // separator is `&` — `sms:<number>?body=` opens Messages without the text.
                href={`sms:${link.phone ?? ""}${link.phone ? "&" : "?"}body=${encodeURIComponent(smsBody)}`}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand px-4 text-sm font-medium text-white hover:bg-brand-dark"
              >
                <MessageSquare className="h-4 w-4 shrink-0" /> {t("ld_btn_textIt")}
              </a>
            </div>
            {/* Say which number it goes out from BEFORE he sends it — see the businessPhone prop. */}
            <p className="text-xs text-slate-500">
              {businessPhone ? (
                around(t("ld_textItNotBusiness"), "phone", <span className="font-medium">{businessPhone}</span>)
              ) : (
                t("ld_textItNoBusiness")
              )}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              {around(t(mode === "now" ? "ld_startNowSays" : "ld_booksInspectionFor"), "name", <strong>{inquiryName}</strong>)}
            </p>

            <SegmentedControl
              stretch
              activeId={mode}
              onSelect={(id) => {
                setError(null);
                setMode(id as typeof mode);
              }}
              items={[
                { id: "book", label: t("ld_btn_bookIt") },
                { id: "pick", label: t("ld_btn_letThemPick") },
                { id: "now", label: t("ld_btn_startNow") },
              ]}
            />

            {mode === "now" ? null : mode === "book" ? (
              <div>
                <Label htmlFor="inspect-date">{t("ld_day")}</Label>
                <DayField id="inspect-date" value={inspectDate} onChange={(iso) => { touchedRef.current = true; setSlotNote(null); setInspectDate(iso); }} />
                {slotNote && <p className="mt-1 text-xs text-brand">{slotNote}</p>}
                <p className="mt-1 text-xs text-slate-400">{t("ld_defaultsToNine")}</p>
              </div>
            ) : (
              <div className="space-y-2 rounded-lg border border-brand/30 bg-brand-light/20 p-3">
                <Label>{t("ld_offerUpToThree")}</Label>
                {slotNote && <p className="text-xs text-brand">{slotNote}</p>}
                {slots.map((sl, i) => (
                  <div key={i} className="grid grid-cols-2 gap-2">
                    <DayField
                      value={sl.date}
                      onChange={(iso) => { touchedRef.current = true; setSlots((a) => a.map((x, xi) => (xi === i ? { ...x, date: iso } : x))); }}
                      aria-label={fillText(t("ld_optionDate"), { n: String(i + 1) })}
                    />
                    <Input
                      className="h-11"
                      type="time"
                      value={sl.time}
                      onChange={(ev) => { touchedRef.current = true; setSlots((a) => a.map((x, xi) => (xi === i ? { ...x, time: ev.target.value } : x))); }}
                      aria-label={fillText(t("ld_optionTime"), { n: String(i + 1) })}
                    />
                  </div>
                ))}
                <div>
                  <Label htmlFor="inspect-window">{t("ld_arrivalWindow")}</Label>
                  <Input
                    id="inspect-window"
                    value={timeNote}
                    onChange={(e) => setTimeNote(e.target.value)}
                    placeholder={t("ld_arrivalExample")}
                  />
                </div>
              </div>
            )}
            {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          </div>
        )}
    </Modal>
  );
}
