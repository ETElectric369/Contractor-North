"use client";

import { useRef, useState } from "react";
import { AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowUp, Eye, Loader2, Pencil, Plus, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Textarea } from "@/components/ui/input";
import { BlockRenderer } from "@/app/site/block-renderer";
import { uploadSiteImage } from "@/lib/upload-site-image";
import { BLOCK_PALETTE, SECTION_PALETTE, type Block, type BlockStyle, type BlockType, type SectionKey } from "@/lib/site-blocks";

/**
 * The reusable visual block editor — the sections list (add / reorder / remove), the per-block field
 * inputs + styling toolbox, image upload, and a layout-sketch Preview toggle (content and order only
 * — wired sections render as placeholders, so it's labeled a sketch, not "your site"). Owns nothing
 * but the preview flag: all block state flows through `blocks` + `onChange`, so the SAME editor
 * drives custom pages (PagesManager) and the homepage (HomeBlocksEditor). `orgId` enables device
 * upload; `brand` colors the preview's buttons; `previewTitle` shows an H1 atop the preview.
 */
export function BlockEditor({
  blocks,
  onChange,
  brand = "#0f172a",
  orgId,
  previewTitle,
  sections = false,
}: {
  blocks: Block[];
  onChange: (blocks: Block[]) => void;
  brand?: string;
  orgId?: string;
  previewTitle?: string;
  /** Offer the wired homepage sections (gallery/reviews/contact/estimate) in the palette. Homepage only. */
  sections?: boolean;
}) {
  const [preview, setPreview] = useState(false);
  const updateBlock = (i: number, props: Record<string, unknown>) =>
    onChange(blocks.map((b, j) => (j === i ? ({ ...b, props: { ...b.props, ...props } } as Block) : b)));
  const updateStyle = (i: number, style: BlockStyle) =>
    onChange(blocks.map((b, j) => (j === i ? ({ ...b, style } as Block) : b)));
  const move = (i: number, d: -1 | 1) => {
    const t = i + d;
    if (t < 0 || t >= blocks.length) return;
    const n = [...blocks];
    [n[i], n[t]] = [n[t], n[i]];
    onChange(n);
  };
  const addBlock = (t: BlockType) => onChange([...blocks, BLOCK_PALETTE.find((p) => p.type === t)!.make()]);
  const addSection = (key: SectionKey) => onChange([...blocks, { type: "section", props: { key } }]);
  const remove = (i: number) => onChange(blocks.filter((_, j) => j !== i));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-700">Sections</span>
        {blocks.length > 0 && (
          <button type="button" onClick={() => setPreview((v) => !v)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">
            {preview ? <><Pencil className="h-3.5 w-3.5" /> Back to editing</> : <><Eye className="h-3.5 w-3.5" /> Preview</>}
          </button>
        )}
      </div>

      {preview ? (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-400">Layout sketch — content and order only; wired sections show as placeholders</div>
          <div className="max-h-[58vh] overflow-y-auto">
            {previewTitle && <h1 className="mx-auto max-w-3xl px-4 pt-8 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">{previewTitle}</h1>}
            <BlockRenderer blocks={blocks} brand={brand} />
          </div>
        </div>
      ) : (
        <>
          {blocks.length === 0 && <p className="rounded-lg border border-dashed border-slate-300 px-4 py-5 text-center text-sm text-slate-400">No sections yet — add one below.</p>}
          {blocks.map((b, i) => {
            const sec = b.type === "section" ? SECTION_PALETTE.find((s) => s.key === b.props.key) : null;
            return (
              <div key={i} className="rounded-xl border border-slate-200 p-3">
                <div className="flex items-center gap-2">
                  <Badge tone={sec ? "blue" : "slate"}>{sec ? sec.label : BLOCK_PALETTE.find((p) => p.type === b.type)?.label ?? b.type}</Badge>
                  {sec && <span className="min-w-0 truncate text-xs text-slate-400">{sec.hint}</span>}
                  <div className="ml-auto flex items-center gap-0.5">
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === blocks.length - 1} className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button>
                    <button type="button" onClick={() => remove(i)} className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"><X className="h-4 w-4" /></button>
                  </div>
                </div>
                {!sec && (
                  <div className="mt-2">
                    <BlockFields block={b} orgId={orgId} onChange={(props) => updateBlock(i, props)} />
                    <StyleToolbar block={b} onChange={(style) => updateStyle(i, style)} />
                  </div>
                )}
              </div>
            );
          })}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {BLOCK_PALETTE.map((p) => (
              <button key={p.type} type="button" onClick={() => addBlock(p.type)} title={p.hint}
                className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200">
                <Plus className="h-3.5 w-3.5" /> {p.label}
              </button>
            ))}
            {sections && SECTION_PALETTE.map((s) => (
              <button key={s.key} type="button" onClick={() => addSection(s.key)} title={s.hint}
                className="inline-flex items-center gap-1 rounded-lg bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100">
                <Plus className="h-3.5 w-3.5" /> {s.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** The per-type field editor for one block (content only — look/feel is the StyleToolbar below it). */
function BlockFields({ block, orgId, onChange }: { block: Block; orgId?: string; onChange: (props: Record<string, unknown>) => void }) {
  if (block.type === "heading")
    return <Input value={block.props.text} onChange={(e) => onChange({ text: e.target.value })} placeholder="Heading text" />;
  if (block.type === "text")
    return <Textarea rows={4} value={block.props.html} onChange={(e) => onChange({ html: e.target.value })} placeholder="Write the section copy — plain text or HTML." />;
  if (block.type === "image")
    return (
      <div className="space-y-2">
        <ImageField value={block.props.url} onChange={(url) => onChange({ url })} orgId={orgId} placeholder="Image URL (https://…)" />
        <div className="grid gap-2 sm:grid-cols-2">
          <Input value={block.props.alt ?? ""} onChange={(e) => onChange({ alt: e.target.value })} placeholder="Alt text (for SEO)" />
          <Input value={block.props.caption ?? ""} onChange={(e) => onChange({ caption: e.target.value })} placeholder="Caption (optional)" />
        </div>
      </div>
    );
  if (block.type === "button")
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <Input value={block.props.label} onChange={(e) => onChange({ label: e.target.value })} placeholder="Button text" />
        <Input value={block.props.href} onChange={(e) => onChange({ href: e.target.value })} placeholder="Link (https://… or /contact)" />
      </div>
    );
  if (block.type === "gallery")
    // Full image OBJECTS flow through (not bare urls): the old url-only mapping silently
    // WIPED every stored alt on any gallery edit, and there was no way to set one — the
    // audit's most concrete builder defect (SEO wave 2026-07-24).
    return <GalleryFields images={block.props.images.map((im) => ({ url: im.url, alt: im.alt }))} orgId={orgId} onChange={(images) => onChange({ images })} />;
  if (block.type === "banner")
    return (
      <div className="space-y-2">
        <div>
          <span className="mb-1 block text-xs font-medium text-slate-500">Background image</span>
          <ImageField value={block.props.bgUrl} onChange={(url) => onChange({ bgUrl: url })} orgId={orgId} placeholder="Background image URL" />
        </div>
        <Input value={block.props.heading} onChange={(e) => onChange({ heading: e.target.value })} placeholder="Heading (shown over the image)" />
        <Input value={block.props.text ?? ""} onChange={(e) => onChange({ text: e.target.value })} placeholder="Subtext (optional)" />
        <div className="grid gap-2 sm:grid-cols-2">
          <Input value={block.props.buttonLabel ?? ""} onChange={(e) => onChange({ buttonLabel: e.target.value })} placeholder="Button text (optional)" />
          <Input value={block.props.buttonHref ?? ""} onChange={(e) => onChange({ buttonHref: e.target.value })} placeholder="Button link (optional)" />
        </div>
      </div>
    );
  return null;
}

/** A URL input paired with an upload-from-device button (+ a thumbnail preview). Upload needs orgId
 *  (goes through uploadSiteImage — the path both storage policies accept). Exported: PostsManager
 *  reuses it for the article cover image. */
export function ImageField({ value, onChange, orgId, placeholder, id }: { value: string; onChange: (url: string) => void; orgId?: string; placeholder?: string; id?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = (e.target.files ?? [])[0];
    if (!f || !orgId) return;
    setErr(null);
    setBusy(true);
    try {
      onChange(await uploadSiteImage(orgId, f));
    } catch (x) {
      setErr(x instanceof Error ? x.message : "Upload failed.");
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
        <input ref={ref} type="file" accept="image/*" className="hidden" onChange={onFile} />
        {orgId && (
          <Button type="button" variant="outline" size="sm" onClick={() => ref.current?.click()} disabled={busy} title="Upload from your device">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          </Button>
        )}
      </div>
      {err && <p className="text-xs text-red-600">{err}</p>}
      {value && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={value} alt="" className="h-16 w-24 rounded border border-slate-200 object-cover" />
      )}
    </div>
  );
}

type GalleryImage = { url: string; alt?: string };

function GalleryFields({ images, orgId, onChange }: { images: GalleryImage[]; orgId?: string; onChange: (images: GalleryImage[]) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (!files.length || !orgId) return;
    setErr(null);
    setBusy(true);
    // Per-file try/catch: one bad photo must not sink the batch — keep every success, name every failure.
    const added: GalleryImage[] = [];
    const failed: string[] = [];
    for (const f of files) {
      try {
        added.push({ url: await uploadSiteImage(orgId, f) });
      } catch {
        failed.push(f.name);
      }
    }
    if (added.length) onChange([...images, ...added]);
    if (failed.length) setErr(`Couldn't upload ${failed.join(", ")}${added.length ? " — the rest were added" : ""}.`);
    setBusy(false);
    if (ref.current) ref.current.value = "";
  }
  return (
    <div className="space-y-2">
      {images.map((im, i) => (
        <div key={i} className="flex gap-2">
          <Input value={im.url} onChange={(e) => onChange(images.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} placeholder="Image URL" />
          <Input value={im.alt ?? ""} onChange={(e) => onChange(images.map((x, j) => (j === i ? { ...x, alt: e.target.value } : x)))} placeholder="Alt text (for SEO)" className="max-w-[45%]" />
          <button type="button" onClick={() => onChange(images.filter((_, j) => j !== i))} className="rounded-md p-2 text-slate-400 hover:text-red-600"><X className="h-4 w-4" /></button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => onChange([...images, { url: "" }])} className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200"><Plus className="h-3.5 w-3.5" /> Add URL</button>
        {orgId && (
          <>
            <input ref={ref} type="file" accept="image/*" multiple className="hidden" onChange={onFiles} />
            <button type="button" onClick={() => ref.current?.click()} disabled={busy} className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200 disabled:opacity-50">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Upload photos
            </button>
          </>
        )}
      </div>
      {err && <p className="text-xs text-red-600">{err}</p>}
    </div>
  );
}

/** The styling "toolbox" for one block — alignment, size, font, and color, all safe/structured. */
function StyleToolbar({ block, onChange }: { block: Block; onChange: (style: BlockStyle) => void }) {
  if (block.type === "gallery" || block.type === "section") return null;
  const st = block.style ?? {};
  const set = (patch: Partial<BlockStyle>) => onChange({ ...st, ...patch });
  const showAlign = block.type !== "banner"; // a banner is always centered over its image
  const full = block.type === "heading" || block.type === "text" || block.type === "button" || block.type === "banner";
  const colorLabel = block.type === "button" || block.type === "banner" ? "Button color" : "Text color";

  const IconBtn = ({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: React.ReactNode; title: string }) => (
    <button type="button" title={title} onClick={onClick} className={`rounded p-1 ${on ? "bg-white text-brand shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>{children}</button>
  );

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-slate-50 px-2 py-1.5 text-xs">
      {showAlign && (
        <div className="flex items-center gap-0.5">
          <IconBtn on={(st.align ?? "left") === "left"} onClick={() => set({ align: "left" })} title="Left"><AlignLeft className="h-3.5 w-3.5" /></IconBtn>
          <IconBtn on={st.align === "center"} onClick={() => set({ align: "center" })} title="Center"><AlignCenter className="h-3.5 w-3.5" /></IconBtn>
          <IconBtn on={st.align === "right"} onClick={() => set({ align: "right" })} title="Right"><AlignRight className="h-3.5 w-3.5" /></IconBtn>
        </div>
      )}
      {full && (
        <>
          <div className="flex items-center gap-1">
            <span className="text-slate-400">Size</span>
            {(["s", "m", "l", "xl"] as const).map((sz) => (
              <button key={sz} type="button" onClick={() => set({ size: sz })} className={`rounded px-1.5 py-0.5 font-semibold uppercase ${(st.size ?? "l") === sz ? "bg-brand text-white" : "text-slate-500 hover:bg-slate-200"}`}>{sz}</button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <span className="text-slate-400">Font</span>
            {([["sans", "Sans"], ["serif", "Serif"], ["mono", "Mono"]] as const).map(([f, lbl]) => (
              <button key={f} type="button" onClick={() => set({ font: f })} className={`rounded px-1.5 py-0.5 font-medium ${(st.font ?? "sans") === f ? "bg-brand text-white" : "text-slate-500 hover:bg-slate-200"} ${f === "serif" ? "font-serif" : f === "mono" ? "font-mono" : ""}`}>{lbl}</button>
            ))}
          </div>
          <label className="flex items-center gap-1 text-slate-400" title={colorLabel}>
            {colorLabel}
            <input type="color" value={st.color ?? "#0f172a"} onChange={(e) => set({ color: e.target.value })} className="h-5 w-6 cursor-pointer rounded border border-slate-300 bg-white p-0" />
            {st.color && <button type="button" onClick={() => { const { color: _c, ...rest } = st; onChange(rest); }} className="text-slate-400 hover:text-red-600" title="Reset color"><X className="h-3 w-3" /></button>}
          </label>
        </>
      )}
    </div>
  );
}
