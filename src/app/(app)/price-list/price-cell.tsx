"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { UNIT_SUGGESTIONS } from "@/lib/pricing/units";

/**
 * A CLICK-TO-EDIT CELL. Click (or focus + Enter) opens an input seeded with `value`; Enter or
 * blur commits IF it changed; Escape puts it back. Up/Down nudge a number by `step` (Shift ×10).
 * No Save button — a single cell's save game is the toast's Undo (see price-list-manager).
 *
 * It renders the DISPLAY, not the value: sell shows "$51.30" but edits as "51.30"; MU% shows
 * "35% default" but edits as "35". The parent owns the arithmetic (price-list-math.ts).
 */
export function PriceCell({
  value,
  display,
  onCommit,
  kind = "text",
  list,
  disabled = false,
  saving = false,
  title,
  className = "",
  align = "right",
  step = 1,
}: {
  /** The text the input opens with. */
  value: string;
  /** What the cell shows when not editing. */
  display: ReactNode;
  /** Called with the raw typed text on Enter/blur when it differs from `value`. */
  onCommit: (raw: string) => void | Promise<void>;
  /** "unit" edits as a DROPDOWN of the shared vocabulary (plus the current value if it is custom). */
  kind?: "money" | "pct" | "text" | "unit";
  /** A <datalist> id (the unit vocabulary). */
  list?: string;
  disabled?: boolean;
  /** A write is in flight — the cell dims and refuses a second edit until it lands. */
  saving?: boolean;
  title?: string;
  className?: string;
  align?: "right" | "left";
  /** Arrow-key nudge for numeric kinds. */
  step?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  // ONE commit per edit. Enter commits and unmounts the input, and the blur that follows would
  // commit AGAIN (two writes, two toasts); Escape cancels and the same blur would commit anyway.
  const done = useRef(false);

  useEffect(() => {
    if (!editing) setText(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function open() {
    if (disabled || saving) return;
    done.current = false;
    setText(value);
    setEditing(true);
  }

  function commit() {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const next = text.trim();
    if (next === value.trim()) return;
    void onCommit(next);
  }

  function cancel() {
    done.current = true;
    setText(value);
    setEditing(false);
  }

  function nudge(dir: 1 | -1, big: boolean) {
    if (kind === "text") return;
    const n = Number(String(text).replace(/[$,%\s]/g, ""));
    if (!Number.isFinite(n)) return;
    const delta = step * (big ? 10 : 1) * dir;
    const next = Math.round((n + delta) * 100) / 100;
    setText(String(next));
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); nudge(1, e.shiftKey); }
    else if (e.key === "ArrowDown") { e.preventDefault(); nudge(-1, e.shiftKey); }
    else if (e.key === "Tab") { commit(); }
  }

  const alignCls = align === "right" ? "text-right" : "text-left";

  if (editing && kind === "unit") {
    const opts = (UNIT_SUGGESTIONS as readonly string[]).includes(text) ? [...UNIT_SUGGESTIONS] : [text, ...UNIT_SUGGESTIONS];
    return (
      <select
        autoFocus
        value={text}
        aria-label={title}
        onChange={(e) => {
          setText(e.target.value);
          // A dropdown pick IS the decision — commit on change, no Enter needed.
          if (done.current) return;
          done.current = true;
          setEditing(false);
          if (e.target.value !== value.trim()) void onCommit(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); cancel(); } }}
        className={`h-8 w-full min-w-[4.5rem] rounded-md border border-brand bg-white px-1 text-sm text-slate-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-brand ${className}`}
      >
        {opts.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
      </select>
    );
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={text}
        list={kind === "text" ? list : undefined}
        inputMode={kind === "text" ? undefined : "decimal"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onBlur={commit}
        aria-label={title}
        className={`h-8 w-full min-w-[4.5rem] rounded-md border border-brand bg-white px-2 text-sm text-slate-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-brand ${alignCls} ${className}`}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
      disabled={disabled}
      title={disabled ? undefined : title ?? "Click to edit"}
      className={`group/cell -mx-2 block h-8 w-[calc(100%+1rem)] rounded-md border border-transparent px-2 text-sm leading-8 hover:border-slate-200 hover:bg-slate-50 focus:outline-none focus-visible:border-brand disabled:cursor-default disabled:hover:border-transparent disabled:hover:bg-transparent ${
        saving ? "opacity-50" : ""
      } ${alignCls} ${className}`}
    >
      {display}
    </button>
  );
}
