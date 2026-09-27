"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Camera, ChevronDown, Loader2, Plus } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { MediaLightbox } from "@/components/media-lightbox";
import { useToast } from "@/components/toast";
import { canDeleteTask, doneWords, splitJobTasks, tasksHeader, type JobTaskRow, type TaskPhoto } from "@/lib/job-tasks";
import { createTask, deleteTask, setTaskDonePhoto, toggleTask, updateTask, type ToggleTaskResult } from "../../tasks/actions";
import { uploadJobPhotos } from "./upload-job-photos";
import { PhotoTaskSheet } from "./photo-task-sheet";

/** A task's two photos, already signed on the server (lib/job-tasks taskPhoto). */
export type TaskPhotos = Record<string, { task: TaskPhoto; done: TaskPhoto }>;

/**
 * THE JOB'S ONE TASK LIST (0358). Erik: tasks "embed with the job so if multiple people are on the job
 * a crew leader can assign them verbally". No assignee, no due date, no priority: a title, a checkbox,
 * maybe a photo. Everyone on the job sees the same list and checks things off; the server records who
 * and when. Techs get exactly this card (tech-job-access: all pertinent job info; a task has no price).
 *
 * Two faces, one component:
 *   card — the Overview's summary: "Tasks: 7 of 12 done", the next 3, All Tasks (the Tasks tab), and
 *          the Add line. A job with no tasks shows just the Add line.
 *   tab  — the Tasks tab (the pinned chip right after Overview): every open task, the Add line, and
 *          the Done fold, where each row says who and when ("Brian · Tue 2:14 PM", company time zone)
 *          and can take a quiet, optional photo of the finished work.
 *
 * Deleting follows 0358's rule, said before the tap: the office or whoever added the task. A tech
 * opens an office task to read it and checks it off; there is no Delete for him to press.
 */
