"use client";

import { useEffect, useRef, useState } from "react";
import { MessageCircle, X, Send, Loader2, ImagePlus } from "lucide-react";
import { prepareImageForUpload } from "@/lib/image-prep";

type Msg = { role: "user" | "assistant"; content: string; images?: string[] };
type Attachment = { id: string; previewUrl: string; url?: string; uploading: boolean; error?: boolean };

const MAX_ATTACHMENTS = 3;

/** Floating public "Ask Nort" chat on an org's marketing site. Talks to the hardened, read-only
 *  /api/site-chat endpoint (scoped to this org's handle) — preliminary estimates + Q&A, it can READ
 *  photos the visitor uploads (e.g. their panel) to sharpen the estimate, and it quietly captures
 *  the conversation as a lead (with the photos attached) when the visitor shares contact info. */
export function AskNort({ handle, orgName, brand }: { handle: string; orgName: string; brand: string }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([
    { role: "assistant", content: `Hi! I'm Nort, ${orgName}'s estimate assistant. Tell me about your project — you can even snap a photo — and I'll give you a quick ballpark. Ask me anything.` },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [msgs, busy, open, attachments]);

  const uploading = attachments.some((a) => a.uploading);

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (fileRef.current) fileRef.current.value = "";
    const room = MAX_ATTACHMENTS - attachments.length;
    for (const file of picked.slice(0, Math.max(0, room))) {
      const id = `${Date.now()}-${Math.round(performance.now())}-${file.name}`;
      const previewUrl = URL.createObjectURL(file);
      setAttachments((a) => [...a, { id, previewUrl, uploading: true }]);
      try {
        const prepared = await prepareImageForUpload(file);
        const fd = new FormData();
        fd.append("handle", handle);
        fd.append("image", prepared);
        const res = await fetch("/api/site-chat/upload", { method: "POST", body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.url) throw new Error(data?.error || "upload failed");
        setAttachments((a) => a.map((x) => (x.id === id ? { ...x, url: data.url, uploading: false } : x)));
      } catch {
        setAttachments((a) => a.map((x) => (x.id === id ? { ...x, uploading: false, error: true } : x)));
      }
    }
  }

  function removeAttachment(id: string) {
    setAttachments((a) => {
      const gone = a.find((x) => x.id === id);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return a.filter((x) => x.id !== id);
    });
  }

  async function send() {
    const text = input.trim();
    const ready = attachments.filter((a) => a.url && !a.error);
    if ((!text && !ready.length) || busy || uploading) return;
    const imageUrls = ready.map((a) => a.url!) as string[];
    const content = text || "(sent a photo)";
    const next = [...msgs, { role: "user" as const, content, images: imageUrls.length ? imageUrls : undefined }];
    setMsgs(next);
    setInput("");
    attachments.forEach((a) => URL.revokeObjectURL(a.previewUrl));
    setAttachments([]);
    setBusy(true);
    try {
      const res = await fetch("/api/site-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, messages: next.slice(-24).map((m) => ({ role: m.role, content: m.content })), images: imageUrls }),
      });
      const data = await res.json().catch(() => ({}));
      setMsgs((m) => [...m, { role: "assistant", content: data?.reply || data?.error || "Sorry — please try again, or use the contact form below." }]);
    } catch {
      setMsgs((m) => [...m, { role: "assistant", content: "Connection hiccup — please try again or use the form below." }]);
    } finally {
      setBusy(false);
    }
  }

  const canSend = !busy && !uploading && (!!input.trim() || attachments.some((a) => a.url && !a.error));

  return (
    <>
      {/* Launcher */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center rounded-full text-white shadow-lg transition hover:scale-105"
        style={{ backgroundColor: brand }}
        aria-label={open ? "Close chat" : "Ask for an estimate"}
      >
        {open ? <X className="h-6 w-6" /> : <MessageCircle className="h-6 w-6" />}
      </button>

      {open && (
        <div className="fixed bottom-24 right-5 z-50 flex h-[70vh] max-h-[560px] w-[92vw] max-w-[380px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
          <div className="flex items-center gap-2 px-4 py-3 text-white" style={{ backgroundColor: brand }}>
            <MessageCircle className="h-5 w-5" />
            <div className="text-sm font-semibold">Ask {orgName}</div>
            <span className="ml-auto text-xs text-white/80">Instant estimate</span>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto bg-slate-50 p-3">
            {msgs.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${m.role === "user" ? "text-white" : "border border-slate-200 bg-white text-slate-700"}`}
                  style={m.role === "user" ? { backgroundColor: brand } : undefined}
                >
                  {m.images && m.images.length > 0 && (
                    <div className="mb-1.5 flex flex-wrap gap-1.5">
                      {m.images.map((url) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={url} src={url} alt="attachment" className="h-16 w-16 rounded-lg object-cover" />
                      ))}
                    </div>
                  )}
                  {m.content}
                </div>
              </div>
            ))}
            {busy && (
              <div className="flex justify-start">
                <div className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              </div>
            )}
          </div>

          {/* Pending attachment thumbnails */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 border-t border-slate-100 bg-white px-2 pt-2">
              {attachments.map((a) => (
                <div key={a.id} className="relative h-14 w-14 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={a.previewUrl} alt="upload preview" className={`h-full w-full object-cover ${a.error ? "opacity-40" : ""}`} />
                  {a.uploading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-white/50">
                      <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
                    </div>
                  )}
                  {a.error && <div className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold text-red-600">failed</div>}
                  <button type="button" onClick={() => removeAttachment(a.id)} className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center rounded-bl bg-black/60 text-white" aria-label="Remove photo">
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <form
            onSubmit={(e) => { e.preventDefault(); send(); }}
            className="flex items-center gap-2 border-t border-slate-200 bg-white p-2"
          >
            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={onFiles} />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy || attachments.length >= MAX_ATTACHMENTS}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 disabled:opacity-40"
              aria-label="Attach a photo"
            >
              <ImagePlus className="h-5 w-5" />
            </button>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Describe your project…"
              maxLength={4000}
              className="flex-1 rounded-full border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2"
              style={{ ["--tw-ring-color" as string]: brand } as React.CSSProperties}
            />
            <button type="submit" disabled={!canSend} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white disabled:opacity-40" style={{ backgroundColor: brand }} aria-label="Send">
              <Send className="h-4 w-4" />
            </button>
          </form>
          <p className="pb-2 text-center text-[10px] text-slate-400">Preliminary estimates · powered by Contractor North</p>
        </div>
      )}
    </>
  );
}
