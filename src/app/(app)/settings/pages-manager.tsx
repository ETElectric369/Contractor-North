"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowUp, Eye, ExternalLink, FileStack, Loader2, Pencil, Plus, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { BLOCK_PALETTE, type Block, type BlockStyle, type BlockType } from "@/lib/site-blocks";
import { BlockRenderer } from "@/app/site/block-renderer";
import { uploadSiteImage } from "@/lib/upload-site-image";
import { saveSitePage, deleteSitePage } from "./pages-actions";

type PageRow = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  blocks: Block[];
  published: boolean;
  nav_label: string | null;
};

type Draft = {
  id: string | null;
  slug: string;
  title: string;
  description: string;
  blocks: Block[];
  published: boolean;
  nav_label: string;
};

const EMPTY: Draft = { id: null, slug: "", title: "", description: "", blocks: [], published: true, nav_label: "" };

/** The page BUILDER — compose custom pages from a palette of blocks. Owner (Settings) or a granted
 *  external designer (/content) uses the same editor; pages go live at /p/<slug> on the site. */
export function PagesManager({ initial, siteUrl, orgId, brand = "#0f172a" }: { initial: PageRow[]; siteUrl: string | null; orgId?: string; brand?: string }) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<PageRow | null>(null);
  const [preview, setPreview] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function openNew() { setError(null); setPreview(false); setEditing({ ...EMPTY }); }
  function openEdit(p: PageRow) {
    setError(null);
    setPreview(false);
    setEditing({ id: p.id, slug: p.slug, title: p.title, description: p.description ?? "", blocks: p.blocks ?? [], published: p.published, nav_label: p.nav_label ?? "" });
  }

  const setBlocks = (fn: (b: Block[]) => Block[]) => setEditing((e) => (e ? { ...e, blocks: fn(e.blocks) } : e));
  const updateBlock = (i: number, props: Record<string, unknown>) =>
    setBlocks((bs) => bs.map((b, j) => (j === i ? ({ ...b, props: { ...b.props, ...props } } as Block) : b)));
  const updateStyle = (i: number, style: BlockStyle) =>
    setBlocks((bs) => bs.map((b, j) => (j === i ? ({ ...b, style } as Block) : b)));
  const move = (i: number, d: -1 | 1) =>
    setBlocks((bs) => { const n = [...bs]; const t = i + d; if (t < 0 || t >= n.length) return bs; [n[i], n[t]] = [n[t], n[i]]; return n; });
  const addBlock = (t: BlockType) => setBlocks((bs) => [...bs, BLOCK_PALETTE.find((p) => p.type === t)!.make()]);

  function save() {
    if (!editing) return;
    setError(null);
    start(async () => {
      const res = await saveSitePage({
        id: editing.id, slug: editing.slug || null, title: editing.title, description: editing.description || null,
        blocks: editing.blocks, published: editing.published, nav_label: editing.nav_label || null, orgId,
      });
      if (!res.ok) { setError(res.error ?? "Couldn't save the page."); return; }
      toast(editing.id ? "Page updated" : "Page published", "success");
      setEditing(null);
      router.refresh();
    });
  }
  function confirmDelete() {
    const p = deleting; if (!p) return; setDeleting(null);
    start(async () => {
      const res = await deleteSitePage(p.id, orgId);
      if (!res.ok) { toast(res.error ?? "Couldn't delete.", "error"); return; }
      toast("Page deleted", "success"); router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">Build extra pages for your site from a palette of sections — headings, text, images, buttons, galleries. Each page goes live at its own web address.</p>

      {initial.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          {initial.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-4 py-3">
              <FileStack className="h-4 w-4 shrink-0 text-slate-400" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium text-slate-800">{p.title}</span>
                  {!p.published && <Badge tone="slate">draft</Badge>}
                  {p.nav_label && <Badge tone="blue">in menu</Badge>}
                </div>
                <div className="truncate text-xs text-slate-400">/{p.slug} · {p.blocks.length} block{p.blocks.length === 1 ? "" : "s"}</div>
              </div>
              {siteUrl && p.published && (
                <a href={`${siteUrl}/${p.slug}`} target="_blank" rel="noreferrer" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="View">
                  <ExternalLink className="h-4 w-4" />
                </a>
              )}
              <button type="button" onClick={() => openEdit(p)} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-brand" title="Edit"><Pencil className="h-4 w-4" /></button>
              <button type="button" onClick={() => setDeleting(p)} className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" title="Delete"><Trash2 className="h-4 w-4" /></button>
            </li>
          ))}
        </ul>
      )}

      <Button type="button" variant="outline" size="sm" onClick={openNew}><Plus className="h-4 w-4" /> New page</Button>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? "Edit page" : "New page"} size="xl"
        footer={<ModalActions onCancel={() => setEditing(null)} onSave={save} saving={pending} saveLabel={editing?.id ? "Save page" : "Publish page"} />}>
        {editing && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="pg-title">Page title</Label>
                <Input id="pg-title" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} placeholder="e.g. Custom Lighting" />
              </div>
              <div>
                <Label htmlFor="pg-slug">Web address (yoursite.com/…)</Label>
                <Input id="pg-slug" value={editing.slug} onChange={(e) => setEditing({ ...editing, slug: e.target.value })} placeholder="blank = from the title" />
              </div>
            </div>
            <div>
              <Label htmlFor="pg-desc">Short description (for search results)</Label>
              <Input id="pg-desc" value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </div>

            {/* Blocks */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="mb-0">Sections</Label>
                {editing.blocks.length > 0 && (
                  <button type="button" onClick={() => setPreview((v) => !v)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">
                    {preview ? <><Pencil className="h-3.5 w-3.5" /> Back to editing</> : <><Eye className="h-3.5 w-3.5" /> Preview</>}
                  </button>
                )}
              </div>

              {preview ? (
                <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                  <div className="border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-400">Live preview — how this page looks on your site</div>
                  <div className="max-h-[58vh] overflow-y-auto">
                    {editing.title && <h1 className="mx-auto max-w-3xl px-4 pt-8 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">{editing.title}</h1>}
                    <BlockRenderer blocks={editing.blocks} brand={brand} />
                  </div>
                </div>
              ) : (
                <>
                  {editing.blocks.length === 0 && <p className="rounded-lg border border-dashed border-slate-300 px-4 py-5 text-center text-sm text-slate-400">No sections yet — add one below.</p>}
                  {editing.blocks.map((b, i) => (
                    <div key={i} className="rounded-xl border border-slate-200 p-3">
                      <div className="mb-2 flex items-center gap-2">
                        <Badge tone="slate">{BLOCK_PALETTE.find((p) => p.type === b.type)?.label ?? b.type}</Badge>
                        <div className="ml-auto flex items-center gap-0.5">
                          <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
                          <button type="button" onClick={() => move(i, 1)} disabled={i === editing.blocks.length - 1} className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button>
                          <button type="button" onClick={() => setBlocks((bs) => bs.filter((_, j) => j !== i))} className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"><X className="h-4 w-4" /></button>
                        </div>
                      </div>
                      <BlockFields block={b} orgId={orgId} onChange={(props) => updateBlock(i, props)} />
                      <StyleToolbar block={b} onChange={(style) => updateStyle(i, style)} />
                    </div>
                  ))}
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {BLOCK_PALETTE.map((p) => (
                      <button key={p.type} type="button" onClick={() => addBlock(p.type)} title={p.hint}
                        className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200">
                        <Plus className="h-3.5 w-3.5" /> {p.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="grid gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="pg-nav">Menu label (blank = not in the menu)</Label>
                <Input id="pg-nav" value={editing.nav_label} onChange={(e) => setEditing({ ...editing, nav_label: e.target.value })} placeholder="e.g. Lighting" />
              </div>
              <label className="mt-6 flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={editing.published} onChange={(e) => setEditing({ ...editing, published: e.target.checked })} className="h-4 w-4 rounded border-slate-300 text-brand" />
                Published
              </label>
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        )}
      </Modal>

      <Modal open={!!deleting} onClose={() => setDeleting(null)} title="Delete this page?" size="sm"
        footer={<ModalActions onCancel={() => setDeleting(null)} onSave={confirmDelete} saveLabel="Delete" destructive />}>
        <p className="text-sm text-slate-600">This permanently deletes <span className="font-medium text-slate-900">{deleting?.title}</span>.</p>
      </Modal>
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
    return <GalleryFields urls={block.props.images.map((im) => im.url)} orgId={orgId} onChange={(urls) => onChange({ images: urls.map((url) => ({ url })) })} />;
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
 *  (the storage path is org-scoped); without it, URL-paste still works. */
function ImageField({ value, onChange, orgId, placeholder }: { value: string; onChange: (url: string) => void; orgId?: string; placeholder?: string }) {
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
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
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

/** The styling "toolbox" for one block — alignment, size, font, and color, all safe/structured.
 *  Gallery has nothing to style; image only aligns its caption. */
function StyleToolbar({ block, onChange }: { block: Block; onChange: (style: BlockStyle) => void }) {
  if (block.type === "gallery") return null;
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
      {/* Align — every styleable block except banner (centered) */}
      {showAlign && (
        <div className="flex items-center gap-0.5">
          <IconBtn on={(st.align ?? "left") === "left"} onClick={() => set({ align: "left" })} title="Left"><AlignLeft className="h-3.5 w-3.5" /></IconBtn>
          <IconBtn on={st.align === "center"} onClick={() => set({ align: "center" })} title="Center"><AlignCenter className="h-3.5 w-3.5" /></IconBtn>
          <IconBtn on={st.align === "right"} onClick={() => set({ align: "right" })} title="Right"><AlignRight className="h-3.5 w-3.5" /></IconBtn>
        </div>
      )}

      {full && (
        <>
          {/* Size */}
          <div className="flex items-center gap-1">
            <span className="text-slate-400">Size</span>
            {(["s", "m", "l", "xl"] as const).map((sz) => (
              <button key={sz} type="button" onClick={() => set({ size: sz })} className={`rounded px-1.5 py-0.5 font-semibold uppercase ${(st.size ?? "l") === sz ? "bg-brand text-white" : "text-slate-500 hover:bg-slate-200"}`}>{sz}</button>
            ))}
          </div>
          {/* Font */}
          <div className="flex items-center gap-1">
            <span className="text-slate-400">Font</span>
            {([["sans", "Sans"], ["serif", "Serif"], ["mono", "Mono"]] as const).map(([f, lbl]) => (
              <button key={f} type="button" onClick={() => set({ font: f })} className={`rounded px-1.5 py-0.5 font-medium ${(st.font ?? "sans") === f ? "bg-brand text-white" : "text-slate-500 hover:bg-slate-200"} ${f === "serif" ? "font-serif" : f === "mono" ? "font-mono" : ""}`}>{lbl}</button>
            ))}
          </div>
          {/* Color */}
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

function GalleryFields({ urls, orgId, onChange }: { urls: string[]; orgId?: string; onChange: (urls: string[]) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (!files.length || !orgId) return;
    setBusy(true);
    try {
      const added: string[] = [];
      for (const f of files) added.push(await uploadSiteImage(orgId, f));
      onChange([...urls, ...added]);
    } catch {
      /* per-file failure surfaces nothing here; the row inputs still let them paste a URL */
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  }
  return (
    <div className="space-y-2">
      {urls.map((u, i) => (
        <div key={i} className="flex gap-2">
          <Input value={u} onChange={(e) => onChange(urls.map((x, j) => (j === i ? e.target.value : x)))} placeholder="Image URL" />
          <button type="button" onClick={() => onChange(urls.filter((_, j) => j !== i))} className="rounded-md p-2 text-slate-400 hover:text-red-600"><X className="h-4 w-4" /></button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => onChange([...urls, ""])} className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200"><Plus className="h-3.5 w-3.5" /> Add URL</button>
        {orgId && (
          <>
            <input ref={ref} type="file" accept="image/*" multiple className="hidden" onChange={onFiles} />
            <button type="button" onClick={() => ref.current?.click()} disabled={busy} className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200 disabled:opacity-50">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Upload photos
            </button>
          </>
        )}
      </div>
    </div>
  );
}
