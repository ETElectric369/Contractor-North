"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label } from "@/components/ui/input";
import { useToast } from "@/components/toast";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";
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
  const t = translator(useLang());
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save() {
    if (!title.trim()) {
      setError(t("jb_sayWhatNeedsDoing"));
      return;
    }
    setError(null);
    start(async () => {
      const res = await createTask({ title, job_id: jobId, photo_path: photoPath });
      if (!res.ok) {
        setError(res.error ?? t("jb_couldntAddTask"));
        return;
      }
      // A same-words task was already open: nothing new was made, so the photo isn't on that task.
      if (res.duplicate)
        toast(`${res.speak ?? t("jb_alreadyOnList")} ${t("jb_photoNotOnThatTask")}`, "info", undefined, { sticky: true });
      else if (res.photoSkipped)
        toast(t("jb_taskAddedPhotoSkipped"), "info", undefined, { sticky: true });
      else toast(t("jb_addedToTasks"), "success");
      onClose();
      router.refresh();
    });
  }

  return (
    <Modal
      open
      portal
      onClose={onClose}
      title={t("jb_makeItATask")}
      size="sm"
      dirty={!!title.trim()}
      footer={<ModalActions onCancel={onClose} onSave={save} saving={pending} saveLabel={t("jb_addTask")} disabled={!title.trim()} />}
    >
      <div className="space-y-3">
        {previewUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- a local object URL, not a remote image
          <img src={previewUrl} alt={t("jb_photoYouJustTook")} className="max-h-48 w-full rounded-lg object-cover" />
        )}
        {/* Said, not assumed: Cancel keeps the photo, it just doesn't become a task. */}
        <p className="text-xs text-slate-500">{t("jb_photoOnTabEitherWay")}</p>
        <div>
          <Label htmlFor="photo-task-title">{t("jb_whatNeedsDoingQ")}</Label>
          <Input
            id="photo-task-title"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            placeholder={t("jb_whatNeedsDoingHere")}
            className="h-11"
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}