export function JobTaskList({
  jobId,
  orgId,
  tasks,
  photos = {},
  mode,
  viewerId,
  viewerIsStaff,
  tz,
  nowIso,
  stamps,
  failed = false,
  doneOpen = false,
}: {
  jobId: string;
  orgId: string;
  tasks: JobTaskRow[];
  photos?: TaskPhotos;
  mode: "card" | "tab";
  viewerId: string | null;
  viewerIsStaff: boolean;
  /** The company's time zone: the done line reads in it, never the phone's. */
  tz: string;
  /** The server's now, so the done line reads the same on the server and the phone. */
  nowIso: string;
  /** The database has 0358 (photos on tasks, who checked it off). */
  stamps: boolean;
  /** The list couldn't be read: say so, never "no tasks". */
  failed?: boolean;
  /** The tab's Done fold starts open (it starts closed: the open work leads). */
  doneOpen?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  // Optimistic check state, reverted on a refusal; the refresh brings the server's answer.
  const [override, setOverride] = useState<Map<string, boolean>>(new Map());
  const [editing, setEditing] = useState<JobTaskRow | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [foldOpen, setFoldOpen] = useState(doneOpen);
  const now = new Date(nowIso);

  const { open, done } = splitJobTasks(tasks);
  const total = tasks.length;
  const isDone = (t: JobTaskRow) => override.get(t.id) ?? t.status === "done";

  function toggle(t: JobTaskRow) {
    const next = !isDone(t);
    setOverride((m) => new Map(m).set(t.id, next));
    start(async () => {
      let res: ToggleTaskResult = await toggleTask(t.id, next, { jobId });
      if (!res.ok && res.needsCascade && next) {
        const n = res.openChildren ?? 0;
        if (!confirm(`"${t.title}" has ${n} open step${n === 1 ? "" : "s"}. Mark ${n === 1 ? "it" : "them"} done too?`)) {
          setOverride((m) => new Map(m).set(t.id, !next));
          return;
        }
        res = await toggleTask(t.id, next, { jobId, cascade: true });
      }
      if (!res.ok) {
        setOverride((m) => new Map(m).set(t.id, !next));
        toast(res.error ?? "Couldn't update the task. Try again.", "error");
        return;
      }
      // Reopening takes a task's done photo off it (0358 clears it); the file stays on the job. Said.
      const doneShot = photos[t.id]?.done;
      if (!next && doneShot && typeof doneShot === "object") toast("Reopened. Its done photo is still on the Photos tab.", "info");
      // The card shows open tasks only, so a checked one leaves it: an Undo, never a mis-tap that
      // takes the Tasks tab and the Done fold to take back.
      if (next && mode === "card") {
        toast(`Checked off: ${t.title}`, "success", {
          label: "Undo",
          onClick: () => {
            setOverride((m) => new Map(m).set(t.id, false));
            void toggleTask(t.id, false, { jobId }).then((back) => {
              if (!back.ok) {
                setOverride((m) => new Map(m).set(t.id, true));
                toast(back.error ?? "Couldn't reopen the task. Try again.", "error");
              }
              router.refresh();
            });
          },
        });
      }
      router.refresh();
    });
  }

  const row = (t: JobTaskRow) => {
    const checked = isDone(t);
    const p = photos[t.id];
    return (
      <li key={t.id} className="flex items-center gap-1 pr-2">
        {/* 44px: the checkbox is the row's most-tapped target, one-handed on a ladder. */}
        <label className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
          <input
            type="checkbox"
            checked={checked}
            onChange={() => toggle(t)}
            disabled={pending}
            aria-label={checked ? `Reopen ${t.title}` : `Check off ${t.title}`}
            className="h-5 w-5 rounded border-slate-300 text-brand focus:ring-brand"
          />
        </label>
        <button
          type="button"
          onClick={() => setEditing(t)}
          className="flex min-h-[44px] min-w-0 flex-1 flex-col justify-center py-1 text-left"
        >
          <span className={checked ? "text-sm text-slate-400 line-through" : "text-sm font-medium text-slate-900"}>{t.title}</span>
          {t.status === "done" && <span className="text-xs text-slate-500">{doneWords(t, tz, now)}</span>}
        </button>
        <Thumb photo={p?.task ?? null} label={`Photo for ${t.title}`} onOpen={setViewing} />
        {mode === "tab" && t.status === "done" && stamps && (
          p?.done ? (
            <Thumb photo={p.done} label={`Photo of ${t.title} done`} onOpen={setViewing} />
          ) : (
            <DonePhotoButton orgId={orgId} jobId={jobId} taskId={t.id} />
          )
        )}
      </li>
    );
  };

  const header = total > 0 && (
    <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4">
      <h2 className="py-3 text-sm font-semibold text-slate-900">{tasksHeader(total, done.length)}</h2>
      {mode === "card" && (
        <Link
          href="?tab=tasks"
          scroll={false}
          className="inline-flex min-h-[44px] items-center text-sm font-medium text-brand hover:underline"
        >
          All Tasks
        </Link>
      )}
    </div>
  );

  const shownOpen = mode === "card" ? open.slice(0, 3) : open;

  return (
    <Card className="overflow-hidden">
      {header}
      {failed && (
        <p className="px-4 py-3 text-sm text-red-600">Couldn&rsquo;t read this job&rsquo;s tasks just now. Reload to try again.</p>
      )}
      {shownOpen.length > 0 && <ul className="divide-y divide-slate-100">{shownOpen.map(row)}</ul>}
      {!failed && total > 0 && open.length === 0 && (
        <p className="px-4 py-3 text-sm text-slate-500">Everything on this list is done.</p>
      )}
      {mode === "card" && open.length > shownOpen.length && (
        <p className="px-4 pb-1 text-xs text-slate-400">
          +{open.length - shownOpen.length} more on the Tasks tab
        </p>
      )}
      {!failed && <AddTaskLine jobId={jobId} orgId={orgId} photoDoor={stamps} bordered={total > 0} />}
      {mode === "tab" && done.length > 0 && (
        <div className="border-t border-slate-100">
          <button
            type="button"
            onClick={() => setFoldOpen((v) => !v)}
            aria-expanded={foldOpen}
            className="flex min-h-[44px] w-full items-center justify-between px-4 text-left text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            {done.length} Done
            <ChevronDown className={`h-4 w-4 transition-transform ${foldOpen ? "rotate-180" : ""}`} />
          </button>
          {foldOpen && <ul className="divide-y divide-slate-100 border-t border-slate-100">{done.map(row)}</ul>}
        </div>
      )}
      {mode === "tab" && !stamps && !failed && (
        <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400">
          Photos on tasks, and who checked each one off, start after the next database update.
        </p>
      )}

      {editing && (
        <TaskEditSheet
          key={editing.id}
          task={editing}
          jobId={jobId}
          canDelete={canDeleteTask(editing, viewerId, viewerIsStaff)}
          onClose={() => setEditing(null)}
        />
      )}
      {viewing && <MediaLightbox url={viewing} name="Task photo" onClose={() => setViewing(null)} />}
    </Card>
  );
}

/** The task's photo: a 44px thumbnail that opens it full screen, or a plain word when the photo is
 *  gone ("Photo removed" — it was deleted from the Photos tab) or can't be shown just now. */
function Thumb({ photo, label, onOpen }: { photo: TaskPhoto; label: string; onOpen: (url: string) => void }) {
  if (!photo) return null;
  if (photo === "removed") return <span className="shrink-0 text-xs text-slate-400">Photo removed</span>;
  if (photo === "unavailable") return <span className="shrink-0 text-xs text-slate-400">Photo unavailable</span>;
  return (
    <button
      type="button"
      onClick={() => onOpen(photo.url)}
      aria-label={label}
      className="h-11 w-11 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-50"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed storage URL */}
      <img src={photo.url} alt="" className="h-full w-full object-cover" />
    </button>
  );
}

/**
 * THE ADD LINE: type the words, Add. Photo (after 0358) takes a picture first, files it on the job's
 * Photos tab, then asks "What needs doing?" (Make It A Task). No date, no priority, no person.
 */
