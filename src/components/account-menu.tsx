"use client";

import { useEffect, useRef, useState } from "react";
import { LogOut } from "lucide-react";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ShareQrButton } from "@/components/share-qr-button";
import { initials } from "@/lib/utils";
import { signOut } from "@/app/login/actions";
import type { Profile } from "@/lib/types";

/**
 * The topbar's ACCOUNT seek door — the avatar, always visible, far right.
 * One small glass menu holds the rare deliberate verbs that used to sit as
 * always-on bar buttons: the estimate QR, the language toggle, and Sign out
 * (the app's most destructive one-tap verb, now one deliberate tap away
 * instead of beside Quick-add).
 *
 * THE MODAL RULE: ShareQrButton renders its QR <Modal> IN-PLACE (not portaled),
 * so this panel must stay MOUNTED while that modal is open. The outside-click
 * and Escape close handlers therefore bail while <body> has `modal-open`
 * (Modal always sets it) — the z-[120] modal simply covers the z-[90] panel.
 * Same pattern as job-manage-menu.tsx; do NOT "fix" it with conditional
 * rendering or display:none on the panel.
 */
export function AccountMenu({
  profile,
  lang,
}: {
  profile: Profile | null;
  lang?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const modalOpen = () => document.body.classList.contains("modal-open");
    const onDoc = (e: MouseEvent) => {
      // The QR modal is open (in-place, above us at z-[120]) — never close
      // underneath it; unmounting the panel would kill the modal mid-view.
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

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Account"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Account"
        className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-slate-100"
      >
        {profile?.avatar_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={profile.avatar_url}
            alt=""
            className="h-9 w-9 rounded-full object-cover"
          />
        ) : (
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-sm font-semibold text-white">
            {initials(profile?.full_name)}
          </span>
        )}
      </button>
      {open && (
        /* Anchored to the VIEWPORT, not the button: the topbar can scroll/offset,
           which would drag an absolute menu up behind the bar (the documented
           quick-add gotcha). position is set INLINE because .glass-gloss forces
           position:relative (for its ::before sheen), which would override a
           Tailwind `fixed`. top 4.5rem clears the 4rem header. */
        <div
          style={{ position: "fixed", top: "4.5rem", right: "0.5rem" }}
          className="glass glass-gloss glass-menu z-[90] w-60 overflow-hidden rounded-lg py-1.5 shadow-xl"
        >
          {/* Who am I — moved out of the bar (it was hidden < sm anyway). */}
          <div className="relative z-10 border-b border-white/50 px-4 pb-2.5 pt-1">
            <div className="truncate text-sm font-medium text-slate-900">
              {profile?.full_name ?? "—"}
            </div>
            <div className="text-xs capitalize text-slate-400">{profile?.role ?? "user"}</div>
          </div>
          {/* Every employee's personal estimate link/QR — leads through it are
              credited to them. The control keeps its known face from the bar. */}
          <div className="relative z-10 flex min-h-[44px] items-center justify-between gap-3 px-4 py-1">
            <span className="text-sm font-medium text-slate-700">Estimate QR</span>
            <ShareQrButton />
          </div>
          <div className="relative z-10 flex min-h-[44px] items-center justify-between gap-3 px-4 py-1">
            <span className="text-sm font-medium text-slate-700">Language</span>
            <LanguageSwitcher current={lang} />
          </div>
          <div className="relative z-10 my-1 border-t border-white/50" />
          <form action={signOut}>
            <button className="relative z-10 flex min-h-[44px] w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-[rgb(var(--glass-tint))]/15">
              <LogOut className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
