"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { Download, Loader2, Printer, RefreshCw } from "lucide-react";
import { BackLink } from "@/components/back-link";
import { pdfPreviewBackHref } from "@/lib/pdf-preview-back";
import { pageWidthInside, worthRedrawing } from "@/lib/pdf-page-width";
import { renderTurns } from "@/lib/pdf-render-turns";
import {
  FIT,
  NO_GESTURE,
  SHARP_MOST,
  drawDensity,
  gestureStep,
  mouseDoubleClickCounts,
  nearestFirst,
  onScreen,
  placeOnSheet,
  scrollToKeep,
  worthSharpening,
  zoomAfterDoubleTap,
  zoomAfterWheel,
  zoomedSize,
  type GestureAct,
  type GestureEvent,
  type GestureState,
} from "@/lib/pdf-zoom";
import { EVERY_WAY_HELD, type Box, type Held, type Point } from "@/lib/turned-geometry";
import { Turned } from "@/components/turned";

const MARGINS = [
  { v: 0.5, label: "Narrow · ½ in" },
  { v: 0.75, label: "Normal · ¾ in" },
  { v: 1, label: "Wide · 1 in" },
];

/**
 * WHICHEVER ELEMENT IS ACTUALLY SCROLLING THE SHEETS. Upright that is the box itself, as it always
 * was. Turned sideways the box becomes the frame and the quarter-turned face inside it is the
 * scroller (globals.css), so "keep his place across a repaint" has to read and write the scrollTop of
 * THAT one — written to the wrong element it is silently a no-op, and page 5 of an invoice becomes
 * page 1 every time the phone turns, which is the exact bug the place-keeping is there to prevent.
 */
function theScroller(box: HTMLElement | null): HTMLElement | null {
  if (!box) return null;
  return box.querySelector<HTMLElement>(":scope > .turn-face[data-held]") ?? box;
}

/**
 * HOW THE PHONE IS BEING HELD, read off the same element theScroller() goes by: the turned face
 * carries the word it was drawn with, and upright there is no such face. A gesture read here needs
 * it for one thing, the same thing pull-to-refresh needs it for: a finger's place on the glass is a
 * quarter turn away from its place on a sheet that is drawn turned (lib/pdf-zoom).
 */
function heldNow(box: HTMLElement | null): Held {
  const word = box?.querySelector<HTMLElement>(":scope > .turn-face[data-held]")?.dataset.held;
  return EVERY_WAY_HELD.find((h) => h === word) ?? "upright";
}

/** Every sheet in the list, in page order, whether or not it is in view. */
function sheetsIn(host: HTMLElement | null): HTMLCanvasElement[] {
  return host ? Array.from(host.querySelectorAll<HTMLCanvasElement>("canvas.pdf-page-canvas")) : [];
}

/** The size a sheet was FITTED at, which every zoomed size is worked out from (lib/pdf-zoom). */
function fittedSizeOf(sheet: HTMLCanvasElement): Box {
  return { width: Number(sheet.dataset.fitW) || 0, height: Number(sheet.dataset.fitH) || 0 };
}

/** The sheet on the screen for one page, found again each time: a sharper drawing replaces the element. */
function sheetFor(host: HTMLElement, page: string): HTMLCanvasElement | null {
  return host.querySelector<HTMLCanvasElement>(`canvas.pdf-page-canvas[data-page="${page}"]`);
}

/**
 * GIVE A CANVAS'S MEMORY BACK NOW. Taking a canvas out of the page is not enough on an iPhone, which
 * keeps its bitmap until the element is collected; a canvas of no size has no bitmap to keep.
 */
function release(canvas: HTMLCanvasElement | null) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * LET GO OF EVERY SHARP SHEET AND EVERY FITTED SHEET KEPT BEHIND ONE, before the list is emptied for a
 * fresh draw or the screen is left: the sharp ones are in the list, the kept ones are only in the map.
 */
function letGoOfSharp(host: HTMLElement | null, bases: Map<string, HTMLCanvasElement>) {
  for (const base of bases.values()) release(base);
  bases.clear();
  if (!host) return;
  for (const sharp of host.querySelectorAll<HTMLCanvasElement>('canvas[data-sharp="1"]')) release(sharp);
}

/**
 * WHICH SHEET IS BEING READ: the one nearest the middle of what the scroller shows. Measured on the
 * glass, so it is the same question whichever way the phone is held.
 */
function sheetBeingRead(sheets: HTMLCanvasElement[], scroller: HTMLElement | null): number {
  if (!scroller || sheets.length === 0) return 0;
  const view = scroller.getBoundingClientRect();
  const middle = { x: view.left + view.width / 2, y: view.top + view.height / 2 };
  let best = 0;
  let bestGap = Infinity;
  sheets.forEach((sheet, i) => {
    const r = sheet.getBoundingClientRect();
    const gap = Math.hypot(r.left + r.width / 2 - middle.x, r.top + r.height / 2 - middle.y);
    if (gap < bestGap) {
      best = i;
      bestGap = gap;
    }
  });
  return best;
}

/**
 * HOW SHARP THIS DOCUMENT IS DRAWN, by how many pages it has. These canvases ARE the print output,
 * so resolution matters, but every page is retained at once, and at 3x a letter page is ~24 MB of
 * bitmap. A 12-page material list blew past what an iOS PWA will hold and the tab reloaded
 * mid-review. Budget the TOTAL pixels instead: full quality for a short doc, stepping down (never
 * below 1.5x, which still prints cleanly) as the page count grows.
 */
