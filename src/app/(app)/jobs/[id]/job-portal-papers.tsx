"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { Box, DraftingCompass, ExternalLink, FileText, History, Loader2, Pencil, RotateCcw, EyeOff, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { formatDate } from "@/lib/utils";
import { PORTAL_DOC_KINDS, defaultKindFor, kindLabel, titleFromName } from "@/lib/portal/doc-kinds";
import { paperHistory, replaceChoices, showsAgainIfTakenOff } from "@/lib/portal/paper-history";
import { showPaper, takePaperOff, updateShownPaper, type JobPaper, type PapersState, type SharedPaperRow } from "../portal-share-actions";

/**
 * PLANS AND DRAWINGS ON THE CUSTOMER'S PAGE (0326), the office's hands on them. Office only: the
 * Customer Page tab renders for staff alone, and every action is requireStaff (and 0326's RLS).
 *
 * Erik: "ill have a new circuit map to update the one made from the plan scans that should post on
 * the portal too". So any job paper (a plan, a permit, a circuit map, a drawing, a rendering, a
 * scan, a photo) can be put on the page with Show On Portal, and a newer file can be marked as
 * replacing an older one: the customer then sees only the newest, and the older one stays here
 * under Earlier Versions with who showed it, who replaced it, and when. Live, as the rest of the
 * page: no publish step; every change says so and offers Undo. Receipts, bills and supplier
 * invoices never appear on this list (and the server and the database refuse them anyway).
 *
 * The Costs tab's document list links here with ?paper=<id>, which opens that paper's sheet.
 */
