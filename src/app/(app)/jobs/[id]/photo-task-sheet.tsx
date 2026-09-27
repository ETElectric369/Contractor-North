"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label } from "@/components/ui/input";
import { useToast } from "@/components/toast";
import { createTask } from "../../tasks/actions";

/**
 * MAKE IT A TASK: a photo just taken on the job becomes a task on the spot (Erik, 2026-09-26: "i like
 * the idea that a photo can become a task on the spot"). The photo is already a job photo (it went
 * through uploadJobPhotos, so it is on the Photos tab either way); this asks "What needs doing?" and
 * puts the task on the job's list with the photo on it. Cancel leaves the photo where it is.
 *
 * Portaled: the dock's Photo button lives inside a glass (backdrop-filter) bar, which would trap a
 * fixed overlay (the Modal's own note).
 */
export function PhotoTaskSheet({
  jobId,
  photoPath,
  previewUrl,
  onClose,
}: {
  jobId: string;
  photoPath: string;
  /** A local preview of the photo (an object URL), so he sees what he is describing. */
  previewUrl?: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save() {
    if (!title.trim()) {
      setError("Say what needs doing.");
      return;
    }
    setError(null);
    start(async () => {
      const res = await createTask({ title, job_id: jobId, photo_path: photoPath });
      if (!res.ok) {
        setError(res.error ?? "Couldn't add the task. Try again.");
        return;
      }
      // A same-words task was already open: nothing new was made, so the photo isn't on that task.
      if (res.duplicate)
        toast(`${res.speak ?? "Already on the list."} The photo is on the Photos tab, not on that task.`, "info", undefined, { sticky: true });
      else if (res.photoSkipped)
        toast("Task added. The photo is on the Photos tab: photos on tasks start after the next database update.", "info", undefined, { sticky: true });
      else toast("Added to this job's Tasks", "success");
      onClose();
      router.refresh();
    });
  }

  return (
    <Modal
      open
      portal
      onClose={onClose}
      title="Make It A Task"
      size="sm"
      dirty={!!title.trim()}
      footer={<ModalActions onCancel={onClose} onSave={save} saving={pending} saveLabel="Add Task" disabled={!title.trim()} />}
    >
      <div className="space-y-3">
        {previewUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- a local object URL, not a remote image
          <img src={previewUrl} alt="The photo you just took" className="max-h-48 w-full rounded-lg object-cover" />
        )}
        {/* Said, not assumed: Cancel keeps the photo, it just doesn't become a task. */}
        <p className="text-xs text-slate-500">This photo is on the job&rsquo;s Photos tab either way.</p>
        <div>
          <Label htmlFor="photo-task-title">What needs doing?</Label>
          <Input
            id="photo-task-title"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            placeholder="e.g. Replace this breaker"
            className="h-11"
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}