function sharpnessFor(pages: number): number {
  const HIGH = Math.min(Math.max(window.devicePixelRatio || 1, 2.5), 3);
  return pages <= 4 ? HIGH : pages <= 10 ? 2 : 1.5;
}

/**
 * The document PDF viewer. Renders the server-generated PDF page-by-page onto canvases
 * with PDF.js — NOT an <iframe>, because Safari's PWA shell simply refuses to display
 * PDFs in frames (Erik's blank grey screen). What's drawn here are the exact bytes of
 * the file Download saves and Print prints.
 */
export function PdfPreview({ doc, id, back }: { doc: string; id: string; back: string }) {
  const [m, setM] = useState(0.75);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  // Print stays disabled until EVERY page is on canvas (audit 7: enabling it at page 1 let a
  // fast tap print a money document with blank tail pages). Reset at the top of every load —
  // a stale true from the previous render re-opened the same window on each margin change.
  const [allPainted, setAllPainted] = useState(false);
  const [error, setError] = useState("");
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [filename, setFilename] = useState("document.pdf");
  const pagesRef = useRef<HTMLDivElement>(null);
  // WHOSE TURN IT IS TO OWN THIS SCREEN. Fetching a new document and redrawing the one in hand are
  // two different jobs with two different rules, and one shared counter let them cancel each other:
  // a rotation mid-fetch dropped the margin he chose, silently, and an interrupted rotation left the
  // sheets drawn for the other orientation. lib/pdf-render-turns.ts carries both rules and their trace.
  const turns = useRef(renderTurns());
  // THE DOCUMENT IS KEPT so the pages can be DRAWN AGAIN at a new width without fetching it twice.
  // Turning the phone sideways more than doubles the room a page has (Erik, 2026-10-01: rotation
  // should work "like documents especially"), and these canvases are bitmaps — a page rasterized for
  // a 374pt-wide phone, stretched to 812, is the same small page blown up. The buffer can't be kept
  // instead: pdf.js may hand its ArrayBuffer to the worker and detach it.
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  /** Always rendered, zero height, never display:none — the one thing that can always be measured. */
  const measureRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /**
   * HOW FAR DOWN THE DOCUMENT HE IS, remembered as he scrolls rather than read when a repaint starts.
   *
   * Turning the phone CHANGES WHICH ELEMENT SCROLLS: upright it is the box below, turned it is the
   * quarter-turned face inside it (globals.css). The instant that swap lands, the box's content is gone
   * — its scrollTop is forced to 0 — and the face starts at 0, so a fraction read at the top of a
   * repaint was always 0 and the place-keeping that repaint is famous for did nothing at all: page 5 of
   * an invoice became page 1 every time the phone turned, which is the exact bug it exists to prevent.
   */
  const placeKept = useRef(0);
  /** True while a repaint is emptying and refilling the list, when a scroll to 0 is not a place. */
  const repainting = useRef(false);
  /**
   * HOW FAR IN THE SHEETS ARE ZOOMED. FIT after every fresh draw; only a pinch, a double tap or
   * ctrl + wheel moves it (the effect further down). A ref and never state: a pinch changes it sixty
   * times a second and nothing React draws depends on it. The sheets' own CSS size IS the zoom.
   */
  const zoomRef = useRef(FIT);
  /** The sharper drawing that follows a gesture, or a scroll while zoomed, waiting for it to stop. */
  const sharpenSoon = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /**
   * THE WHOLE DOCUMENT IS ON THE SCREEN: false from the moment a load or a fresh draw starts, true only
   * when a fresh draw finishes still owning the list. Nothing zooms and nothing sharpens until then,
   * so a gesture never lands on sheets that are about to be replaced, and never on the sheets of a
   * document that failed, which stay in the hidden list under the error.
   */
  const drawnWhole = useRef(false);
  /** Moved by every load, every fresh draw and leaving the screen: a sharper drawing that sees it move stops. */
  const epoch = useRef(0);
  /** Moved by every sharper drawing that starts, and by every finger that lands on the sheets, so one
   *  still running stops at its next wait. */
  const sharpenRun = useRef(0);
  /** THE FITTED SHEETS KEPT behind the sharp ones, by page number, to put back when a sheet goes out of view. */
  const bases = useRef<Map<string, HTMLCanvasElement>>(new Map());
  /**
   * A FINGER IS ON THE SHEETS, AND NO SHEET IS SWAPPED UNDER A FINGER. A browser sends every later
   * event of a touch to the element the finger first landed on, and once that element is off the page
   * those events no longer reach the box: a second pinch, made while the sharper drawing of the first
   * was still under way, stopped answering half way with the fingers still moving. So no sharper
   * drawing starts while this is true, the one under way is stopped by the touch that makes it true,
   * and the last finger up asks for it again (the gesture effect below).
   */
  const fingerDown = useRef(false);

  /**
   * How wide a page may be drawn right now. Measured from inside the scroller rather than from
   * window.innerWidth, because sideways the camera cutout takes ~59pt off EACH side (globals.css pads
   * this scroller past it) — a page sized from the window would have been drawn under the notch.
   * Clamped exactly as before: never under 280, never over 900, and the same 16px of breathing room
   * around the sheet so a portrait phone draws precisely what it drew before.
   */
  const roomForAPage = useCallback(() => {
    return pageWidthInside(measureRef.current?.clientWidth ?? window.innerWidth - 16);
  }, []);

  /**
   * DRAW THE PAGES at a given width. Split out of load() so turning the phone redraws from the
   * document already in hand instead of asking the server for the same bytes again — on cellular a
   * 6 MB plan set fetched on every rotation is the kind of thing that makes a man stop turning his
   * phone.
   *
   * A PAINT TURN cancels other paints and NOTHING ELSE. It must never cancel a load: the load is
   * fetching the margin he just tapped, and a turn of the phone that outranked it dropped that margin
   * on the floor with no spinner and no error (pdf-render-turns.ts).
   */
  const paint = useCallback(async (pdf: PDFDocumentProxy, containerW: number) => {
    const host = pagesRef.current;
    if (!host) return;
    // CLAIM THE WIDTH NOW, not when the last page lands — the list is emptied below, so from this
    // instant this is the width the screen shows whether or not this paint ever finishes. Recording it
    // at the end hid an interrupted rotation from the repaint guard, which then declined to redraw and
    // left a 796px sheet in a portrait window that only sideways panning could read.
    const seq = turns.current.startPaint(containerW);
    // Not whole again until this draw finishes as the owner, and a sharper drawing under way stops.
    drawnWhole.current = false;
    epoch.current++;
    // A FRESH DRAW IS A FITTED ONE. The list is emptied below and every sheet is drawn at the width
    // of the room, so whatever zoom the last sheets were at is gone with them, and a redraw that was
    // waiting to sharpen them has nothing left to sharpen.
    zoomRef.current = FIT;
    clearTimeout(sharpenSoon.current);
    // Print goes back to disabled for the whole repaint (audit 7: enabling it at page 1 let a fast
    // tap print a money document with blank tail pages, and a repaint has exactly that gap again).
    setAllPainted(false);
    // KEEP HIS PLACE. Redrawing empties the list, so page 5 of an invoice would become page 1 every
    // time the phone turned. The sheets keep their aspect ratio, so the fraction scrolled is the
    // same place at any width — and the fraction is the one REMEMBERED as he scrolled (placeKept
    // above), never one read here, because by the time a turn gets this far the element that held his
    // scroll position has already handed the job to another one and both read 0.
    const was = placeKept.current;
    repainting.current = true;
    try {
      // The sharp sheets and the fitted ones kept behind them give their memory back first: emptying
      // the list only takes them off the page.
      letGoOfSharp(host, bases.current);
      host.innerHTML = "";
      // Whatever a finger had landed on has just gone off the page, so its lift will never reach the
      // box (see fingerDown): the mark is cleared here, or nothing would sharpen until the next touch.
      fingerDown.current = false;
      const dpr = sharpnessFor(pdf.numPages);
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        if (!turns.current.paintOwns(seq)) return;
        const base = page.getViewport({ scale: 1 });
        const scale = containerW / base.width;
        const vp = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        // Derive height from the FLOORED width so the printed aspect ratio matches the PDF
        // exactly. Flooring both independently made the canvas a hair taller than 11in,
        // which chromium then pushed onto a second sheet — a blank sliver after every page.
        const cssW = Math.floor(vp.width);
        const cssH = Math.round((cssW * base.height) / base.width);
        canvas.width = Math.floor(cssW * dpr);
        canvas.height = Math.round((canvas.width * base.height) / base.width);
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
        canvas.className = "pdf-page-canvas mx-auto mb-6 block bg-white shadow-md";
        // WHICH PAGE THIS IS AND THE SIZE IT WAS FITTED AT: what a zoom works every later size out
        // from, and how a sharper drawing of the same page finds the sheet it replaces.
        canvas.dataset.page = String(n);
        canvas.dataset.fitW = String(cssW);
        canvas.dataset.fitH = String(cssH);
        host.appendChild(canvas);
        const ctx = canvas.getContext("2d")!;
        ctx.scale(dpr, dpr);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        // SHOW PAGE 1 THE MOMENT IT EXISTS. Waiting for every canvas made a 6-page doc feel
        // as slow as its last page; the rest keep painting into the already-visible list.
        // Only if this paint still owns the list: page one is rasterized BEFORE the next trip
        // round the loop checks, so a margin change landing in that window had the old document's
        // first sheet declare itself "ready" over the new one's "Opening…".
        if (n === 1 && turns.current.paintOwns(seq)) setState("ready");
      }
      // A margin change or a newer rotation mid-paint owns the screen now, and a superseded paint
      // finishing late must not claim the width back either.
      if (!turns.current.finishedPaint(seq, containerW)) return;
      drawnWhole.current = true;
      setState("ready");
      setAllPainted(true);
      // RESOLVED AGAIN HERE, never the element measured before the awaits above: a turn that landed
      // mid-paint handed the scrolling from the box to the face (or back), and a scrollTop written to
      // the one that is no longer scrolling is silently a no-op — the same silence as the bug above.
      const scroller = theScroller(scrollRef.current);
      if (scroller && was > 0) scroller.scrollTop = was * scroller.scrollHeight;
    } catch (e: any) {
      // A page that won't rasterize is its own failure, not the fetch's — this used to be caught by
      // load()'s handler, which can no longer see it.
      if (!turns.current.paintOwns(seq)) return;
      setError(e?.message ?? "Couldn't draw the pages.");
      setState("error");
    } finally {
      // Only the paint that still owns the list stops the remembering: a superseded one returning late
      // must not start recording a half-drawn list's scroll position as his place.
      if (turns.current.paintOwns(seq)) repainting.current = false;
    }
  }, []);

  /**
   * THE WHOLE DOCUMENT IS ON THE SCREEN AND NOTHING IS BEING FETCHED: the one question everything
   * that zooms or sharpens asks. Not merely "not fetching": while a fresh draw is still filling the
   * list, the sheets are about to be replaced, and a zoom then would resize half a document.
   */
  const ready = useCallback(
    () => drawnWhole.current && !turns.current.isLoading() && !!pagesRef.current?.querySelector("canvas.pdf-page-canvas"),
    [],
  );

  /**
   * DRAW THE SHEETS A PERSON IS LOOKING AT AGAIN, SHARP, AT THE ZOOM THEY ARE SHOWN AT.
   *
   * A zoom only changes the CSS size of the sheets, so straight after a pinch a person is looking at
   * a small bitmap stretched: readable at two times, soft at four, and softer still on a long
   * document, which is drawn at a lower density to begin with. This draws the sheets that are on the
   * screen again at the size they now have, the one being read first, never more than SHARP_MOST.
   *
   * A GUEST, NOT A PAINT TURN. It takes no turn and settles none, and touches neither Print nor the
   * state of the screen: a fresh draw cannot be cancelled by it, and it stops at its next wait once a
   * load, a fresh draw or leaving the screen has moved the epoch, or a newer sharpen has started;
   * the sheet it was drawing then never goes on the screen. Print needs no guard:
   * every page is on the screen at every moment of it, because one sheet is swapped for another in a
   * single step, and every sheet prints the width of the paper whatever size it was drawn at.
   *
   * THE FITTED SHEETS ARE KEPT. The first time a page is drawn sharp, the sheet the fresh draw made is
   * kept in `bases` and the sharp one takes its place in the list. A sharp sheet that has gone out of
   * view, or every one at FIT, gets its fitted sheet back. MEMORY FALLS BEFORE IT RISES: every sheet
   * that is going back is put back and released first, and only then are new ones drawn, one at a
   * time, each releasing the sharp sheet it replaces at once.
   *
   * A sheet is drawn again only for clearly more detail than it has (lib/pdf-zoom, worthSharpening),
   * at the density of a short document, since at most three are sharp however long it is (drawDensity).
   */
  const sharpen = useCallback(async (pdf: PDFDocumentProxy) => {
    const host = pagesRef.current;
    if (!host || !drawnWhole.current || turns.current.isLoading()) return;
    const run = ++sharpenRun.current;
    const ep = epoch.current;
    const gone = () => sharpenRun.current !== run || epoch.current !== ep;
    const kept = bases.current;

    // WHICH PAGES ARE TO BE SHARP: none at FIT; zoomed, the ones on the glass, nearest the one being
    // read first. Page numbers only: no element is held across a wait below.
    const wanted: string[] = [];
    {
      const sheets = sheetsIn(host);
      const scroller = theScroller(scrollRef.current);
      if (zoomRef.current > FIT && scroller) {
        const view = scroller.getBoundingClientRect();
        for (const i of nearestFirst(sheets.length, sheetBeingRead(sheets, scroller))) {
          if (wanted.length >= SHARP_MOST) break;
          const page = sheets[i].dataset.page;
          if (page && onScreen(sheets[i].getBoundingClientRect(), view)) wanted.push(page);
        }
      }
      // PUT BACK FIRST, so memory falls before it rises.
      for (const sharp of sheets) {
        const page = sharp.dataset.page;
        if (!page || sharp.dataset.sharp !== "1" || wanted.includes(page)) continue;
        const base = kept.get(page);
        if (!base) continue;
        const size = zoomedSize(fittedSizeOf(base), zoomRef.current);
        base.style.width = `${size.width}px`;
        base.style.height = `${size.height}px`;
        if (sharp.parentNode === host) host.replaceChild(base, sharp);
        release(sharp);
        kept.delete(page);
      }
    }

    const dpr = sharpnessFor(1);
    let drawing: HTMLCanvasElement | null = null;
    try {
      for (const n of wanted) {
        const sheet = sheetFor(host, n);
        if (!sheet) continue;
        const fitted = fittedSizeOf(sheet);
        if (!(fitted.width > 0)) continue;
        const size = zoomedSize(fitted, zoomRef.current);
        const density = drawDensity(size.width, dpr);
        const across = Math.floor(size.width * density);
        if (!worthSharpening(sheet.width, across)) continue;
        const page = await pdf.getPage(Number(n));
        if (gone()) return;
        const base = page.getViewport({ scale: 1 });
        const canvas = document.createElement("canvas");
        drawing = canvas;
        // The same rule as a fresh draw: the height from the floored width, so the sheet is the
        // paper's shape exactly and a printed page never grows a sliver of a second one.
        canvas.width = across;
        canvas.height = Math.round((across * base.height) / base.width);
        canvas.className = sheet.className;
        canvas.dataset.page = n;
        canvas.dataset.fitW = sheet.dataset.fitW;
        canvas.dataset.fitH = sheet.dataset.fitH;
        canvas.dataset.sharp = "1";
        const ctx = canvas.getContext("2d");
        // No context is a canvas the device would not give: the sheet that is there stays.
        if (!ctx) {
          release(canvas);
          drawing = null;
          continue;
        }
        ctx.scale(density, density);
        await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: size.width / base.width }) }).promise;
        if (gone()) return;
        // FOUND AGAIN after the wait: a newer sheet may stand there, or none.
        const there = sheetFor(host, n);
        if (!there) {
          release(canvas);
          drawing = null;
          continue;
        }
        // THE SIZE THE SCREEN SHOWS NOW, not the one this drawing was started for: a pinch that went
        // on while the page was being drawn has already resized the sheet this one replaces.
        const now = zoomedSize(fitted, zoomRef.current);
        canvas.style.width = `${now.width}px`;
        canvas.style.height = `${now.height}px`;
        host.replaceChild(canvas, there);
        drawing = null;
        // A fitted sheet is kept to put back; a sharp one replaced by a sharper one is released now.
        if (there.dataset.sharp === "1") release(there);
        else kept.set(n, there);
      }
    } catch {
      // A page that will not draw sharper is not an error anybody can act on: every sheet is still on
      // the screen, as sharp as it was. Nothing is reported.
    } finally {
      // Whatever was being drawn and never went on the screen gives its memory back.
      release(drawing);
    }
  }, []);

  /**
   * ASK FOR A SHARPER DRAWING once things have been still for a moment: after a gesture, and after a
   * scroll while zoomed, so the sharp sheets follow a person down the document and the ones left
   * behind give their memory back. It does nothing while a finger is on the sheets or the document is
   * not whole on the screen.
   */
  const sharpenSoonAfter = useCallback(() => {
    clearTimeout(sharpenSoon.current);
    sharpenSoon.current = setTimeout(() => {
      const pdf = pdfRef.current;
      if (!pdf || fingerDown.current || !ready()) return;
      void sharpen(pdf);
    }, 220);
  }, [ready, sharpen]);

  // ── PINCH, DOUBLE TAP, CTRL + WHEEL ─────────────────────────────────────────────────────────────
  // Read here because nothing else will: the phone app's shell has the web view's own pinch turned
  // off for every screen (lib/pdf-zoom has the whole reason). The listeners sit on the box, which is
  // there for the life of the screen, and resolve the sheets, the scroller and the way the phone is
  // held at the moment of each gesture: a turn of the phone swaps the scroller underneath them, and
  // a sharper drawing swaps a sheet. WHAT a touch means is lib/pdf-zoom's gestureStep(), pure and
  // tested there; this only carries out the act it answers with.
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    /** A place on one page: the thing a gesture holds on to. The page by NUMBER, never the element,
     *  and the epoch it was taken in, because a fresh draw makes it a place on sheets that are gone. */
    type Hold = { page: string; place: Point; epoch: number };
    let gesture: GestureState = NO_GESTURE;
    let hold: Hold | null = null;
    /** The newest thing a pinch asked for, drawn once a frame however many moves arrive in it. */
    let asked: { zoom: number; fingers: Point } | null = null;
    let frame = 0;
    /** When a finger last touched, so the double click a browser makes up after a double tap is not read twice. */
    let touchedAt = 0;

    const at = (t: { clientX: number; clientY: number }): Point => ({ x: t.clientX, y: t.clientY });
    const points = (list: TouchList): Point[] => Array.from(list, at);
    const room = () => turns.current.drawnAtW();

    /** The page under a point of the glass (or the nearest one), and the place on it. */
    const holdAt = (p: Point): Hold | null => {
      let best: HTMLCanvasElement | null = null;
      let bestGap = Infinity;
      for (const sheet of sheetsIn(pagesRef.current)) {
        const r = sheet.getBoundingClientRect();
        const gapX = Math.max(r.left - p.x, 0, p.x - r.right);
        const gapY = Math.max(r.top - p.y, 0, p.y - r.bottom);
        const gap = Math.hypot(gapX, gapY);
        if (gap < bestGap) {
          best = sheet;
          bestGap = gap;
        }
      }
      if (!best || !best.dataset.page) return null;
      return { page: best.dataset.page, place: placeOnSheet(p, best.getBoundingClientRect(), heldNow(box)), epoch: epoch.current };
    };

    /** Show the sheets at a zoom, with the held place under the fingers. Only on a whole document. */
    const show = (zoom: number, hold: Hold, fingers: Point) => {
      if (!ready() || hold.epoch !== epoch.current) return;
      const sheets = sheetsIn(pagesRef.current);
      for (const sheet of sheets) {
        const size = zoomedSize(fittedSizeOf(sheet), zoom);
        if (!(size.width > 0)) continue;
        sheet.style.width = `${size.width}px`;
        sheet.style.height = `${size.height}px`;
      }
      zoomRef.current = zoom;
      const held = sheets.find((s) => s.dataset.page === hold.page);
      const scroller = theScroller(box);
      if (!held || !scroller) return;
      const move = scrollToKeep({ place: hold.place, sheetNow: held.getBoundingClientRect(), fingers, held: heldNow(box) });
      scroller.scrollLeft += move.dx;
      scroller.scrollTop += move.dy;
    };

    /** The pinch is over, either way: no frame left to draw, nothing held. */
    const letGo = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      hold = null;
      asked = null;
    };

    const toggleAt = (p: Point) => {
      if (!ready()) return;
      const h = holdAt(p);
      if (!h) return;
      show(zoomAfterDoubleTap(zoomRef.current, room()), h, p);
      sharpenSoonAfter();
    };

    /** Carry out what the gesture rule answered. `e` is the event to refuse the browser, if any. */
    const carryOut = (act: GestureAct, e: Event | null) => {
      if (!act) return;
      if (act.kind === "hold") {
        hold = holdAt(act.at);
        asked = null;
        return;
      }
      if (act.kind === "show") {
        // Nothing held is nothing to zoom, and then the move is not ours to refuse either.
        if (!hold) return;
        // TWO FINGERS ON THE SHEETS ARE OURS. Without this the scroller drags the page about under the
        // pinch, and a browser that still has its own pinch zooms the whole window as well.
        e?.preventDefault();
        asked = { zoom: act.zoom, fingers: act.fingers };
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (hold && asked) show(asked.zoom, hold, asked.fingers);
        });
        return;
      }
      if (act.kind === "finish") {
        // The last thing the fingers asked for is drawn NOW rather than left to a frame that a lifted
        // finger may never get.
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        if (hold && asked) show(asked.zoom, hold, asked.fingers);
        letGo();
        sharpenSoonAfter();
        return;
      }
      if (act.kind === "drop") {
        letGo();
        return;
      }
      toggleAt(act.at);
    };

    const step = (ev: GestureEvent, e: Event | null) => {
      const next = gestureStep(gesture, ev);
      gesture = next.state;
      carryOut(next.act, e);
    };

    const onTouchStart = (e: TouchEvent) => {
      touchedAt = Date.now();
      // NO SHEET IS SWAPPED UNDER A FINGER (fingerDown has the reason). The sharper drawing under way
      // stops at its next wait, having swapped nothing since this finger landed, and none starts
      // until the last finger is up.
      fingerDown.current = true;
      sharpenRun.current++;
      step({ kind: "start", touches: points(e.touches), at: e.timeStamp, ready: ready(), zoom: zoomRef.current }, null);
    };

    const onTouchMove = (e: TouchEvent) => {
      step({ kind: "move", touches: points(e.touches), ready: ready(), cancelable: e.cancelable, room: room() }, e);
    };

    /** After a lift: `still` are the fingers left on the glass. Once it is clear, the sharper drawing
     *  the touch stopped is asked for again, while anything is zoomed or any sharp sheet is left. */
    const afterLift = (still: Point[]) => {
      fingerDown.current = still.length > 0;
      if (!fingerDown.current && (zoomRef.current > FIT || bases.current.size > 0)) sharpenSoonAfter();
    };

    const onTouchEnd = (e: TouchEvent) => {
      touchedAt = Date.now();
      const still = points(e.touches);
      const lifted = e.changedTouches[0];
      step({ kind: "end", touches: still, lifted: lifted ? at(lifted) : null, at: e.timeStamp, ready: ready() }, null);
      afterLift(still);
    };

    const onTouchCancel = (e: TouchEvent) => {
      step({ kind: "cancel" }, null);
      afterLift(points(e.touches));
    };

    const onWheel = (e: WheelEvent) => {
      // A trackpad pinch reaches a page as a wheel with ctrl held, and so does ctrl + scroll. A plain
      // wheel is the scroller's.
      if (!e.ctrlKey || !ready()) return;
      const p = at(e);
      const h = holdAt(p);
      if (!h) return;
      // Or the browser zooms the whole window, toolbar and all, which is the thing this replaces.
      e.preventDefault();
      show(zoomAfterWheel(zoomRef.current, e.deltaY, room(), e.deltaMode === 1), h, p);
      sharpenSoonAfter();
    };

    const onDoubleClick = (e: MouseEvent) => {
      // A mouse's double click. A finger's double tap was read above, and the double click some
      // browsers make up after it would undo it.
      if (!mouseDoubleClickCounts(Date.now(), touchedAt)) return;
      toggleAt(at(e));
    };

    box.addEventListener("touchstart", onTouchStart, { passive: true });
    box.addEventListener("touchmove", onTouchMove, { passive: false });
    box.addEventListener("touchend", onTouchEnd);
    box.addEventListener("touchcancel", onTouchCancel);
    box.addEventListener("wheel", onWheel, { passive: false });
    box.addEventListener("dblclick", onDoubleClick);
    return () => {
      letGo();
      box.removeEventListener("touchstart", onTouchStart);
      box.removeEventListener("touchmove", onTouchMove);
      box.removeEventListener("touchend", onTouchEnd);
      box.removeEventListener("touchcancel", onTouchCancel);
      box.removeEventListener("wheel", onWheel);
      box.removeEventListener("dblclick", onDoubleClick);
    };
  }, [ready, sharpenSoonAfter]);

  // ── WHERE HE IS, WRITTEN DOWN AS HE SCROLLS ────────────────────────────────────────────────────
  // CAPTURE, on the box, so it sees whichever element is actually scrolling: the box itself upright, the
  // quarter-turned face inside it once the phone is turned. A `scroll` event does not bubble, but a
  // capturing listener on an ancestor is still called for it. Nothing is recorded while a repaint is
  // emptying the list, because the scroll to 0 that causes is not a place anybody chose.
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const remember = (e: Event) => {
      if (repainting.current) return;
      // Zoomed, the sharp sheets follow him down the document once he stops, and the ones he left
      // behind give their memory back. At FIT there is nothing sharp to move.
      if (zoomRef.current > FIT) sharpenSoonAfter();
      const el = e.target as HTMLElement | null;
      if (!el || !(el instanceof HTMLElement)) return;
      if (el.scrollHeight <= el.clientHeight) return;
      placeKept.current = el.scrollTop / el.scrollHeight;
    };
    box.addEventListener("scroll", remember, true);
    return () => box.removeEventListener("scroll", remember, true);
  }, [sharpenSoonAfter]);

  const load = useCallback(async () => {
    // A LOAD TURN outranks everything: the document on screen is about to be replaced, so a repaint of
    // it is cancelled too — and until this one has the bytes in hand, nothing else may repaint at all.
    const seq = turns.current.startLoad();
    drawnWhole.current = false;
    epoch.current++;
    setState("loading");
    setAllPainted(false);
    setError("");
    try {
      const res = await fetch(`/api/pdf/${doc}/${id}?m=${m}`, { credentials: "same-origin" });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error ?? `Couldn't build the PDF (${res.status}).`);
      }
      const cd = res.headers.get("content-disposition") ?? "";
      // The UTF-8 name first (RFC 5987, lib/content-disposition), the ASCII fallback second.
      const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1];
      let fn = /filename="([^"]+)"/.exec(cd)?.[1];
      try {
        if (utf8) fn = decodeURIComponent(utf8);
      } catch {
        /* a malformed escape keeps the ASCII name */
      }
      const buf = await res.arrayBuffer();
      if (!turns.current.loadOwns(seq)) return; // a newer request superseded this one

      // Keep the raw bytes for Download/Print — the preview and the file can't diverge.
      const url = URL.createObjectURL(new Blob([buf], { type: "application/pdf" }));
      setBlobUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return url;
      });
      if (fn) setFilename(fn);

      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      const pdf = await pdfjs.getDocument({ data: buf }).promise;
      if (!turns.current.loadOwns(seq)) {
        void pdf.destroy();
        return;
      }
      // Adopt this document and let the previous one go — a margin change loads a second copy, and a
      // parsed PDF held for nothing is the same leak the blob above is revoked for.
      const previous = pdfRef.current;
      pdfRef.current = pdf;
      if (previous) void previous.destroy();
      // THE FETCH IS DONE, so rotations may repaint again — and the width below is measured right now,
      // which is why a turn of the phone during the fetch needed no repaint of its own.
      turns.current.settled(seq);
      await paint(pdf, roomForAPage());
    } catch (e: any) {
      if (!turns.current.loadOwns(seq)) return;
      turns.current.settled(seq);
      setError(e?.message ?? "Couldn't build the PDF.");
      setState("error");
    }
  }, [doc, id, m, paint, roomForAPage]);

  useEffect(() => {
    load();
    // No disable directive here any more: the dependency list is honest ([load], and `load` is a
    // useCallback over everything it reads), so the suppression it used to carry was reporting nothing
    // and lint called it out as dead. A silenced rule nobody needs is the one that hides the next
    // real warning in this file.
  }, [load]);

  // ── DRAW THEM AGAIN WHEN THE ROOM CHANGES ──────────────────────────────────────────────────────
  // Turning the phone is the whole point, and a bitmap does not re-flow. WIDTH ONLY: the keyboard and
  // a browser's own chrome change the HEIGHT, and nothing about a page's size depends on that, so
  // reading a document is never interrupted by a repaint it didn't need. A rotation fires `resize` on
  // iOS; `orientationchange` is the belt for the browsers that only fire that one.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const maybeRepaint = () => {
      clearTimeout(t);
      // Late enough that iOS has settled on the new size — asked mid-rotation it reports the old one.
      t = setTimeout(() => {
        const pdf = pdfRef.current;
        // DEFER, DON'T FIGHT. While a fetch is in flight, pdfRef still holds the document being
        // replaced — repainting it here outranked the fetch and the margin he tapped never landed.
        // Nothing is lost by waiting: load() ends in paint(pdf, roomForAPage()), which measures the
        // room at that moment, so the new orientation is drawn anyway.
        if (!pdf || turns.current.isLoading()) return;
        const want = roomForAPage();
        if (!worthRedrawing(want, turns.current.drawnAtW())) return;
        void paint(pdf, want);
      }, 180);
    };
    window.addEventListener("resize", maybeRepaint);
    window.addEventListener("orientationchange", maybeRepaint);
    // AND THE ONE THAT ACTUALLY FIRES IN THE APP NOW. The shell is portrait-locked, so when the phone
    // is turned the WINDOW never changes shape — neither `resize` nor `orientationchange` happens, and
    // without this a document would stay drawn at the portrait width inside a box twice as wide, which
    // is strictly worse than not turning at all. components/turns-sideways.tsx fires it the moment the
    // turn is decided; the two above stay for a browser, where the window really does change.
    window.addEventListener("cn:screen-turned", maybeRepaint);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", maybeRepaint);
      window.removeEventListener("orientationchange", maybeRepaint);
      window.removeEventListener("cn:screen-turned", maybeRepaint);
    };
  }, [paint, roomForAPage]);

  // Release the blob (and the retained page bitmaps) when the viewer goes away — a
  // multi-megabyte PDF held by an object URL survives navigation otherwise.
  const pagesHost = pagesRef;
  const turnsOnLeaving = turns.current;
  useEffect(() => {
    const host = pagesHost.current;
    const keptOnLeaving = bases.current;
    // The counter itself moves on leaving, never a number read from it now: that is the whole point.
    const moveTheEpochOnLeaving = () => {
      epoch.current++;
    };
    return () => {
      // Abort any in-flight fetch/paint loop (audit 7): tapping Back mid-load still rasterized
      // every page into detached canvases and leaked the multi-MB blob on the page you fled to.
      turnsOnLeaving.abandonAll();
      // …and the sharper drawing a last pinch left waiting, which would otherwise wake on the page
      // he fled to and find nothing to draw, and the one under way, which stops at its next wait.
      clearTimeout(sharpenSoon.current);
      drawnWhole.current = false;
      moveTheEpochOnLeaving();
      letGoOfSharp(host, keptOnLeaving);
      setBlobUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      });
      // The parsed document is kept across rotations now, so leaving has to let go of it too —
      // destroy() also shuts down its pdf.js worker.
      const pdf = pdfRef.current;
      pdfRef.current = null;
      if (pdf) void pdf.destroy();
      if (host) host.innerHTML = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function printPdf() {
    // Print THIS window's rendered pages (print CSS lays them one per sheet, and the
    // canvases already contain the margins baked into the PDF). window.open() is a trap
    // in the installed app: the popup belongs to Safari — a different application — so
    // the print dialog appeared BEHIND the app window (Erik 7/24).
    window.print();
  }

  // `back` arrives from the query string: only an in-app PATH may be followed (the guard lives in
  // pdfPreviewBackHref). Without one, Back goes to the document's own page, never to "/".
  const safeBack = pdfPreviewBackHref(doc, id, back);

  // GO BACK, don't push forward — via the house detector, not document.referrer (audit 7:
  // client-side navigation never sets referrer, so the cn-v730 heuristic was DEAD in the
  // installed PWA — the exact environment Erik reported the loop from). BackLinkTracker in the
  // root layout already tracks in-app navigation for every route including /print/*; BackLink
  // unwinds history when the arrival was in-app and falls back to the href on a cold open.
  //
  // THE TOOLBAR CLEARS THE STATUS BAR (be3dca81). /print sits outside the app shell, so when the
  // iOS shell went full-bleed (cn-v917) this toolbar was left starting at y=0, and Back, the only
  // way off this page (no dock, no topbar, no swipe-back in the shell), was drawn under the clock
  // where a tap can't reach it. Erik had to kill the app. --sat is 0 in a browser and the PWA, so
  // only the shell moves. Back is a full 44px target, and the controls on the right wrap onto
  // their own row at phone width instead of running off the edge.
  return (
    <div className="pdf-preview-root flex h-screen flex-col bg-slate-200">
      {/* `pdf-preview-bar`: the same bar, sideways too. A phone held sideways puts the camera cutout
          on the SIDE — iOS reports ~59pt of inset on both — and this page paints edge to edge with no
          app shell around it, so globals.css pads Back and the Download button clear of it. Nothing
          moves otherwise, nothing is dropped, every control stays 44px. */}
      <div className="pdf-preview-bar no-print flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-slate-300 bg-white px-4 pb-2.5 pt-[max(0.625rem,var(--sat,0px))]">
        <BackLink
          fallback={safeBack}
          fallbackLabel="Back"
          className="-ml-2 inline-flex min-h-11 min-w-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-slate-600 hover:text-slate-900"
        />
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="pdf-margin" className="text-xs font-medium text-slate-500">Margins</label>
          <select
            id="pdf-margin"
            value={m}
            onChange={(e) => setM(Number(e.target.value))}
            disabled={state === "loading"}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm disabled:opacity-50"
          >
            {MARGINS.map((o) => (
              <option key={o.v} value={o.v}>{o.label}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={printPdf}
            disabled={state !== "ready" || !allPainted}
            title={state === "ready" && !allPainted ? "Preparing pages…" : undefined}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 disabled:opacity-50"
          >
            <Printer className="h-4 w-4" /> Print
          </button>
          <a
            href={blobUrl ?? "#"}
            download={filename}
            aria-disabled={state !== "ready"}
            className={`inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white ${state !== "ready" ? "pointer-events-none opacity-50" : ""}`}
          >
            <Download className="h-4 w-4" /> Download PDF
          </a>
        </div>
      </div>

      {/* `turn-host`: the bar above stays exactly where it is — the phone's top edge — and THIS is the
          rectangle the page turns inside when the phone is held sideways (Erik, 2026-10-01). Upright,
          <Turned> has no box at all and this is the same scroller it has always been. `region="the
          route"`: this screen IS the declared route, so it draws the turn — unless a full-screen layer
          opens over it, which owns the turn itself and draws its own. */}
      <div ref={scrollRef} className="pdf-pages-scroll turn-host min-h-0 flex-1 overflow-y-auto px-2 py-6">
       <Turned region="the route">
        {/* THE ONE THING THAT CAN ALWAYS BE MEASURED. The pages host below is display:none while
            loading (clientWidth 0 → a page drawn into a negative-width canvas: Erik's blank sheets),
            and window.innerWidth doesn't know about the camera inset this scroller is padded for. This
            sits inside the padding, draws nothing, and is exactly the room a page has — including when
            that room is the turned box, which is twice as wide. */}
        <div ref={measureRef} aria-hidden="true" className="h-0" />
        {state === "loading" && (
          <div className="flex flex-col items-center gap-3 py-24 text-slate-500">
            <Loader2 className="h-8 w-8 animate-spin" />
            {/* HONEST THEATER (Erik: "pdf still seems to be regenerating every time" — the log
                said HIT, 0.9s; this screen said "Building… takes a few seconds" either way, so a
                stored copy LOOKED like a rebuild). Neutral line first; the slow-warning only
                appears once it's actually being slow. */}
            <p className="text-sm font-medium">Opening…</p>
            <p className="pdf-slow-note text-xs text-slate-400">Rebuilding this one — a few seconds.</p>
          </div>
        )}
        {state === "error" && (
          <div className="mx-auto max-w-md rounded-xl border border-red-200 bg-red-50 p-6 text-center">
            <p className="text-sm font-medium text-red-700">{error}</p>
            <button type="button" onClick={load} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700">
              <RefreshCw className="h-4 w-4" /> Try Again
            </button>
          </div>
        )}
        <div ref={pagesRef} className={state === "ready" ? "" : "hidden"} />
       </Turned>
      </div>
    </div>
  );
}
