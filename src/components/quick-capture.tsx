"use client";

import { useEffect, useRef, useState } from "react";
import { Zap } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { executeAction } from "@/lib/actions/execute";
import { useToast } from "@/components/toast";

/**
 * The one-field front door (fragment-first): type ANYTHING — a name, a job, a
 * half-thought — and Enter saves it as-is into the review inbox (capture.quick →
 * organized_items needs_review → the Needs-action inbox). No fields to fill, no
 * AI in the path, nothing to classify up front: the raw save is instant and the
 * sheet STAYS OPEN for the next thought, so a run of fragments is Enter-Enter-
 * Enter. Sorting happens later, where triage already lives (Organize My).
 */
export function QuickCaptureSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [captured, setCaptured] = useState(0); // fragments saved this open
  const inputRef = useRef<HTMLInputElement>(null);

  // A fresh open starts clean (matches the Modal discard convention).
  useEffect(() => {
    if (open) {
      setText("");
      setCaptured(0);
    }
  }, [open]);

  async function save() {
    const clean = text.trim();
    if (!clean || saving) return;
    setSaving(true);
    const res = await executeAction("capture.quick", { text: clean }, { source: "ui" });
    setSaving(false);
    if (res.ok) {
      toast("Captured — it's in your inbox", "success");
      setText(""); // stays open, cleared, for the next fragment
      setCaptured((n) => n + 1);
      inputRef.current?.focus();
    } else {
      toast(res.error ?? "Couldn't capture that.", "error");
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Capture anything"
      size="md"
      dirty={text.trim().length > 0}
      footer={
        <ModalActions
          onCancel={onClose}
          cancelLabel="Done"
          saveLabel="Capture"
          saving={saving}
          disabled={!text.trim()}
          submit
          formId="quick-capture-form"
        />
      }
    >
      <form
        id="quick-capture-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Input
          ref={inputRef}
          autoFocus
          enterKeyHint="send"
          maxLength={2000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type anything — a name, a job, a thought…"
          aria-label="Capture anything"
        />
        <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
          <Zap className="h-3.5 w-3.5 shrink-0" />
          {captured > 0
            ? `${captured} captured — keep going, or tap outside to close.`
            : "Enter saves it straight to your inbox — sort it out later."}
        </p>
      </form>
    </Modal>
  );
}
