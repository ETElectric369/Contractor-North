"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Eye, FileStack, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { type Block } from "@/lib/site-blocks";
import { isReservedSlug, slugifySiteSlug } from "@/lib/site-reserved";
import { BlockEditor } from "./block-editor";
import { saveSitePage, deleteSitePage } from "./pages-actions";

type PageRow = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  blocks: Block[];
  published: boolean;
  nav_label: string | null;
  seo_title: string | null;
};

type Draft = {
  id: string | null;
  slug: string;
  title: string;
  description: string;
  blocks: Block[];
  published: boolean;
  nav_label: string;
  seo_title: string;
};

const EMPTY: Draft = { id: null, slug: "", title: "", description: "", blocks: [], published: true, nav_label: "", seo_title: "" };

/** The page BUILDER — compose custom pages from a palette of styled blocks (shared <BlockEditor>).
 *  Owner (Settings) or a granted external designer (/content) uses the same editor; pages go live at
 *  /<slug> on the site. */
export function PagesManager({ initial, siteUrl, handle, orgId, brand = "#0f172a" }: { initial: PageRow[]; siteUrl: string | null; handle?: string | null; orgId?: string; brand?: string }) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<PageRow | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function openNew() { setError(null); setEditing({ ...EMPTY }); }
  function openEdit(p: PageRow) {
    setError(null);
    setEditing({ id: p.id, slug: p.slug, title: p.title, description: p.description ?? "", blocks: p.blocks ?? [], published: p.published, nav_label: p.nav_label ?? "", seo_title: p.seo_title ?? "" });
  }

  function save() {
    if (!editing) return;
    setError(null);
    // Pre-check the slug the ACTION will derive (same slugify), so a reserved address gets a
    // friendly explanation up front instead of only a server rejection.
    const slug = slugifySiteSlug(editing.slug || editing.title);
    if (isReservedSlug(slug)) {
      setError(
        slug === "home" || slug === "index" || slug === "homepage"
          ? `"/${slug}" can't be a page — your homepage already lives at "/". Edit it under Homepage sections instead.`
          : `"/${slug}" is part of your site itself (like /login or /blog), so a page can't live there. Pick a different web address.`,
      );
      return;
    }
    start(async () => {
      const res = await saveSitePage({
        id: editing.id, slug: editing.slug || null, title: editing.title, description: editing.description || null,
        blocks: editing.blocks, published: editing.published, nav_label: editing.nav_label || null,
        seo_title: editing.seo_title || null, orgId,
      });
      if (!res.ok) { setError(res.error ?? "Couldn't save the page."); return; }
      // Say what actually happened: an unpublished save is a draft, not a publish.
      toast(!editing.published ? "Draft saved" : editing.id ? "Page updated" : "Page published", "success");
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
      <p className="text-sm text-slate-500">Build extra pages for your site from a palette of sections — headings, text, images, buttons, galleries, banners. Each page goes live at its own web address.</p>

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
              {handle && !p.published && (
                // Draft preview goes through the APP host, not the org's domain: the editor's
                // session cookie lives here, and the org-host middleware strips /p/ URLs — on
                // the custom domain the gate would see an anonymous visitor and 404.
                <a href={`/site/${handle}/p/${p.slug}?preview=1`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md p-1.5 text-xs font-medium text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Preview the draft — only signed-in editors can see it">
                  <Eye className="h-4 w-4" /> <span className="hidden sm:inline">Preview draft</span>
                </a>
              )}
              <button type="button" onClick={() => openEdit(p)} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-brand" title="Edit"><Pencil className="h-4 w-4" /></button>
              <button type="button" onClick={() => setDeleting(p)} className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" title="Delete"><Trash2 className="h-4 w-4" /></button>
            </li>
          ))}
        </ul>
      )}

      <Button type="button" variant="outline" size="sm" onClick={openNew}><Plus className="h-4 w-4" /> New page</Button>

      {/* The save button promises only what the Published checkbox will deliver. */}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? "Edit page" : "New page"} size="xl"
        footer={<ModalActions onCancel={() => setEditing(null)} onSave={save} saving={pending} saveLabel={editing && !editing.published ? "Save draft" : editing?.id ? "Save page" : "Publish page"} />}>
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
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="pg-desc">Short description (for search results)</Label>
                <Input id="pg-desc" value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="pg-seo-title">Search title (blank = &quot;{editing.title || "Title"} — your business&quot;)</Label>
                <Input id="pg-seo-title" value={editing.seo_title} onChange={(e) => setEditing({ ...editing, seo_title: e.target.value })} placeholder="The title shown in Google results" />
              </div>
            </div>

            <BlockEditor
              blocks={editing.blocks}
              onChange={(blocks) => setEditing((e) => (e ? { ...e, blocks } : e))}
              brand={brand}
              orgId={orgId}
              previewTitle={editing.title}
            />

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
