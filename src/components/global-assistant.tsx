"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { safeAreaLeft, safeAreaRight, safeAreaTop } from "@/lib/native-shell";
import { isStaffRole } from "@/lib/actions/perms";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { X, ChevronDown, ChevronUp, GripHorizontal } from "lucide-react";
import { AssistantChat } from "@/app/(app)/assistant/assistant-chat";
import { createClient } from "@/lib/supabase/client";
import { unlockAudio, stopSpeaking } from "@/lib/tts";
import { isNativeShell } from "@/lib/native-shell";
import { standDownReaderForVoice } from "@/lib/native-tap";
import * as speech from "@/lib/voice";
import { useEstimator } from "@/lib/estimator-store";
import { NORT_TALK_EVENT } from "@/lib/onboarding/help-rows";

const PANEL_W = 384; // 24rem

// Only ONE effect run may answer each staff deep-link param (the ?new=1 claim-guard pattern) —
// released once the param is stripped, so the next deep-link tap works again.
const claimedParams = new Set<string>();

/** Renders nothing — watches the URL for a staff deep-link param (?debrief=1 end-of-day, or
 *  ?attention=1 "what needs my attention") and, for staff, launches the assistant with the matching
 *  opener, then strips the param so a refresh / back-button doesn't re-run it. Lives in its own
 *  Suspense island because useSearchParams suspends at prerender (the Dock pattern). */
function DeepLinkOpener({ param, onLaunch }: { param: string; onLaunch: () => void }) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    if (searchParams.get(param) !== "1") {
      claimedParams.delete(param); // param gone → release for the next deep-link
      return;
    }
    if (claimedParams.has(param)) return;
    claimedParams.add(param);
    // Strip FIRST so the slow role lookup below can't double-fire on a re-render.
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.delete(param);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    // Staff only — these openers surface money + crew data; RLS/tool gating already protects the
    // data, this just keeps the entry off a tech's screen entirely.
    (async () => {
      try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        const { data: prof } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
        const role = (prof as { role?: string } | null)?.role ?? "";
        if (isStaffRole(role)) onLaunch();
      } catch {
        /* best-effort: no opener beats a crash on open */
      }
    })();
  }, [searchParams, pathname, router, param, onLaunch]);
  return null;
}

/**
 * ONE assistant, everywhere — and no button of its own: the top bar draws Nort's (W1-09).
 *
 * The voice starts from TALK TO NORT — the top bar's one-tap Nort button and the first row under
 * Search Or Ask (command-bar.tsx) both call talkToNort(), which dispatches `cn:nort-talk`; the
 * listener below runs launch() inside that dispatch, so the mic starts in the tap's own call stack
 * (iOS). While Nort listens, thinks or speaks, the bar's Nort button turns into the red Stop Nort
 * (topbar.tsx), so the bar still has exactly one voice control.
 * What stays here: the panel — a slim, draggable, collapsible command box docked centered on the
 * page, the live status + estimate lines, no header text and no in-panel mic — and the ?debrief= /
 * ?attention= openers. Mounted while Nort is on.
 */