function AddTaskLine({ jobId, orgId, photoDoor, bordered }: { jobId: string; orgId: string; photoDoor: boolean; bordered: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [pending, start] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [sheet, setSheet] = useState<{ path: string; preview: string | null } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function add() {
    if (!title.trim()) return;
    start(async () => {
      const res = await createTask({ title, job_id: jobId });
      if (!res.ok) {
        toast(res.error ?? "Couldn't add the task. Try again.", "error");
        return;
      }
      // Said every time: on the Overview card a new task can land past the three it shows.
      if (res.duplicate) toast(res.speak ?? "Already on the list.", "info");
      else toast("Added to this job's Tasks", "success");
      setTitle("");
      router.refresh();
    });
  }

  async function onPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const [path] = await uploadJobPhotos(orgId, jobId, [file]);
      setSheet({ path, preview: URL.createObjectURL(file) });
    } catch (err: any) {
      toast(err?.message ?? "The photo didn't upload. Try again.", "error");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className={`flex items-center gap-2 px-3 py-2 ${bordered ? "border-t border-slate-100" : ""}`}>
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && add()}
        placeholder="Add A Task…"
        aria-label="Add A Task"
        className="h-11 min-w-0 flex-1"
      />
      <Button onClick={add} disabled={pending || !title.trim()} className="shrink-0 px-3">
        <Plus /> Add
      </Button>
      {photoDoor && (
        <>
          {/* No `capture`: iOS then offers Camera or Photo Library, both verbs (job-photo-quick). */}
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPhoto} />
          <Button
            variant="outline"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="shrink-0 px-3"
            title="Take a photo and make it a task"
          >
            {uploading ? <Loader2 className="animate-spin" /> : <Camera />} Photo
          </Button>
        </>
      )}
      {sheet && (
        <PhotoTaskSheet
          jobId={jobId}
          photoPath={sheet.path}
          previewUrl={sheet.preview}
          onClose={() => {
            if (sheet.preview) URL.revokeObjectURL(sheet.preview);
            setSheet(null);
          }}
        />
      )}
    </div>
  );
}

/** A done row's quiet, optional photo of the finished work (never required, never camera-first). */
function DonePhotoButton({ orgId, jobId, taskId }: { orgId: string; jobId: string; taskId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (ref.current) ref.current.value = "";
    if (!file) return;
    setBusy(true);
    try {
      const [path] = await uploadJobPhotos(orgId, jobId, [file]);
      const res = await setTaskDonePhoto(taskId, path, { jobId });
      if (!res.ok) toast(res.error ?? "The photo is on the Photos tab, but it didn't go on the task.", "error");
      else toast("Photo added", "success");
      router.refresh();
    } catch (err: any) {
      toast(err?.message ?? "The photo didn't upload. Try again.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <input ref={ref} type="file" accept="image/*" className="hidden" onChange={onFile} />
      <button
        type="button"
        onClick={() => ref.current?.click()}
        disabled={busy}
        className="inline-flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-brand disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />} Add Photo
      </button>
    </>
  );
}

/** Rename a task, or delete it when the viewer may (the office, or whoever added it). */
function TaskEditSheet({
  task,
  jobId,
  canDelete,
  onClose,
}: {
  task: JobTaskRow;
  jobId: string;
  canDelete: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [title, setTitle] = useState(task.title);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const changed = title.trim() !== task.title.trim();

  function save() {
    if (!title.trim()) {
      setError("A task needs its words.");
      return;
    }
    if (!changed) {
      onClose();
      return;
    }
    start(async () => {
      const res = await updateTask(task.id, { title }, { jobId });
      if (!res.ok) {
        setError(res.error ?? "Couldn't save. Try again.");
        return;
      }
      onClose();
      router.refresh();
    });
  }

  function remove() {
    if (!confirm(`Delete "${task.title}"? This can't be undone.`)) return;
    start(async () => {
      const res = await deleteTask(task.id, { jobId });
      if (!res.ok) {
        setError(res.error ?? "Couldn't delete the task. Try again.");
        return;
      }
      toast("Task deleted", "success");
      onClose();
      router.refresh();
    });
  }

  return (
    <Modal
      open
      portal
      onClose={onClose}
      title="Task"
      size="sm"
      dirty={changed}
      footer={
        <ModalActions
          onCancel={onClose}
          onSave={save}
          saving={pending}
          saveLabel="Save Changes"
          extra={
            canDelete ? (
              <Button type="button" variant="ghost" onClick={remove} disabled={pending} className="text-red-600 hover:text-red-700">
                Delete Task
              </Button>
            ) : undefined
          }
        />
      }
    >
      <div className="space-y-3">
        <div>
          <Label htmlFor={`task-title-${task.id}`}>What needs doing</Label>
          <Input
            id={`task-title-${task.id}`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            className="h-11"
          />
        </div>
        {/* The note: a long materials request's whole text and who asked (the title stops at 120). */}
        {task.notes && <p className="whitespace-pre-wrap text-sm text-slate-600">{task.notes}</p>}
        {!canDelete && (
          <p className="text-xs text-slate-500">
            The office or whoever added this task can delete it. You can check it off from the list.
          </p>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}
