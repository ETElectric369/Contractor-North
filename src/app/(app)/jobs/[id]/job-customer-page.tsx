"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Camera, ChevronRight, Copy, ExternalLink, FileText, Loader2, Palette, Plus, RotateCcw, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/toast";
import { createClient } from "@/lib/supabase/client";
import { prepareImageForUpload } from "@/lib/image-prep";
import { PICK_CATEGORIES, fileKindFor, pickFilePath, type PickPatch } from "@/lib/portal/share-input";
import { pickHasContent } from "@/lib/portal/job-view-shape";
import { fmtRange } from "@/components/portal/portal-format";
import {
  addPick,
  addStretch,
  jobPortalLink,
  jobShareState,
  removePick,
  removeStretch,
  restorePick,
  restoreStretch,
  updatePick,
  updateStretch,
  type PapersState,
  type PickOptionChoice,
  type PickRow,
  type StretchRow,
} from "../portal-share-actions";
import { PapersCard } from "./job-portal-papers";
import { JobPortalPanel } from "./job-portal-panel";
import { portalOfficeLookUrl } from "../../portal-look-actions";
import { openOfficeLook } from "@/components/portal/open-office-look";

/**
 * WHAT THE CUSTOMER SEES ON THIS JOB, AND THE OFFICE'S HANDS ON IT (office only: the page renders
 * this tab for staff alone, and every action behind it is requireStaff).
 *
 * Erik: "Update everything right away yes always". There is no publish button and no Save: a field
 * saves when you leave it and is on the customer's page at once. Every change says so and offers
 * Undo (the not-annoying law: no save game, nothing silent). Removing a stretch or a pick is a soft
 * remove, so Undo, or Put Back from the list below, restores it exactly.
 *
 * Loads when the tab opens (the job page only renders the active tab), so the hub pays nothing
 * for it until someone looks.
 */
type Pick = PickRow & { file_url: string | null };
type LinkState = {
  url: string | null;
  enabled: boolean;
  hasLink: boolean;
  jobShown: boolean;
  customerId: string | null;
  customerName: string | null;
};

const byDates = (a: StretchRow, b: StretchRow) =>
  a.starts_on.localeCompare(b.starts_on) || a.sort - b.sort || a.ends_on.localeCompare(b.ends_on);