export function GlobalAssistant() {
  const [open, setOpenState] = useState(false);
  // THE PANEL'S OPEN STATE, READABLE FROM A LISTENER ADDED ONCE. launch() now runs from a window
  // event whose listener is registered on mount; a closure over `open` would see the value from
  // that first render forever, so a second Talk To Nort into an OPEN panel would remount the chat
  // instead of resuming it. The ref is written in the same breath as the state.
  const openRef = useRef(false);
  const setOpen = (v: boolean) => {
    openRef.current = v;
    setOpenState(v);
  };
  const [voiceLaunch, setVoiceLaunch] = useState(false); // Talk To Nort → voice; command bar → text
  const [pendingQuery, setPendingQuery] = useState<string | null>(null); // a typed question from Cmd-K
  const [collapsed, setCollapsed] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null); // null until first open
  const drag = useRef<{ sx: number; sy: number; bx: number; by: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const { draft } = useEstimator();

  /**
   * WHERE THE PANEL IS ALLOWED TO SIT — one rule, so the default position, the rotate clamp and the
   * drag clamp cannot disagree about the edges. The shell paints edge to edge (contentInset never),
   * so on a turned phone the Dynamic Island covers about 59pt of ONE side: a bare 8px left it
   * underneath (Erik, 2026-10-01: "Nort's box was off the page to the left a bit"). The side insets
   * are 0 in portrait and in a browser, so this changes nothing there.
   */
  function panelBounds() {
    const left = safeAreaLeft() + 8;
    const right = safeAreaRight() + 8;
    const w = Math.min(PANEL_W, Math.max(120, window.innerWidth - left - right));
    return { left, right, w, maxX: Math.max(left, window.innerWidth - right - w) };
  }
  const clampPos = (x: number, y: number, h: number) => {
    const b = panelBounds();
    return {
      x: Math.max(b.left, Math.min(b.maxX, x)),
      y: Math.max(8 + safeAreaTop(), Math.min(Math.max(8, window.innerHeight - h - 8), y)),
    };
  };

  // Default dock: centered horizontally between the insets, just under the topbar.
  function centeredPos() {
    const b = panelBounds();
    return { x: Math.round(b.left + (window.innerWidth - b.left - b.right - b.w) / 2), y: 68 + safeAreaTop() };
  }

  // The listener is added once, so it calls whatever launch() is CURRENT through this ref.
  const launchRef = useRef<() => void>(() => {});
  launchRef.current = launch;
  useEffect(() => {
    // SYNCHRONOUS, ON PURPOSE: dispatchEvent runs this before the tap's handler returns, so
    // launch() — and speech.startListening() inside it — is still inside the user gesture. Never
    // put a setTimeout, a promise or an await in front of it (the mic-never-starts-on-iPhone bug).
    const onTalk = () => launchRef.current();
    window.addEventListener(NORT_TALK_EVENT, onTalk);
    return () => window.removeEventListener(NORT_TALK_EVENT, onTalk);
  }, []);

  function launch() {
    // Prime audio + TTS INSIDE this tap (the gesture) so the spoken reply plays on iOS and the mic
    // can start the moment the panel opens — tap → talk, one motion.
    try {
      const synth = window.speechSynthesis;
      // Not in the app: there the browser voice runs in the app's own process, and priming it switches
      // the app's audio session on against WebKit's (the crackle, 2026-09-24). See quietBrowserVoice.
      if (synth && !isNativeShell()) { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; synth.speak(u); }
    } catch {}
    unlockAudio();
    void standDownReaderForVoice(); // the Tap to Pay reader and Nort's voice don't share the phone (native-tap)
    // START THE MIC RIGHT HERE, INSIDE THE TAP. iOS only honors SpeechRecognition.start() inside the
    // user gesture — starting it later (the old post-mount effect) was the "mic never starts on iPhone"
    // bug. The chat panel (mounted next / already mounted) picks up the transcript via the shared service.
    speech.startListening();
    // Already open → Talk To Nort just re-opened the mic; tell the panel to resume the conversation.
    // openRef, not `open`: this runs from a listener registered once (see above).
    if (openRef.current) { window.dispatchEvent(new Event("cn:assistant-talk")); setCollapsed(false); return; }
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

  // ?attention=1 (a My Day button / morning push) → Nort as business analyst: it calls needs_attention
  // and reads back the leaks (stale estimates, past-due jobs, unbilled work, overdue invoices) by name.
  function launchAttention() {
    setVoiceLaunch(false);
    setPendingQuery("What needs my attention?");
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
        // A panel the person never dragged used to return here untouched, so a turn left it wherever
        // the DEFAULT had put it for the old viewport. That is the case Erik hit, so an undragged
        // panel is re-defaulted rather than skipped.
        const h = panelRef.current?.getBoundingClientRect().height ?? 80;
        if (!cur) {
          const d = centeredPos();
          return clampPos(d.x, d.y, h);
        }
        return clampPos(cur.x, cur.y, h);
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

  const p = pos ?? { x: 8, y: 68 + safeAreaTop() };

  return (
    <>
      <Suspense fallback={null}>
        <DeepLinkOpener param="debrief" onLaunch={launchDebrief} />
        <DeepLinkOpener param="attention" onLaunch={launchAttention} />
      </Suspense>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Nort"
          className="fixed z-[120] flex max-h-[75vh] flex-col overflow-hidden rounded-2xl border border-white/50 bg-white/90 shadow-2xl backdrop-blur-xl"
          style={{
            // The side insets keep it clear of the Dynamic Island on a turned phone, and are 0 in
            // portrait and in a browser. Done in CSS so the FIRST paint is right, before any
            // measurement runs; the clamp above then refines it on every turn and resize.
            left: `max(${p.x}px, calc(var(--sal, 0px) + 8px))`,
            top: p.y,
            width: `min(${PANEL_W}px, calc(100vw - var(--sal, 0px) - var(--sar, 0px) - 1rem))`,
          }}
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