export function PapersCard({ state, setState, who }: { state: PapersState; setState: (s: PapersState) => void; who: string }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [sheet, setSheet] = useState<{ paperId: string; mode: "show" | "edit" } | null>(null);
  const [showPhotos, setShowPhotos] = useState(false);
  const params = useSearchParams();
  const deepLinked = useRef(false);

  const ready = state.ready ? state : null;
  const shares = useMemo(() => ready?.shares ?? [], [ready]);
  const papers = useMemo(() => ready?.papers ?? [], [ready]);
  const paperById = useMemo(() => new Map(papers.map((p) => [p.id, p])), [papers]);
  const shareById = useMemo(() => new Map(shares.map((s) => [s.document_id, s])), [shares]);
  const history = useMemo(() => paperHistory(shares), [shares]);
  const who_ = (id: string | null) => (id && ready?.people[id]) || "the office";

  // The Costs tab's Show On Portal: open this paper's sheet once, when the list is here.
  useEffect(() => {
    const id = params.get("paper");
    if (!ready || deepLinked.current || !id) return;
    deepLinked.current = true;
    if (!paperById.has(id)) {
      toast("That paper can't go on the customer's page. Receipts, bills and supplier invoices never do.", "error");
      return;
    }
    const s = shareById.get(id);
    setSheet({ paperId: id, mode: s && !s.removed_at ? "edit" : "show" });
    requestAnimationFrame(() => document.getElementById("portal-papers")?.scrollIntoView({ block: "start" }));
  }, [params, ready, paperById, shareById, toast]);

  if (!ready) {
    return (
      <Shell>
        <p className="mt-1 text-sm text-slate-600">{state.ready ? null : state.reason}</p>
      </Shell>
    );
  }

  const upsert = (row: SharedPaperRow) =>
    setState({ ...ready, shares: shareById.has(row.document_id) ? shares.map((s) => (s.document_id === row.document_id ? row : s)) : [row, ...shares] });

  function takeOff(s: SharedPaperRow) {
    const back = showsAgainIfTakenOff(shares, s.document_id);
    start(async () => {
      const res = await takePaperOff(s.document_id);
      if (!res.ok) {
        toast(res.error, "error");
        return;
      }
      upsert(res.row);
      toast(
        back ? `"${s.title}" is off ${who}'s page, so "${back.title}" shows there again.` : `"${s.title}" is off ${who}'s page.`,
        "success",
        { label: "Undo", onClick: () => void showPaper(s.document_id).then((u) => (u.ok ? upsert(u.row) : toast(u.error, "error"))) },
      );
    });
  }

  // Not on the page: never shown, or taken off (and nobody's earlier version). Photos are chosen on
  // the Photos tab; they are listed here only on request, to show one as a drawing or a plan.
  const inChain = new Set(history.current.flatMap((c) => [c.current.document_id, ...c.earlier.map((e) => e.share.document_id)]));
  const notUp = papers.filter((p) => !inChain.has(p.id) && !(shareById.get(p.id) && !shareById.get(p.id)!.removed_at));
  const notUpPapers = notUp.filter((p) => p.category !== "Photo");
  const notUpPhotos = notUp.filter((p) => p.category === "Photo");
  const current = history.current.filter((c) => c.current.kind !== "photo" || c.earlier.length > 0);

  return (
    <Shell>
      <p className="mt-1 text-sm text-slate-600">
        Plans, permits, circuit maps, drawings, renderings and 3D scans {who} can open on their page. When you upload a newer one,
        mark it as replacing the old one: {who} sees only the newest, and the old one stays here with who and when. Receipts,
        bills and supplier invoices are never shown.
      </p>

      {current.length ? (
        <>
          <h4 className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">On {who}&apos;s Page</h4>
          <ul className="mt-1 space-y-2">
            {current.map(({ current: s, earlier }) => {
              const p = paperById.get(s.document_id);
              const hidden = !p ? "Not on their page right now: the paper was re-filed as company paper or deleted." : p.refusal;
              return (
                <li key={s.document_id} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-start gap-3">
                    <Thumb p={p} />
                    <div className="min-w-0 flex-1">
                      <div className="[overflow-wrap:anywhere] text-sm font-semibold text-slate-900">{s.title}</div>
                      <div className="text-xs text-slate-500">
                        {kindLabel(s.kind)} · shown {formatDate(s.shared_at)} by {who_(s.shared_by)}
                      </div>
                      {hidden ? <div className="mt-1 text-xs font-medium text-amber-700">{hidden}</div> : null}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => setSheet({ paperId: s.document_id, mode: "edit" })} disabled={pending || !p}>
                      <Pencil className="h-4 w-4" /> Edit
                    </Button>
                    {p?.signedUrl ? (
                      <a href={p.signedUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-brand hover:bg-brand/5">
                        <ExternalLink className="h-4 w-4" /> Open
                      </a>
                    ) : null}
                    <Button variant="ghost" onClick={() => takeOff(s)} disabled={pending}>
                      <EyeOff className="h-4 w-4" /> Take Off Portal
                    </Button>
                  </div>
                  {earlier.length ? (
                    <details className="mt-2">
                      <summary className="flex min-h-[44px] cursor-pointer items-center gap-1.5 text-sm font-medium text-slate-600">
                        <History className="h-4 w-4" /> Earlier Versions ({earlier.length})
                      </summary>
                      <ul className="mt-1 divide-y divide-slate-100 rounded-lg border border-slate-200">
                        {earlier.map(({ share: e, replacedBy }) => {
                          const ep = paperById.get(e.document_id);
                          return (
                            <li key={e.document_id} className="px-3 py-2 text-xs text-slate-600">
                              <div className="flex items-center justify-between gap-2">
                                <span className="min-w-0 [overflow-wrap:anywhere] font-medium text-slate-800">{e.title}</span>
                                {ep?.signedUrl ? (
                                  <a href={ep.signedUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 shrink-0 items-center gap-1 px-2 font-medium text-brand">
                                    <ExternalLink className="h-3.5 w-3.5" /> Open
                                  </a>
                                ) : null}
                              </div>
                              <div>
                                {kindLabel(e.kind)} · shown {formatDate(e.shared_at)} by {who_(e.shared_by)}
                                {replacedBy?.replaces_marked_at
                                  ? ` · replaced by "${replacedBy.title}" ${formatDate(replacedBy.replaces_marked_at)} by ${who_(replacedBy.replaces_marked_by)}`
                                  : ""}
                                {e.removed_at ? ` · taken off ${formatDate(e.removed_at)} by ${who_(e.removed_by)}` : ""}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="mt-3 text-sm text-slate-500">No plans or drawings are on {who}&apos;s page yet.</p>
      )}

      <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">This Job&apos;s Papers</h4>
      {notUpPapers.length === 0 && !showPhotos ? (
        <p className="mt-1 text-sm text-slate-500">
          Nothing else to show. Upload a plan, a permit or a drawing under Costs, Receipts And Documents, filed as Plan, Permit or
          Other, and it appears here.
        </p>
      ) : null}
      <ul className="mt-1 space-y-2">
        {[...notUpPapers, ...(showPhotos ? notUpPhotos : [])].map((p) => {
          const s = shareById.get(p.id);
          return (
            <li key={p.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex items-start gap-3">
                <Thumb p={p} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-900 [overflow-wrap:anywhere]">{p.name}</div>
                  <div className="text-xs text-slate-500">
                    {p.category ?? "No category"} · added {formatDate(p.createdAt)}
                    {s?.removed_at ? ` · taken off ${formatDate(s.removed_at)} by ${who_(s.removed_by)}` : ""}
                  </div>
                  {p.refusal ? <div className="mt-1 text-xs font-medium text-amber-700">{p.refusal}</div> : null}
                </div>
              </div>
              <Button className="mt-2" variant="outline" onClick={() => setSheet({ paperId: p.id, mode: "show" })} disabled={pending || !!p.refusal}>
                {s ? <RotateCcw className="h-4 w-4" /> : <Globe className="h-4 w-4" />} {s ? "Put Back On Portal" : "Show On Portal"}
              </Button>
            </li>
          );
        })}
      </ul>
      {notUpPhotos.length ? (
        <Button variant="ghost" className="mt-2" onClick={() => setShowPhotos((v) => !v)}>
          {showPhotos ? "Hide The Photos" : `Show A Photo Here Too (${notUpPhotos.length})`}
        </Button>
      ) : null}

      {sheet ? (
        <PaperSheet
          key={`${sheet.paperId}-${sheet.mode}`}
          paper={paperById.get(sheet.paperId) ?? null}
          share={shareById.get(sheet.paperId) ?? null}
          mode={sheet.mode}
          shares={shares}
          who={who}
          onClose={() => setSheet(null)}
          onSaved={(row, replacedTitle) => {
            upsert(row);
            setSheet(null);
            const undo = sheet.mode === "show";
            toast(
              replacedTitle ? `"${row.title}" is on ${who}'s page in place of "${replacedTitle}".` : `"${row.title}" is on ${who}'s page.`,
              "success",
              undo
                ? { label: "Undo", onClick: () => void takePaperOff(row.document_id).then((u) => (u.ok ? upsert(u.row) : toast(u.error, "error"))) }
                : undefined,
            );
          }}
        />
      ) : null}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div id="portal-papers" className="scroll-mt-20 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
        <DraftingCompass className="h-4 w-4 text-[rgb(var(--glass-ink))]" /> Plans And Drawings
      </h3>
      {children}
    </div>
  );
}

function Thumb({ p }: { p: JobPaper | undefined }) {
  if (p?.format === "image" && p.signedUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={p.signedUrl} alt="" className="h-12 w-12 shrink-0 rounded-md object-cover" />;
  }
  const Icon = p?.format === "model" ? Box : FileText;
  return (
    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-slate-100">
      <Icon className="h-5 w-5 text-slate-400" />
    </span>
  );
}

/** Show a paper (or put it back), or edit one that is up: its title, what it is, what it replaces. */
function PaperSheet({
  paper,
  share,
  mode,
  shares,
  who,
  onClose,
  onSaved,
}: {
  paper: JobPaper | null;
  share: SharedPaperRow | null;
  mode: "show" | "edit";
  shares: SharedPaperRow[];
  who: string;
  onClose: () => void;
  onSaved: (row: SharedPaperRow, replacedTitle: string | null) => void;
}) {
  const [title, setTitle] = useState(share?.title ?? titleFromName(paper?.name) ?? "");
  const [kind, setKind] = useState<string>(share?.kind ?? defaultKindFor(paper?.category));
  const [replaces, setReplaces] = useState<string>(share?.replaces_document_id ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = useMemo(() => {
    const list = paper ? replaceChoices(shares, paper.id) : [];
    // What it replaces today stays choosable even though the customer no longer sees that one.
    const cur = share?.replaces_document_id ? shares.find((s) => s.document_id === share.replaces_document_id) : null;
    return cur && !list.some((s) => s.document_id === cur.document_id) ? [cur, ...list] : list;
  }, [paper, share, shares]);

  if (!paper) return null;
  const kinds = PORTAL_DOC_KINDS.filter((k) => k.key !== "photo" || paper.format === "image");

  async function save() {
    if (!paper) return;
    setSaving(true);
    setError(null);
    const patch = { title, kind, replaces: replaces || null };
    const res = mode === "edit" ? await updateShownPaper(paper.id, patch) : await showPaper(paper.id, patch);
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const replaced = res.row.replaces_document_id && res.row.replaces_document_id !== share?.replaces_document_id
      ? shares.find((s) => s.document_id === res.row.replaces_document_id)?.title ?? null
      : null;
    onSaved(res.row, replaced);
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={mode === "edit" ? "On The Portal" : "Show On Portal"}
      size="sm"
      footer={<ModalActions onCancel={onClose} onSave={save} saving={saving} saveLabel={mode === "edit" ? "Save" : "Show On Portal"} disabled={!title.trim()} />}
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Thumb p={paper} />
          <div className="min-w-0 text-sm">
            <div className="[overflow-wrap:anywhere] font-medium text-slate-900">{paper.name}</div>
            <div className="text-xs text-slate-500">
              {paper.category ?? "No category"} · added {formatDate(paper.createdAt)}
            </div>
          </div>
        </div>
        <div>
          <Label htmlFor="paper-title">Title {who} Reads</Label>
          <Input id="paper-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="Circuit Map" />
        </div>
        <div>
          <Label htmlFor="paper-kind">What It Is</Label>
          <Select id="paper-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {kinds.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="paper-replaces">Replaces</Label>
          <Select id="paper-replaces" value={replaces} onChange={(e) => setReplaces(e.target.value)}>
            <option value="">Nothing, it&apos;s new</option>
            {choices.map((s) => (
              <option key={s.document_id} value={s.document_id}>
                {s.title} ({kindLabel(s.kind)})
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-slate-500">
            {replaces
              ? `${who} will see only this one. The one it replaces stays here under Earlier Versions.`
              : `Pick the older one when this is a newer version, and ${who} sees only the newest.`}
          </p>
        </div>
        <p className="text-xs text-slate-500">It shows on {who}&apos;s page as soon as you save, with its title and date.</p>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        {saving ? <Loader2 className="h-4 w-4 animate-spin text-slate-400" /> : null}
      </div>
    </Modal>
  );
}
