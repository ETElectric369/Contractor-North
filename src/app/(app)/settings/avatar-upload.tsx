"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, Trash2, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { prepareImageForUpload } from "@/lib/image-prep";
import { initials } from "@/lib/utils";
import { setAvatarUrl } from "./actions";

/** Profile picture: tap to pick/snap, auto-resized, stored publicly. */
export function AvatarUpload({
  userId,
  name,
  current,
}: {
  userId: string;
  name: string | null;
  current: string | null;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!raw) return;
    setBusy(true);
    setError(null);
    try {
      const file = await prepareImageForUpload(raw);
      const path = `avatars/${userId}-${Date.now()}.jpg`;
      const supabase = createClient();
      const { error: upErr } = await supabase.storage
        .from("branding")
        .upload(path, file, { upsert: true, cacheControl: "3600" });
      if (upErr) throw upErr;
      const { data } = supabase.storage.from("branding").getPublicUrl(path);
      const res = await setAvatarUrl(data.publicUrl);
      if (!res.ok) throw new Error(res.error);
      setUrl(data.publicUrl);
      router.refresh();
    } catch (err: any) {
      setError(err?.message ?? "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    await setAvatarUrl(null);
    setUrl(null);
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="flex items-center gap-4">
      <button
        onClick={() => fileRef.current?.click()}
        className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-full"
        title="Change photo"
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center bg-brand text-lg font-semibold text-white">
            {initials(name)}
          </span>
        )}
        <span className="absolute inset-0 hidden items-center justify-center bg-black/40 group-hover:flex">
          <Camera className="h-5 w-5 text-white" />
        </span>
      </button>
      <div className="space-y-1">
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
            {url ? "Change photo" : "Add photo"}
          </Button>
          {url && (
            <Button size="sm" variant="outline" onClick={remove} disabled={busy} className="text-red-600">
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </Button>
          )}
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
    </div>
  );
}
