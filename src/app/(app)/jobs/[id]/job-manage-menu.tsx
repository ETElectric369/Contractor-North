"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Loader2, Receipt, Users, List, Trash2 } from "lucide-react";
import { GLASS_MENU_CLASS, useGlassMenuPlacement } from "@/components/ui/glass-menu";

/** The one menu-row style — shared with the modal-owning items (Edit / Propose /
 *  Finish) composed in as children, so every row in the panel looks identical. */
export const MANAGE_ROW_CLS =
  "relative z-10 flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-[rgb(var(--glass-tint))]/15 disabled:opacity-50";

/**
 * The job hub's "Manage ⋯" menu — absorbs everything demoted from the old
 * 7-control header row: Edit / Propose dates / Finish job (modal-owning items,
 * composed server-side and passed as `children`), Create invoice, the Customer +
 * All jobs links, and Delete (danger-styled, LAST). Replaces SectionActionsMenu +
 * jobSectionTree on this page (whose "Clock in here" ejected you to /timeclock —
 * the TIME button keeps you on the job now).
 *
 * THE MODAL RULE: the Modal renders IN-PLACE by default (it can opt into a `portal`,
 * but even then the child COMPONENT stays in this tree — portaling only moves the
 * overlay), so the children that own modals must stay MOUNTED while their modal is
 * open. The panel therefore never closes itself while <body> has `modal-open` (Modal
 * sets it in either mode): the outside-click and Escape close handlers bail —
 * including the click on a modal's own backdrop — and the z-[120] modal overlay simply
 * covers the z-[90] panel. Do NOT "fix" this with conditional rendering or display:none
 * on the panel; both silently destroy a half-filled form mid-edit (the Save-eating bug).
 */
