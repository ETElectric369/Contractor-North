"use client";

import { useMemo, useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { ACCEPT_ATTR, INTAKE_BUCKET, MAX_UPLOAD_MB, isAllowedUpload, uploadDisplayName } from "@/lib/playbook/uploads";
import { createClient } from "@/lib/supabase/client";
import { prepareImageForUpload } from "@/lib/image-prep";
import { applicableNeeds } from "@/lib/playbook/resolve";
import type { PublicNeed } from "@/lib/playbook/public-intake";
import type { Answers, Need } from "@/lib/playbook/types";
import { submitIntake } from "./actions";

/**
 * The customer's side of the playbook — the same `when` engine the inspector runs, so "Do you
 * have plans?" reveals its follow-up the moment they answer Yes (the conditional Andrew asked
 * for), and an answer that stops applying is simply not shown or sent.
 *
 * Deliberately boring: fixed contact block, one column, no accounts, no progress bar. A customer
 * gives a contractor two minutes; every extra control here is a lead that closes the tab.
 */
export function IntakeForm({ handle, needs, orgName }: { handle: string; needs: PublicNeed[]; orgName: string }) {
  const [contact, setContact] = useState({ name: "", phone: "", email: "", address: "" });
  const [answers, setAnswers] = useState<Answers>({});
  const [hp, setHp] = useState(""); // honeypot — hidden from people, filled by bots
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const pb = useMemo(() => ({ needs: needs as Need[] }), [needs]);
  const visible = useMemo(() => applicableNeeds(pb, answers), [pb, answers]);

  const set = (key: string, v: Answers[string]) => setAnswers((a) => ({ ...a, [key]: v }));

  const [busyKey, setBusyKey] = useState<string | null>(null);

  /**
   * UPLOAD STRAIGHT TO STORAGE, never through our server.
   *
   * A 100MB plan set cannot go through a Next.js action or route — Vercel caps the request body at
   * ~4.5MB. So the server mints a signed slot for ONE path it chooses (see the upload-url route)
   * and the browser PUTs the bytes to Supabase directly. What comes back into the answer is the
   * PATH, which is meaningless without a signed read link.
   */
  async function addFiles(key: string, files: File[]) {
    if (!files.length) return;
    setBusyKey(key);
    setErr(null);
    try {
      const supabase = createClient();
      const done: string[] = [];
      for (const raw of files) {
        if (!isAllowedUpload(raw.name)) throw new Error(`${raw.name} isn't a file type we accept.`);
        // SHRINK A PHOTO BEFORE IT LEAVES THE PHONE — the same helper the inspector uses, which
        // this door was missing. Erik's own test put a 4.4MB and a 3.3MB JPEG straight into the
        // bucket: that is the contractor's storage bill, and on site cell service it is a customer
        // watching a progress bar long enough to give up. A plan set (PDF/DWG) passes through
        // untouched — those are documents, not snapshots.
        const file = raw.type.startsWith("image/") ? await prepareImageForUpload(raw) : raw;
        if (file.size > MAX_UPLOAD_MB * 1024 * 1024) throw new Error(`${raw.name} is over ${MAX_UPLOAD_MB}MB.`);
        const res = await fetch("/api/intake/upload-url", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // The SHRUNK size and the ORIGINAL name — the server validates the extension off the
          // name it will actually write, and prepareImageForUpload can change a .heic to a .jpg.
          body: JSON.stringify({ handle, name: file.name, size: file.size }),
        });
        const slot = await res.json();
        if (!res.ok) throw new Error(slot?.error ?? "Upload failed.");
        const { error } = await supabase.storage.from(INTAKE_BUCKET).uploadToSignedUrl(slot.path, slot.token, file);
        if (error) throw new Error("Upload failed — please try again.");
        done.push(slot.path as string);
      }
      const have = Array.isArray(answers[key]) ? (answers[key] as string[]) : [];
      set(key, [...have, ...done]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusyKey(null);
    }
  }

  if (done)
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
        <p className="flex items-center gap-2 text-base font-medium text-emerald-800">
          <Check className="h-5 w-5" /> Sent — thank you.
        </p>
        <p className="mt-1 text-sm text-emerald-700">
          {orgName} has your request and will get back to you soon.
        </p>
      </div>
    );

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setErr(null);
          const r = await submitIntake(handle, { hp, contact, answers });
          if (!r.ok) return setErr(r.error);
          setDone(true);
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label className="mb-1.5">Your name</Label>
          <Input required value={contact.name} autoComplete="name" onChange={(e) => setContact({ ...contact, name: e.target.value })} />
        </div>
        <div>
          <Label className="mb-1.5">Phone</Label>
          <Input type="tel" value={contact.phone} autoComplete="tel" onChange={(e) => setContact({ ...contact, phone: e.target.value })} />
        </div>
        <div>
          <Label className="mb-1.5">Email</Label>
          <Input type="email" value={contact.email} autoComplete="email" onChange={(e) => setContact({ ...contact, email: e.target.value })} />
        </div>
        <div>
          <Label className="mb-1.5">Project address</Label>
          <Input value={contact.address} autoComplete="street-address" onChange={(e) => setContact({ ...contact, address: e.target.value })} />
        </div>
      </div>

      {/* Honeypot: visually gone, still in the DOM for bots that fill every field. */}
      <input
        type="text"
        value={hp}
        onChange={(e) => setHp(e.target.value)}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute -left-[9999px] h-0 w-0 opacity-0"
      />

      {visible.map((n) => (
        <div key={n.key}>
          <Label className="mb-1.5">{n.ask}</Label>
          {n.slot?.type === "file" ? (
            <div className="rounded-lg border border-dashed border-slate-300 p-3">
              <input
                type="file"
                multiple={n.slot.multi !== false}
                accept={ACCEPT_ATTR}
                disabled={busyKey === n.key}
                onChange={(e) => {
                  void addFiles(n.key, Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
                className="block w-full text-sm text-slate-600 file:mr-3 file:min-h-[40px] file:rounded-full file:border-0 file:bg-slate-900 file:px-4 file:text-sm file:text-white"
              />
              <p className="mt-1.5 text-xs text-slate-500">
                {busyKey === n.key ? "Uploading…" : `PDF, DWG, DXF or photos — up to ${MAX_UPLOAD_MB}MB each.`}
              </p>
              {Array.isArray(answers[n.key]) && (answers[n.key] as string[]).length > 0 && (
                <ul className="mt-2 space-y-1">
                  {(answers[n.key] as string[]).map((path) => (
                    <li key={path} className="flex items-center justify-between gap-2 text-sm text-slate-700">
                      <span className="truncate">{uploadDisplayName(path)}</span>
                      <button
                        type="button"
                        onClick={() => set(n.key, (answers[n.key] as string[]).filter((p) => p !== path) as never)}
                        className="shrink-0 text-xs text-slate-400 underline-offset-2 hover:underline"
                      >
                        remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : n.slot?.type === "select" ? (
            n.slot.multi ? (
              <div className="flex flex-wrap gap-2">
                {n.slot.options.map((o) => {
                  const cur = Array.isArray(answers[n.key]) ? (answers[n.key] as string[]) : [];
                  const on = cur.includes(o);
                  return (
                    <button
                      key={o}
                      type="button"
                      onClick={() => set(n.key, on ? cur.filter((x) => x !== o) : [...cur, o])}
                      className={
                        on
                          ? "min-h-[40px] rounded-full border border-slate-900 bg-slate-900 px-4 text-sm text-white"
                          : "min-h-[40px] rounded-full border border-slate-300 bg-white px-4 text-sm text-slate-700"
                      }
                    >
                      {o}
                    </button>
                  );
                })}
              </div>
            ) : (
              <Select value={typeof answers[n.key] === "string" ? (answers[n.key] as string) : ""} onChange={(e) => set(n.key, e.target.value || null)}>
                <option value="">Choose…</option>
                {n.slot.options.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </Select>
            )
          ) : n.slot?.type === "number" ? (
            <Input
              type="number"
              inputMode="decimal"
              value={typeof answers[n.key] === "number" ? String(answers[n.key]) : ""}
              onChange={(e) => set(n.key, e.target.value === "" ? null : Number(e.target.value))}
            />
          ) : n.slot?.type === "text" && n.slot.long ? (
            <Textarea rows={4} value={typeof answers[n.key] === "string" ? (answers[n.key] as string) : ""} onChange={(e) => set(n.key, e.target.value || null)} />
          ) : (
            <Input value={typeof answers[n.key] === "string" ? (answers[n.key] as string) : ""} onChange={(e) => set(n.key, e.target.value || null)} />
          )}
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? <><Loader2 className="h-4 w-4 animate-spin" /> Sending…</> : "Send it"}
        </Button>
        {err && <span className="text-sm text-rose-600">{err}</span>}
      </div>
    </form>
  );
}
