"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Loader2, Pause, Play, Trash2 } from "lucide-react";
import { GLASS_MENU_CLASS } from "@/components/ui/glass-menu";
import { EditMemberButton } from "../settings/edit-member-button";
import { setMemberActive, memberFootprint, removeMember } from "../settings/actions";

/** The one menu-row style — shared with EditMemberButton (composed in as the first row)
 *  so every row in the panel looks identical (same recipe as JobManageMenu). */
const ROW_CLS =
  "relative z-10 flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-[rgb(var(--glass-tint))]/15 disabled:opacity-50";

interface Member {
  id: string;
  full_name: string | null;
  email: string | null;
  phone?: string | null;
  role: string;
  active: boolean;
  home_address?: string | null;
  commute_baseline_miles?: number | null;
  crew_lead?: boolean;
}

/**
 * The /team roster's per-member "⋯" SEEK menu — the real lifecycle verbs a member
 * carries: Edit & role + Reset login (the composed EditMemberButton modal), Deactivate
 * / Reactivate (setMemberActive — a deactivated member is actually locked OUT now, the
 * app layout redirects them), and Remove (danger, LAST). Remove is the zero-footprint
 * path only: a member who ever logged time is DEACTIVATED to keep their history (how the
 * operator removed Ryan/Danny); only a never-used account is offered a hard remove.
 *
 * THE MODAL RULE: EditMemberButton renders its Modal IN-PLACE, so this panel must stay
 * MOUNTED while that modal is open — the outside-click / Escape handlers bail while
 * <body> has `modal-open` (Modal always sets it), and the z-[120] modal covers the
 * z-[90] panel. Same pattern as job-manage-menu.tsx / account-menu.tsx; do NOT "fix" it
 * with conditional rendering or display:none — it destroys a half-filled form mid-edit.
 */
export function TeamMemberMenu({
  member,
  isSelf,
  isOwnerRow,
  authConfigured,
}: {
  member: Member;
  isSelf: boolean;
  /** The member being managed is the org owner — never offer deactivate/remove. */
  isOwnerRow: boolean;
  authConfigured: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const modalOpen = () => document.body.classList.contains("modal-open");
    const onDoc = (e: MouseEvent) => {
      if (modalOpen()) return; // the Edit modal is open above us — never unmount underneath it
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (modalOpen()) return; // Escape belongs to the open modal
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function runToggleActive() {
    setErr(null);
    setBusy("active");
    try {
      const res = await setMemberActive(member.id, !member.active);
      if (res.ok) {
        setOpen(false);
        router.refresh();
        return;
      }
      setErr(res.error ?? "Could not update.");
    } finally {
      setBusy(null);
    }
  }

  async function runRemove() {
    setErr(null);
    setBusy("remove");
    try {
      // Footprint gate: a member with logged time keeps their history — steer to Deactivate.
      const fp = await memberFootprint(member.id);
      if (!fp.ok) {
        setErr(fp.error ?? "Could not check history.");
        return;
      }
      if ((fp.timeEntries ?? 0) > 0) {
        setErr("This person has logged time — deactivate them instead to keep their history.");
        return;
      }
      if (!confirm(`Remove ${member.full_name ?? "this member"}? They've never clocked in, so this deletes their account outright. This can't be undone.`)) {
        return;
      }
      const res = await removeMember(member.id);
      if (res.ok) {
        setOpen(false);
        router.refresh();
        return;
      }
      setErr(res.error ?? "Could not remove.");
    } finally {
      setBusy(null);
    }
  }

  const canLifecycle = !isSelf && !isOwnerRow;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={`Manage ${member.full_name ?? "member"}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Manage member"
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
      >
        <MoreHorizontal className="h-5 w-5" />
      </button>
      {open && (
        // position set inline because .glass-gloss forces position:relative, which would
        // override a Tailwind `absolute` (the documented gotcha). Right-anchored — ⋯ is
        // the row's rightmost control.
        <div
          style={{ position: "absolute", right: 0, top: "calc(100% + 0.25rem)" }}
          className={`${GLASS_MENU_CLASS} w-56`}
        >
          {/* Opaque backing — the roster list can sit inside a card; keep the glass rows
              from reading the content behind them (the "ghost row" bug). */}
          <div aria-hidden className="absolute inset-0 -z-10 bg-white/85" />
          <div aria-hidden className="absolute inset-0 -z-10 bg-[rgb(var(--glass-tint))]/10" />

          {/* Edit & role + Reset login (email/password) — the composed modal. */}
          <EditMemberButton
            member={member}
            isSelf={isSelf}
            authConfigured={authConfigured}
            menuItem
            rowClassName={ROW_CLS}
          />

          {canLifecycle && (
            <>
              <div className="relative z-10 my-1 border-t border-white/50" />
              <button onClick={runToggleActive} disabled={busy !== null} className={ROW_CLS}>
                {busy === "active" ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[rgb(var(--glass-ink))]" />
                ) : member.active ? (
                  <Pause className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" />
                ) : (
                  <Play className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" />
                )}
                {member.active ? "Deactivate (lock out)" : "Reactivate"}
              </button>
              <button
                onClick={runRemove}
                disabled={busy !== null}
                className="relative z-10 flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium text-red-600 hover:bg-red-50/60 disabled:opacity-50"
              >
                {busy === "remove" ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4 shrink-0" />
                )}
                Remove
              </button>
            </>
          )}
          {err && <div className="relative z-10 px-4 py-1.5 text-xs text-red-600">{err}</div>}
        </div>
      )}
    </div>
  );
}
