"use client";

import { useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Modal } from "@/components/ui/modal";

/**
 * THE ROW GRAMMAR of a ⋯ sheet: one full-width 44px row per verb, and every row says exactly what it
 * does. Buttons, links and the triggers of a nested sheet (MoveToDay, Edit Details) all wear it.
 */
export const SHEET_ROW =
  "flex min-h-[44px] w-full items-center rounded-lg border border-slate-200 bg-white px-4 text-left text-sm font-medium text-slate-700 hover:border-brand hover:text-brand disabled:opacity-50";

/** The 44px ⋯ that opens a row's sheet. */
export const ROW_MORE_TRIGGER =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700";

/** What a sheet's rows get: `close` for the row whose verb landed (a pick, a save, a done). */
export interface RowMoreSheetApi {
  close: () => void;
}

/**
 * The sheet as it looks when open. No state: RowMoreSheet owns it, and tests read this one.
 * The rows are the caller's children, under the row's title and a subline.
 */
export function RowMoreSheetView({
  open,
  title,
  subline,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  subline?: string | null;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm">
      <div className="space-y-2">
        {subline && <p className="text-xs text-slate-400">{subline}</p>}
        {children}
      </div>
    </Modal>
  );
}

/**
 * THE APP'S ONE ROW ⋯ (My Day's agenda rows first; every Needs You row next). A 44px ⋯ opens a small
 * sheet titled with the row, its verbs as SHEET_ROW rows.
 *
 * A row can open a sheet of its own above this one (Move To Another Day…, Edit Details…). This sheet
 * STAYS MOUNTED under it the whole time: the child renders inside it, after it in the tree, so it
 * stacks above it at the same z-index, and a Back, an Escape or the child's Cancel closes the child
 * only (the Modal's overlay stack). The sheet closes when a row says its verb landed (`close`), or
 * when the person closes it; never because a child opened, since unmounting it mid-edit would lose a
 * half-filled form.
 *
 * `children` is the rows, or a function of `{ close }` for rows that close the sheet on success.
 */
export function RowMoreSheet({
  title,
  subline = null,
  onClose,
  children,
}: {
  /** The row's title: the sheet's heading, and the trigger's "More For <title>". */
  title: string;
  /** One quiet line under the heading (when, where). */
  subline?: string | null;
  /** Told whenever the sheet closes, however it closed. */
  onClose?: () => void;
  children: ReactNode | ((sheet: RowMoreSheetApi) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={`More For ${title}`} title="More" className={ROW_MORE_TRIGGER}>
        <MoreHorizontal className="h-4 w-4" />
      </button>
      <RowMoreSheetView open={open} title={title} subline={subline} onClose={close}>
        {typeof children === "function" ? children({ close }) : children}
      </RowMoreSheetView>
    </>
  );
}
