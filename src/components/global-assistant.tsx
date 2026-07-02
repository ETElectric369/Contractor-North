"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AudioLines, Square, X, ChevronDown, ChevronUp, GripHorizontal } from "lucide-react";
import { AssistantChat } from "@/app/(app)/assistant/assistant-chat";
import { createClient } from "@/lib/supabase/client";
import { unlockAudio, stopSpeaking } from "@/lib/tts";
import * as speech from "@/lib/voice";
import { useEstimator } from "@/lib/estimator-store";

const PANEL_W = 384; // 24rem

// Only ONE effect run may answer ?debrief=1 (the ?new=1 claim-guard pattern) — released
// once the param is stripped, so the next deep-link tap works again.
let debriefParamClaimed = false;

/** Renders nothing — watches the URL for ?debrief=1 (the end-of-day push deep-links to
 *  /planner?debrief=1) and, for staff, launches the assistant with the debrief opener, then
 *  strips the param so a refresh or back-button doesn't re-run the interview. Lives in its
 *  own Suspense island because useSearchParams suspends at prerender (the Dock pattern). */
function DebriefEntry({ onLaunch }: { onLaunch: () => void }) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    if (searchParams.get("debrief") !== "1") {
      debriefParamClaimed = false; // param gone → release for the next deep-link
      return;
    }
    if (debriefParamClaimed) return;
    debriefParamClaimed = true;
    // Strip FIRST so the slow role lookup below can't double-fire on a re-render.
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.delete("debrief");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    // Staff only — the debrief interviews money + crew time; RLS/tool gating already
    // protects the data, this just keeps the entry off a tech's screen entirely.
    (async () => {
      try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        const { data: prof } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
        const role = (prof as { role?: string } | null)?.role ?? "";
        if (["owner", "admin", "office"].includes(role)) onLaunch();
      } catch {
        /* best-effort: no debrief beats a crash on open */
      }
    })();
  }, [searchParams, pathname, router, onLaunch]);
  return null;
}

/**
 * ONE assistant, everywhere. The topbar waveform is the single source-of-truth control — Talk
 * (open + listen + re-listen) / red Stop. The panel itself is a slim, draggable, collapsible
 * command box docked centered on the page: just the live status + estimate lines, no header text
 * and no in-panel mic. Voice + stop come from the topbar button; the handle moves/collapses/closes.
 */