export function JobCustomerPage({ jobId, orgId, customerName }: { jobId: string; orgId: string; customerName: string | null }) {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stretches, setStretches] = useState<StretchRow[]>([]);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [sharedPhotos, setSharedPhotos] = useState(0);
  const [stalePhotos, setStalePhotos] = useState(0);
  const [papers, setPapers] = useState<PapersState | null>(null);
  const [brands, setBrands] = useState<string[]>([]);
  const [options, setOptions] = useState<PickOptionChoice[]>([]);
  const [priceBookNote, setPriceBookNote] = useState<string | null>(null);
  const [link, setLink] = useState<LinkState | null>(null);

  const load = useCallback(async () => {
    const [st, ln] = await Promise.all([jobShareState(jobId), jobPortalLink(jobId)]);
    if (!st.ok) {
      setLoadError(st.error);
    } else {
      setLoadError(null);
      setStretches(st.stretches);
      setPicks(st.picks);
      // A shown photo whose file changed is not on the customer's page (PL4): it is not counted as shown.
      setSharedPhotos(st.sharedPhotoIds.length - st.staleSharedPhotoIds.length);
      setStalePhotos(st.staleSharedPhotoIds.length);
      setPapers(st.papers);
      setBrands(st.brands);
      setOptions(st.options);
      setPriceBookNote(st.priceBookNote);
    }
    if (ln.ok)
      setLink({ url: ln.url, enabled: ln.enabled, hasLink: ln.hasLink, jobShown: ln.jobShown, customerId: ln.customerId, customerName: ln.customerName });
    setLoaded(true);
  }, [jobId]);

  useEffect(() => {
    load().catch(() => {
      setLoadError("This couldn't load. Check your connection and open the tab again.");
      setLoaded(true);
    });
  }, [load]);

  const who = link?.customerName || customerName || "The customer";

  if (!loaded) {
    return (
      <div className="flex items-center gap-2 px-1 py-8 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading what {who} sees…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <LinkCard link={link} who={who} jobId={jobId} />
      {loadError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{loadError}</div>
      ) : (
        <>
          <StretchesCard jobId={jobId} rows={stretches} setRows={setStretches} who={who} />
          <PicksCard jobId={jobId} orgId={orgId} rows={picks} setRows={setPicks} brands={brands} options={options} priceBookNote={priceBookNote} who={who} />
          {papers ? <PapersCard jobId={jobId} orgId={orgId} state={papers} setState={setPapers} who={who} /> : null}
          <JobPortalPanel jobId={jobId} who={who} />
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
              <Camera className="h-4 w-4 text-[rgb(var(--glass-ink))]" /> Photos
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              {sharedPhotos === 0
                ? `No photos are shown to ${who} yet.`
                : `${sharedPhotos} ${sharedPhotos === 1 ? "photo is" : "photos are"} shown to ${who}.`}{" "}
              {stalePhotos > 0
                ? `${stalePhotos} ${stalePhotos === 1 ? "photo was" : "photos were"} changed after being shown, so ${who} doesn't see ${
                    stalePhotos === 1 ? "it" : "them"
                  } now: Show Again is on the photo. `
                : null}
              Choose them on the Photos tab with Show Customer under each photo. Receipts are never shown.
            </p>
            <Link href={`/jobs/${jobId}?tab=photos`} className="mt-2 inline-flex min-h-[44px] items-center gap-1 text-sm font-semibold text-brand">
              Go To Photos <ChevronRight className="h-4 w-4" />
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

// ── the link ─────────────────────────────────────────────────────────────────────────────────

function LinkCard({ link, who, jobId }: { link: LinkState | null; who: string; jobId: string }) {
  const toast = useToast();
  const [looking, startLook] = useTransition();
  if (!link) return null;
  if (!link.customerId) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600 shadow-sm">
        This job has no customer yet, so there is no page to show anyone. Add a customer to the job first.
      </div>
    );
  }
  const url = link.url;
  return (
    <div className="glass glass-gloss rounded-xl p-4">
      <div className="relative z-10">
        <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{who}&apos;s own page for this job</div>
        <p className="mt-1 text-sm text-slate-700">
          The work by stretch with each day&apos;s hours and dollars as billed, the payments, the bill, the picks, and the plans,
          drawings and photos you share. Every change here shows on their page right away. Picks never show a price.
        </p>
        {/* Said in the card, not in a tooltip: a phone never shows a title. */}
        {!link.hasLink ? (
          <p className="mt-2 text-sm text-red-700">
            {who} has no link yet, so there is nothing to open or copy.{" "}
            <Link href={`/crm/${link.customerId}`} className="font-semibold underline">
              Make one on their contact page
            </Link>
            .
          </p>
        ) : !link.enabled ? (
          <p className="mt-2 text-sm text-red-700">
            Their link is turned off, so it opens to &ldquo;This link was turned off.&rdquo;{" "}
            <Link href={`/crm/${link.customerId}`} className="font-semibold underline">
              Turn it on from their contact page
            </Link>
            .
          </p>
        ) : null}
        {link.hasLink && !link.jobShown ? (
          <p className="mt-2 text-sm text-amber-800">
            This job isn&apos;t on {who}&apos;s page yet: a job shows there once it is past the estimate (to be scheduled,
            scheduled, in progress, on hold, complete or invoiced). Until then its page doesn&apos;t open for them or for you.
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!url || !link.jobShown || looking}
            onClick={() => {
              const customerId = link.customerId;
              if (!url || !customerId) return;
              // A one-use office ticket (0331): the office never needs the customer's code.
              startLook(async () => {
                const problem = await openOfficeLook(() => portalOfficeLookUrl(customerId, jobId));
                if (problem) toast(problem, "error");
              });
            }}
            title="Open it exactly as the customer sees it, without their code. Your own looks don't count as them opening it."
          >
            <ExternalLink className="h-4 w-4" /> See What They See
          </Button>
          <Button
            variant="outline"
            disabled={!url || !link.enabled || !link.jobShown}
            onClick={() => {
              if (!url) return;
              navigator.clipboard?.writeText(url).then(
                () => toast("Copied. It opens straight to this job.", "success"),
                () => toast(url, "info"),
              );
            }}
            title={link.enabled ? "Copy the link to this job's page" : "Turn the link on first"}
          >
            <Copy className="h-4 w-4" /> Copy The Link
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── stretches ────────────────────────────────────────────────────────────────────────────────

function StretchesCard({
  jobId,
  rows,
  setRows,
  who,
}: {
  jobId: string;
  rows: StretchRow[];
  setRows: React.Dispatch<React.SetStateAction<StretchRow[]>>;
  who: string;
}) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [label, setLabel] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const live = useMemo(() => rows.filter((r) => !r.removed_at).sort(byDates), [rows]);
  const removed = useMemo(() => rows.filter((r) => r.removed_at), [rows]);
  const put = useCallback((row: StretchRow) => setRows((rs) => rs.map((r) => (r.id === row.id ? row : r))), [setRows]);

  function add() {
    start(async () => {
      const res = await addStretch(jobId, { label, startsOn, endsOn: endsOn || undefined });
      if (!res.ok) {
        toast(res.error, "error");
        return;
      }
      setRows((rs) => [...rs, res.row]);
      setLabel("");
      setStartsOn("");
      setEndsOn("");
      toast(`${res.row.label} is on ${who}'s page.`, "success", {
        label: "Undo",
        onClick: () => void removeStretch(res.row.id).then((u) => (u.ok ? put(u.row) : toast(u.error, "error"))),
      });
    });
  }

  function restore(id: string) {
    start(async () => {
      const res = await restoreStretch(id);
      if (!res.ok) toast(res.error, "error");
      else {
        put(res.row);
        toast(`${res.row.label} is back on their page.`, "success");
      }
    });
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="text-base font-semibold text-slate-900">Stretches Of Work</h3>
      <p className="mt-1 text-sm text-slate-600">
        Name each stretch and its dates, like Rough-in, Jul 14 to Aug 10. {who} sees each stretch with its days, the payments made
        in it or at its end, and the balance after it. With none named, it is one list called All Work.
      </p>

      {live.length ? (
        <ul className="mt-3 space-y-2">
          {live.map((r) => (
            <li key={r.id}>
              <StretchEditor row={r} onSaved={put} who={who} />
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 rounded-lg border border-dashed border-slate-300 p-3">
        <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
          <label className="text-xs font-medium text-slate-600">
            Name
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Rough-in" maxLength={80} className="mt-1 h-11" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Starts
            <Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} className="mt-1 h-11" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Ends
            <Input type="date" value={endsOn} min={startsOn || undefined} onChange={(e) => setEndsOn(e.target.value)} className="mt-1 h-11" />
          </label>
        </div>
        <Button className="mt-2" onClick={add} disabled={pending || !label.trim() || !startsOn}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add Stretch
        </Button>
        <p className="mt-1 text-xs text-slate-500">Leave Ends empty for a one-day stretch.</p>
      </div>

      {removed.length ? (
        <details className="mt-3">
          <summary className="flex min-h-[44px] cursor-pointer items-center text-sm font-medium text-slate-600">
            Taken Off Their Page ({removed.length})
          </summary>
          <ul className="mt-1 divide-y divide-slate-100 rounded-lg border border-slate-200">
            {removed.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                <span className="min-w-0 truncate text-slate-600">
                  {r.label} · {fmtRange(r.starts_on, r.ends_on)}
                </span>
                <Button variant="ghost" onClick={() => restore(r.id)} disabled={pending}>
                  <RotateCcw className="h-4 w-4" /> Put Back
                </Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function StretchEditor({ row, onSaved, who }: { row: StretchRow; onSaved: (r: StretchRow) => void; who: string }) {
  const toast = useToast();
  const [label, setLabel] = useState(row.label);
  const [startsOn, setStartsOn] = useState(row.starts_on);
  const [endsOn, setEndsOn] = useState(row.ends_on);
  const [busy, setBusy] = useState(false);

  // A save elsewhere (Undo, Put Back) brings a new row: show it.
  useEffect(() => {
    setLabel(row.label);
    setStartsOn(row.starts_on);
    setEndsOn(row.ends_on);
  }, [row.label, row.starts_on, row.ends_on]);

  async function save(patch: { label?: string; startsOn?: string; endsOn?: string }, undo: { label?: string; startsOn?: string; endsOn?: string }) {
    setBusy(true);
    const res = await updateStretch(row.id, patch);
    setBusy(false);
    if (!res.ok) {
      toast(res.error, "error");
      setLabel(row.label);
      setStartsOn(row.starts_on);
      setEndsOn(row.ends_on);
      return;
    }
    onSaved(res.row);
    toast(`Saved. ${who} sees it now.`, "success", {
      label: "Undo",
      onClick: () => void updateStretch(row.id, undo).then((u) => (u.ok ? onSaved(u.row) : toast(u.error, "error"))),
    });
  }

  function remove() {
    setBusy(true);
    removeStretch(row.id).then((res) => {
      setBusy(false);
      if (!res.ok) {
        toast(res.error, "error");
        return;
      }
      onSaved(res.row);
      toast(`${row.label} is off their page.`, "success", {
        label: "Undo",
        onClick: () => void restoreStretch(row.id).then((u) => (u.ok ? onSaved(u.row) : toast(u.error, "error"))),
      });
    });
  }

  return (
    <div className="grid items-end gap-2 rounded-lg bg-slate-50 p-2 sm:grid-cols-[1fr_auto_auto_auto]">
      <label className="text-xs font-medium text-slate-600">
        Name
        <Input
          value={label}
          maxLength={80}
          className="mt-1 h-11"
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          onBlur={() => {
            const v = label.trim();
            if (!v) {
              setLabel(row.label);
              return;
            }
            if (v !== row.label) void save({ label: v }, { label: row.label });
          }}
        />
      </label>
      <label className="text-xs font-medium text-slate-600">
        Starts
        <Input
          type="date"
          value={startsOn}
          className="mt-1 h-11"
          onChange={(e) => setStartsOn(e.target.value)}
          onBlur={() => {
            if (startsOn && startsOn !== row.starts_on) void save({ startsOn }, { startsOn: row.starts_on });
            else if (!startsOn) setStartsOn(row.starts_on);
          }}
        />
      </label>
      <label className="text-xs font-medium text-slate-600">
        Ends
        <Input
          type="date"
          value={endsOn}
          min={startsOn || undefined}
          className="mt-1 h-11"
          onChange={(e) => setEndsOn(e.target.value)}
          onBlur={() => {
            if (endsOn && endsOn !== row.ends_on) void save({ endsOn }, { endsOn: row.ends_on });
            else if (!endsOn) setEndsOn(row.ends_on);
          }}
        />
      </label>
      <Button variant="ghost" size="icon" onClick={remove} disabled={busy} aria-label={`Take ${row.label} off their page`} title="Take it off their page">
        {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
      </Button>
    </div>
  );
}

// ── picks ────────────────────────────────────────────────────────────────────────────────────

function PicksCard({
  jobId,
  orgId,
  rows,
  setRows,
  brands,
  options,
  priceBookNote,
  who,
}: {
  jobId: string;
  orgId: string;
  rows: Pick[];
  setRows: React.Dispatch<React.SetStateAction<Pick[]>>;
  brands: string[];
  options: PickOptionChoice[];
  priceBookNote: string | null;
  who: string;
}) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [category, setCategory] = useState<string>(PICK_CATEGORIES[0]);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const live = rows.filter((r) => !r.removed_at);
  const removed = rows.filter((r) => r.removed_at);
  const put = useCallback(
    (row: PickRow, fileUrl?: string | null) =>
      setRows((rs) => rs.map((r) => (r.id === row.id ? { ...row, file_url: fileUrl !== undefined ? fileUrl : row.file_path === r.file_path ? r.file_url : null } : r))),
    [setRows],
  );

  function add() {
    start(async () => {
      const res = await addPick(jobId, { category });
      if (!res.ok) {
        toast(res.error, "error");
        return;
      }
      setRows((rs) => [...rs, { ...res.row, file_url: null }]);
      setJustAdded(res.row.id);
      toast(`A ${res.row.category} pick is started. It shows on ${who}'s page once it has a name, brand, code, swatch, file or link.`, "success", {
        label: "Undo",
        onClick: () => void removePick(res.row.id).then((u) => (u.ok ? put(u.row) : toast(u.error, "error"))),
      });
    });
  }

  function restore(id: string) {
    start(async () => {
      const res = await restorePick(id);
      if (!res.ok) toast(res.error, "error");
      else {
        put(res.row);
        toast("It's back on their page.", "success");
      }
    });
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
        <Palette className="h-4 w-4 text-[rgb(var(--glass-ink))]" /> Picks
      </h3>
      <p className="mt-1 text-sm text-slate-600">
        The colors, faceplates and fixtures chosen for this job, with a swatch, a picture, a PDF or a link. {who} sees them read
        only. A price is never shown.
      </p>
      {priceBookNote ? (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{priceBookNote}</p>
      ) : null}

      <datalist id={`pick-cats-${jobId}`}>
        {PICK_CATEGORIES.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <datalist id={`pick-brands-${jobId}`}>
        {brands.map((b) => (
          <option key={b} value={b} />
        ))}
      </datalist>

      {live.length ? (
        <ul className="mt-3 space-y-2">
          {live.map((p) => (
            <li key={p.id}>
              <PickEditor
                row={p}
                jobId={jobId}
                orgId={orgId}
                options={options}
                onSaved={put}
                who={who}
                startOpen={p.id === justAdded}
              />
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-slate-300 p-3">
        <label className="min-w-[12rem] flex-1 text-xs font-medium text-slate-600">
          Kind of pick
          <Input list={`pick-cats-${jobId}`} value={category} onChange={(e) => setCategory(e.target.value)} maxLength={60} className="mt-1 h-11" />
        </label>
        <Button onClick={add} disabled={pending || !category.trim()}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add Pick
        </Button>
      </div>

      {removed.length ? (
        <details className="mt-3">
          <summary className="flex min-h-[44px] cursor-pointer items-center text-sm font-medium text-slate-600">
            Taken Off Their Page ({removed.length})
          </summary>
          <ul className="mt-1 divide-y divide-slate-100 rounded-lg border border-slate-200">
            {removed.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                <span className="min-w-0 truncate text-slate-600">
                  {r.category}
                  {r.name ? ` · ${r.name}` : ""}
                </span>
                <Button variant="ghost" onClick={() => restore(r.id)} disabled={pending}>
                  <RotateCcw className="h-4 w-4" /> Put Back
                </Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

type TextKey = "category" | "brand" | "name" | "code" | "location" | "note" | "linkUrl" | "colorHex";
const COLUMN: Record<TextKey, keyof PickRow> = {
  category: "category",
  brand: "brand",
  name: "name",
  code: "code",
  location: "location",
  note: "note",
  linkUrl: "link_url",
  colorHex: "color_hex",
};
const LABEL: Record<TextKey, string> = {
  category: "Kind",
  brand: "Brand",
  name: "Name",
  code: "Code",
  location: "Room or place",
  note: "Note",
  linkUrl: "Link",
  colorHex: "Swatch",
};

function PickEditor({
  row,
  jobId,
  orgId,
  options,
  onSaved,
  who,
  startOpen,
}: {
  row: Pick;
  jobId: string;
  orgId: string;
  options: PickOptionChoice[];
  onSaved: (r: PickRow, fileUrl?: string | null) => void;
  who: string;
  startOpen: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Record<TextKey, string>>(() => fromRow(row));
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(fromRow(row));
  }, [row]);

  /** `undo` null: nothing to go back to (a removed file is deleted, so no Undo is offered). */
  async function save(patch: PickPatch, undo: PickPatch | null, what: string) {
    setBusy(true);
    const res = await updatePick(row.id, patch);
    setBusy(false);
    if (!res.ok) {
      toast(res.error, "error");
      setDraft(fromRow(row));
      return;
    }
    onSaved(res.row);
    // Nothing silent: a pick with nothing to show yet is not on their page (pickHasContent).
    const seen = pickHasContent(res.row) ? `${who} sees it now.` : `It shows on ${who}'s page once it has a name, brand, code, swatch, file or link.`;
    if (!undo) {
      toast(`${what}. ${seen}`, "success");
      return;
    }
    toast(`${what} saved. ${seen}`, "success", {
      label: "Undo",
      onClick: () => void updatePick(row.id, undo).then((u) => (u.ok ? onSaved(u.row) : toast(u.error, "error"))),
    });
  }

  function commit(key: TextKey) {
    const next = draft[key].trim();
    const prev = String(row[COLUMN[key]] ?? "");
    if (next === prev) return;
    if (key === "category" && !next) {
      setDraft(fromRow(row));
      return;
    }
    void save({ [key]: next || null } as PickPatch, { [key]: prev || null } as PickPatch, LABEL[key]);
  }

  function field(key: Exclude<TextKey, "note" | "colorHex">, props: React.InputHTMLAttributes<HTMLInputElement> = {}) {
    return (
      <label className="text-xs font-medium text-slate-600">
        {LABEL[key]}
        <Input
          {...props}
          value={draft[key]}
          className="mt-1 h-11"
          onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          onBlur={() => commit(key)}
        />
      </label>
    );
  }

  async function upload(file: File) {
    const kind = fileKindFor(file.name, file.type);
    if (!kind) {
      toast("A pick can hold a picture or a PDF.", "error");
      return;
    }
    setBusy(true);
    try {
      const ready = kind === "image" ? await prepareImageForUpload(file) : file;
      const path = pickFilePath(orgId, jobId, ready.name);
      const { error } = await createClient().storage.from("documents").upload(path, ready, { upsert: false });
      if (error) throw error;
      const res = await updatePick(row.id, { filePath: path, fileKind: kind });
      if (!res.ok) {
        // The row never named it; take the upload back out so nothing is left behind.
        await createClient().storage.from("documents").remove([path]).catch(() => undefined);
        toast(res.error, "error");
        return;
      }
      onSaved(res.row, URL.createObjectURL(ready));
      toast(kind === "pdf" ? `PDF saved. ${who} can open it now.` : `Picture saved. ${who} sees it now.`, "success");
    } catch (e) {
      toast((e as { message?: string })?.message || "The file didn't upload. Try again.", "error");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function removeFile() {
    if (!confirm(row.file_kind === "pdf" ? "Remove the PDF from this pick?" : "Remove the picture from this pick?")) return;
    void save({ filePath: null }, null, row.file_kind === "pdf" ? "PDF removed" : "Picture removed");
  }

  function remove() {
    setBusy(true);
    removePick(row.id).then((res) => {
      setBusy(false);
      if (!res.ok) {
        toast(res.error, "error");
        return;
      }
      onSaved(res.row);
      toast(`That ${row.category} pick is off their page.`, "success", {
        label: "Undo",
        onClick: () => void restorePick(row.id).then((u) => (u.ok ? onSaved(u.row) : toast(u.error, "error"))),
      });
    });
  }

  const title = row.name || row.code || row.brand || "Not filled in yet";
  const hex = draft.colorHex && /^#?[0-9a-f]{6}$/i.test(draft.colorHex) ? (draft.colorHex.startsWith("#") ? draft.colorHex : `#${draft.colorHex}`) : null;
  // The price book narrowed to the brand typed above (the chosen one always stays listed).
  const brandOptions = options.filter(
    (o) => o.id === row.option_id || !draft.brand.trim() || o.brand.toLowerCase() === draft.brand.trim().toLowerCase(),
  );

  return (
    <details className="group rounded-lg border border-slate-200 bg-slate-50" open={startOpen}>
      <summary className="flex min-h-[52px] cursor-pointer list-none items-center gap-3 rounded-lg px-3 py-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 shrink-0 text-slate-400 motion-safe:transition-transform group-open:rotate-90" />
        {row.file_kind === "image" && row.file_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={row.file_url} alt="" className="h-9 w-9 shrink-0 rounded-md border border-slate-200 object-cover" />
        ) : row.color_hex ? (
          <span className="h-9 w-9 shrink-0 rounded-md border border-slate-200" style={{ backgroundColor: row.color_hex }} />
        ) : row.file_kind === "pdf" ? (
          <FileText className="h-9 w-9 shrink-0 rounded-md bg-white p-1.5 text-slate-500" />
        ) : (
          <span className="h-9 w-9 shrink-0 rounded-md border border-dashed border-slate-300" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">{row.category}</span>
          <span className="block truncate text-sm font-medium text-slate-900">
            {title}
            {row.location ? <span className="font-normal text-slate-500"> · {row.location}</span> : null}
          </span>
          {!pickHasContent(row) ? <span className="block text-xs text-amber-800">Not on {who}&apos;s page until it has a name, brand, code, swatch, file or link.</span> : null}
        </span>
        {busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-slate-400" /> : null}
      </summary>

      <div className="space-y-2 border-t border-slate-200 p-3">
        <div className="grid gap-2 sm:grid-cols-2">
          {field("category", { list: `pick-cats-${jobId}`, maxLength: 60 })}
          {field("brand", { list: `pick-brands-${jobId}`, maxLength: 120, placeholder: "Sherwin-Williams, Leviton…" })}
          {field("name", { maxLength: 160, placeholder: "Swiss Coffee" })}
          {field("code", { maxLength: 80, placeholder: "OC-45" })}
          {field("location", { maxLength: 120, placeholder: "Kitchen, over the island" })}
          {field("linkUrl", { type: "url", inputMode: "url", maxLength: 2000, placeholder: "https://" })}
        </div>

        {options.length ? (
          <label className="block text-xs font-medium text-slate-600">
            Fill from your price book (brand and product only, never a price)
            <select
              className="mt-1 h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
              value={row.option_id ?? ""}
              onChange={(e) => {
                const id = e.target.value || null;
                void save({ optionId: id }, { optionId: row.option_id }, "Price book choice");
              }}
            >
              <option value="">None</option>
              {brandOptions.slice(0, 300).map((o) => (
                <option key={o.id} value={o.id}>
                  {[o.brand, o.itemName, o.label, o.partNumber].filter(Boolean).join(" · ")}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs font-medium text-slate-600">
            Swatch
            <span className="mt-1 flex items-center gap-2">
              <input
                type="color"
                aria-label="Pick a swatch color"
                value={hex ?? "#ffffff"}
                className="h-11 w-14 cursor-pointer rounded-lg border border-slate-300 bg-white p-1"
                onChange={(e) => setDraft((d) => ({ ...d, colorHex: e.target.value.toUpperCase() }))}
                onBlur={() => commit("colorHex")}
              />
              <Input
                value={draft.colorHex}
                placeholder="#F2EFE6"
                maxLength={7}
                className="h-11 w-28"
                onChange={(e) => setDraft((d) => ({ ...d, colorHex: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                onBlur={() => commit("colorHex")}
              />
              {row.color_hex ? (
                <Button variant="ghost" size="icon" aria-label="No swatch" title="No swatch" onClick={() => void save({ colorHex: null }, { colorHex: row.color_hex }, "Swatch")}>
                  <X />
                </Button>
              ) : null}
            </span>
          </label>

          <div className="text-xs font-medium text-slate-600">
            Picture or PDF
            <span className="mt-1 flex items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/*,application/pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(f);
                }}
              />
              <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
                <Upload className="h-4 w-4" /> {row.file_path ? "Replace" : "Add File"}
              </Button>
              {row.file_path ? (
                <>
                  {row.file_url ? (
                    <a href={row.file_url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center text-sm font-medium text-brand underline">
                      Open
                    </a>
                  ) : null}
                  <Button variant="ghost" onClick={removeFile} disabled={busy}>
                    Remove File
                  </Button>
                </>
              ) : null}
            </span>
          </div>
        </div>

        <label className="block text-xs font-medium text-slate-600">
          Note
          <Textarea
            value={draft.note}
            maxLength={2000}
            rows={2}
            className="mt-1"
            placeholder="Eggshell on the walls, satin on the trim."
            onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
            onBlur={() => commit("note")}
          />
        </label>

        <div className="flex justify-end">
          <Button variant="ghost" onClick={remove} disabled={busy} className="text-red-700 hover:text-red-800">
            <Trash2 className="h-4 w-4" /> Take Off Their Page
          </Button>
        </div>
      </div>
    </details>
  );
}

function fromRow(r: PickRow): Record<TextKey, string> {
  return {
    category: r.category ?? "",
    brand: r.brand ?? "",
    name: r.name ?? "",
    code: r.code ?? "",
    location: r.location ?? "",
    note: r.note ?? "",
    linkUrl: r.link_url ?? "",
    colorHex: r.color_hex ?? "",
  };
}