export function JobManageMenu({
  isStaff,
  customerId,
  jobNumber,
  createInvoice,
  deleteJob,
  triggerClassName,
  children,
}: {
  isStaff: boolean;
  customerId?: string | null;
  jobNumber: string;
  /** Bound server action — creates the invoice, returns its id (staff). */
  createInvoice?: () => Promise<{ ok: boolean; error?: string; id?: string }>;
  /** Bound server action — deletes the job (staff). Called twice when the job has
   *  cascade children: once to LEARN what would be destroyed, then with
   *  confirmDestructive once the user has seen the real list and agreed. */
  deleteJob?: (opts?: { confirmDestructive?: boolean }) => Promise<{
    ok: boolean;
    error?: string;
    needsConfirm?: boolean;
    destroys?: string[];
  }>;
  triggerClassName?: string;
  /** Staff modal-owning menu items (JobEditButton etc. with `menuItem`). */
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // Viewport-aware vertical placement (shared hook): flips the panel upward when
  // the trigger sits low enough that Delete Job (deliberately LAST) would land
  // under the mobile bottom nav / off-screen; caps+scrolls if neither side fits.
  const { panelRef, panelStyle } = useGlassMenuPlacement(open);

  useEffect(() => {
    if (!open) return;
    const modalOpen = () => document.body.classList.contains("modal-open");
    const onDoc = (e: MouseEvent) => {
      // A child item's Modal is open (in-place, above us at z-[120]) — never close
      // underneath it; unmounting the panel would kill the modal mid-edit.
      if (modalOpen()) return;
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (modalOpen()) return; // Escape belongs to the open modal, not the panel
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function runCreateInvoice() {
    if (!createInvoice) return;
    setErr(null);
    setBusy("invoice");
    try {
      const res = await createInvoice();
      if (res.ok && res.id) {
        setOpen(false);
        router.push(`/billing/${res.id}`);
        return;
      }
      setErr(res.error ?? "Couldn't create the invoice.");
    } catch {
      setErr("Couldn't create the invoice.");
    } finally {
      setBusy(null);
    }
  }

  async function runDelete() {
    if (!deleteJob) return;
    // First confirm covers only what we can promise without asking the server. The old
    // copy stopped here and claimed nothing was lost — untrue: contracts, lien records,
    // permits, change orders and every job photo CASCADE away. So the server itemizes
    // the real damage and we put THAT in front of the user before anything is deleted.
    if (!confirm(`Delete job ${jobNumber}? Time entries, estimates, and invoices keep their data but lose the job link.`)) return;
    setErr(null);
    setBusy("delete");
    try {
      let res = await deleteJob();
      if (res.needsConfirm && res.destroys?.length) {
        const list = res.destroys.map((d) => `  • ${d}`).join("\n");
        const agreed = confirm(
          `Deleting job ${jobNumber} also permanently deletes:\n\n${list}\n\nThis cannot be undone. Delete anyway?`,
        );
        if (!agreed) {
          setBusy(null);
          return;
        }
        res = await deleteJob({ confirmDestructive: true });
      }
      if (res.ok) {
        setOpen(false);
        router.push("/jobs");
        return;
      }
      setErr(res.error ?? "Could not delete.");
    } catch {
      setErr("Could not delete.");
    } finally {
      setBusy(null);
    }
  }

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Manage job"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Manage job"
        className={
          triggerClassName ??
          "inline-flex h-11 w-11 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
        }
      >
        <MoreHorizontal className="h-5 w-5" />
        {/* Tiny visible caption at phone width (the dock's ICON_BTN stacks it under
            the ⋯ — 60mph glanceability); sm+ keeps the classic icon-only ⋯ trigger. */}
        <span className="sm:sr-only">Manage</span>
      </button>
      {open && (
        // position set inline because .glass-gloss forces position:relative, which
        // would override a Tailwind `absolute` (the documented gotcha). Right-anchored:
        // Manage is the dock's rightmost control; panelStyle owns the vertical side
        // (down, or UP near the bottom of the viewport / the mobile bottom nav).
        <div
          ref={panelRef}
          style={{ ...panelStyle, right: 0 }}
          className={`${GLASS_MENU_CLASS} w-60`}
        >
          {/* Opaque backing — the "ghost Edit pill" / menu-opacity bug. This panel
              hangs INSIDE the dock bar, which has its own backdrop-filter; that makes
              the bar a backdrop root, so the panel's blur can't sample the page behind
              it and glass-menu's 40% white let the Overview card's outline buttons read
              straight through the rows. The account menu doesn't need this (its topbar
              is plain bg-white, so its blur works) — here we back the glass with a
              near-solid tinted layer instead. -z-10 paints it above the panel's own
              glass fill but below the .glass-gloss sheen and the z-10 rows. */}
          <div aria-hidden className="absolute inset-0 -z-10 bg-white/85" />
          <div aria-hidden className="absolute inset-0 -z-10 bg-[rgb(var(--glass-tint))]/10" />
          {children}
          {isStaff && createInvoice && (
            <button onClick={runCreateInvoice} disabled={busy !== null} className={MANAGE_ROW_CLS}>
              {busy === "invoice" ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[rgb(var(--glass-ink))]" />
              ) : (
                <Receipt className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" />
              )}
              Create Invoice
            </button>
          )}
          {/* Techs see just the clean short list (Customer + All jobs) — no divider needed. */}
          {isStaff && <div className="relative z-10 my-1 border-t border-white/50" />}
          {customerId && (
            <button onClick={() => go(`/crm/${customerId}`)} className={MANAGE_ROW_CLS}>
              <Users className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> Customer
            </button>
          )}
          <button onClick={() => go("/jobs")} className={MANAGE_ROW_CLS}>
            <List className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> All Jobs
          </button>
          {isStaff && deleteJob && (
            <>
              <div className="relative z-10 my-1 border-t border-white/50" />
              <button
                onClick={runDelete}
                disabled={busy !== null}
                className="relative z-10 flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium text-red-600 hover:bg-red-50/60 disabled:opacity-50"
              >
                {busy === "delete" ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4 shrink-0" />
                )}
                Delete Job
              </button>
            </>
          )}
          {err && <div className="relative z-10 px-4 py-1.5 text-xs text-red-600">{err}</div>}
        </div>
      )}
    </div>
  );
}
