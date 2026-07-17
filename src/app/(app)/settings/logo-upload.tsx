"use client";

import { useRef, useState } from "react";
import { Upload, Trash2, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { setLogoUrl } from "./actions";

export function LogoUpload({
  orgId,
  current,
}: {
  orgId: string;
  current: string | null;
}) {
  const [logo, setLogo] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file (PNG, JPG, or WebP).");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError("Logo must be under 2 MB.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const supabase = createClient();
      const ext = (file.name.split(".").pop() || "png").toLowerCase();
      const path = `${orgId}/logo-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("branding")
        .upload(path, file, { upsert: true, cacheControl: "3600" });
      if (upErr) throw upErr;
      const { data } = supabase.storage.from("branding").getPublicUrl(path);
      const res = await setLogoUrl(data.publicUrl);
      if (!res.ok) throw new Error(res.error);
      setLogo(data.publicUrl);
    } catch (err: any) {
      setError(err?.message ?? "Upload failed.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove() {
    setBusy(true);
    await setLogoUrl(null);
    setLogo(null);
    setBusy(false);
  }

  return (
    <div>
      <div className="flex items-center gap-4">
        <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt="Company logo" className="h-full w-full object-contain p-1" />
          ) : (
            <span className="text-xs text-slate-400">No logo</span>
          )}
        </div>
        <div className="space-y-2">
          <input
            ref={fileRef}
            type="file"
            // SVG dropped: migration 0134 caps the branding bucket to raster image mimes
            // (an SVG served from the public storage origin is scriptable).
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={onFile}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {logo ? "Replace Logo" : "Upload Logo"}
            </Button>
            {logo && (
              <Button type="button" variant="ghost" onClick={remove} disabled={busy}>
                <Trash2 className="h-4 w-4" /> Remove
              </Button>
            )}
          </div>
          <p className="text-xs text-slate-400">
            PNG, JPG, or WebP · up to 2 MB · shown on your documents.
          </p>
        </div>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