export function GlobalAssistant() {
  const [open, setOpen] = useState(false);
  const [voiceLaunch, setVoiceLaunch] = useState(false); // Talk button → voice; command bar → text
  const [pendingQuery, setPendingQuery] = useState<string | null>(null); // a typed question from Cmd-K
  const [collapsed, setCollapsed] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null); // null until first open
  const drag = useRef<{ sx: number; sy: number; bx: number; by: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const { draft, speaking, streaming, listening } = useEstimator();
  const active = speaking || streaming || listening; // listening / thinking / talking → red STOP

  // Default dock: centered horizontally, just under the topbar.
  function centeredPos() {
    const w = Math.min(PANEL_W, window.innerWidth - 16);
    return { x: Math.round((window.innerWidth - w) / 2), y: 68 };
  }

  function launch() {
    // Prime audio + TTS INSIDE this tap (the gesture) so the spoken reply plays on iOS and the mic
    // can start the moment the panel opens — tap → talk, one motion.
    try {
      const synth = window.speechSynthesis;
      if (synth) { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; synth.speak(u); }
    } catch {}
    unlockAudio();
    // START THE MIC RIGHT HERE, INSIDE THE TAP. iOS only honors SpeechRecognition.start() inside the
    // user gesture — starting it later (the old post-mount effect) was the "mic never starts on iPhone"
    // bug. The chat panel (mounted next / already mounted) picks up the transcript via the shared service.
    speech.startListening();
    // Already open → the Talk button just re-opened the mic; tell the panel to resume the conversation.
    if (open) { window.dispatchEvent(new Event("cn:assistant-talk")); setCollapsed(false); return; }
    setPendingQuery(null);
    setVoiceLaunch(true);
    setCollapsed(false);
    setPos(centeredPos());
    setOpen(true);
  }

  // W5 — the end-of-day debrief deep-link (?debrief=1): open in text mode with the opener
  // query; the route's DAY DEBRIEF block takes it from there. Same launch shape as Cmd-K.
  function launchDebrief() {
    setVoiceLaunch(false);
    setPendingQuery("Run my end-of-day debrief.");
    setCollapsed(false);
    setPos(centeredPos());
    setOpen(true);
  }

  // Open from the Cmd-K command bar with a typed question — text mode, no auto-voice.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const q = (e as CustomEvent).detail?.q as string | undefined;
      setVoiceLaunch(false);
      setPendingQuery(q && q.trim() ? q.trim() : null);
      setCollapsed(false);
      setPos(centeredPos());
      setOpen(true);
    };
    window.addEventListener("cn:assistant-open", onOpen);
    return () => window.removeEventListener("cn:assistant-open", onOpen);
  }, []);

  // This is a NON-modal floating panel (no scrim, page stays usable) — so it does NOT hide the
  // mobile bottom nav. Instead, keep it on-screen after rotation / viewport resize.
  useEffect(() => {
    if (!open) return;
    const reclamp = () =>
      setPos((cur) => {
        if (!cur) return cur;
        const w = Math.min(PANEL_W, window.innerWidth - 16);
        const h = panelRef.current?.getBoundingClientRect().height ?? 80;
        return {
          x: Math.max(8, Math.min(window.innerWidth - w - 8, cur.x)),
          y: Math.max(8, Math.min(Math.max(8, window.innerHeight - h - 8), cur.y)),
        };
      });
    window.addEventListener("resize", reclamp);
    window.addEventListener("orientationchange", reclamp);
    window.visualViewport?.addEventListener("resize", reclamp);
    return () => {
      window.removeEventListener("resize", reclamp);
      window.removeEventListener("orientationchange", reclamp);
      window.visualViewport?.removeEventListener("resize", reclamp);
    };
  }, [open]);

  function closePanel() {
    stopSpeaking();
    window.dispatchEvent(new Event("cn:assistant-stop"));
    setOpen(false);
  }

  // Drag by the handle — pointer events cover both mouse and touch. Buttons inside the handle still click.
  function onHandleDown(e: React.PointerEvent) {
    if ((e.target as HTMLElement).closest("button")) return;
    const base = pos ?? centeredPos();
    drag.current = { sx: e.clientX, sy: e.clientY, bx: base.x, by: base.y };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
  }
  function onHandleMove(e: React.PointerEvent) {
    if (!drag.current) return;
    const d = drag.current;
    const w = Math.min(PANEL_W, window.innerWidth - 16);
    const h = panelRef.current?.getBoundingClientRect().height ?? 80;
    const x = Math.max(8, Math.min(window.innerWidth - w - 8, d.bx + (e.clientX - d.sx)));
    const y = Math.max(8, Math.min(Math.max(8, window.innerHeight - h - 8), d.by + (e.clientY - d.sy)));
    setPos({ x, y });
  }
  function onHandleUp(e: React.PointerEvent) {
    drag.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
  }

  const p = pos ?? { x: 8, y: 68 };

  return (
    <>
      <Suspense fallback={null}>
        <DebriefEntry onLaunch={launchDebrief} />
      </Suspense>
      {active ? (
        <button
          onClick={() => window.dispatchEvent(new Event("cn:assistant-stop"))}
          title="Stop"
          aria-label="Stop Nort"
          className="btn-gloss inline-flex h-10 w-10 items-center justify-center rounded-full bg-red-600 text-white shadow-sm transition-colors hover:bg-red-700"
        >
          <Square className="h-4 w-4 fill-current" />
        </button>
      ) : (
        <button
          onClick={launch}
          title="Talk to Nort"
          aria-label="Open Nort"
          className="btn-gloss inline-flex h-10 w-10 items-center justify-center rounded-full bg-brand text-white shadow-sm transition-colors hover:bg-brand-dark"
        >
          <AudioLines className="h-5 w-5" />
        </button>
      )}

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Nort"
          className="fixed z-[120] flex max-h-[75vh] flex-col overflow-hidden rounded-2xl border border-white/50 bg-white/90 shadow-2xl backdrop-blur-xl"
          style={{ left: p.x, top: p.y, width: `min(${PANEL_W}px, calc(100vw - 1rem))` }}
        >
          {/* Slim handle: drag grip · (collapsed summary) · collapse · close. No "Assistant" title. */}
          <div
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            className="flex shrink-0 cursor-grab touch-none select-none items-center gap-2 px-2 py-1 active:cursor-grabbing"
          >
            <GripHorizontal className="h-4 w-4 shrink-0 text-slate-300" />
            {collapsed && draft ? (
              <span className="truncate text-xs font-medium text-slate-500">
                <span className="font-semibold text-brand">ESTIMATOR</span>
                {draft.title ? ` · ${draft.title}` : ""}
              </span>
            ) : null}
            <span className="flex-1" />
            <button
              onClick={() =>
                setCollapsed((c) => {
                  const next = !c;
                  // Collapsing parks the conversation — stop voice so the mic isn't left hot behind a hidden panel.
                  if (next) window.dispatchEvent(new Event("cn:assistant-stop"));
                  return next;
                })
              }
              aria-label={collapsed ? "Expand" : "Collapse"}
              className="rounded p-1 text-slate-400 hover:bg-white/60"
            >
              {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
            </button>
            <button onClick={closePanel} aria-label="Close assistant" className="rounded p-1 text-slate-400 hover:bg-white/60">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className={collapsed ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
            <AssistantChat autoStart={voiceLaunch} initialQuery={pendingQuery ?? undefined} glass />
          </div>
        </div>
      )}
    </>
  );
}
