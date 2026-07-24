"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Eye, FileText, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { formatDate } from "@/lib/utils";
import { ImageField } from "./block-editor";
import { saveSitePost, deleteSitePost } from "./posts-actions";

type PostRow = {
  id: string;
  path: string;
  title: string;
  description: string | null;
  cover_url: string | null;
  body_html: string;
  published: boolean;
  published_at: string;
  seo_title: string | null;
};

type Draft = {
  id: string | null;
  title: string;
  path: string;
  description: string;
  cover_url: string;
  body: string;
  published: boolean;
  /** YYYY-MM-DD shown in the date field; sent only when it differs from the stored date. */
  published_at: string;
  seo_title: string;
};

const EMPTY: Draft = { id: null, title: "", path: "", description: "", cover_url: "", body: "", published: true, published_at: "", seo_title: "" };

/** ISO timestamp → the YYYY-MM-DD the date input wants (UTC date — matches the noon-UTC storage). */
function isoToDateInput(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "";
}

/**
 * Articles on the public site — how SEO content gets published INTO North (the vendor writes,
 * this publishes). Each article lives at its web address on the org's domain; a migrated
 * article keeps its ORIGINAL address (e.g. blog-1-1/redwood) so Google's old index keeps landing.
 */
export function PostsManager({
  initial,
  siteUrl,
  handle,
  orgId,
}: {
  initial: PostRow[];
  siteUrl: string | null;
  /** public_handle — draft previews route through the app host (/site/<handle>/…) where the
      editor's session cookie lives. */
  handle?: string | null;
  /** Set only on the external-collaborator surface (/content) to name which org's site — staff
      leave it undefined and the action infers their own org. */
  orgId?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<PostRow | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function openNew() {
    setError(null);
    setEditing({ ...EMPTY });
  }
  function openEdit(p: PostRow) {
    setError(null);
    setEditing({
      id: p.id,
      title: p.title,
      path: p.path,
      description: p.description ?? "",
      cover_url: p.cover_url ?? "",
      body: p.body_html,
      published: p.published,
      published_at: isoToDateInput(p.published_at),
      seo_title: p.seo_title ?? "",
    });
  }

  function save() {
    if (!editing) return;
    setError(null);
    // Send the date only when the user actually changed it — an untouched field must not
    // re-stamp a live post's timestamp to noon.
    const originalDate = editing.id ? isoToDateInput(initial.find((p) => p.id === editing.id)?.published_at) : "";
    const dateChanged = editing.published_at !== originalDate;
    start(async () => {
      const res = await saveSitePost({
        id: editing.id,
        title: editing.title,
        path: editing.path || null,
        description: editing.description || null,
        cover_url: editing.cover_url.trim() || null,
        body: editing.body,
        published: editing.published,
        published_at: dateChanged && editing.published_at ? editing.published_at : null,
        seo_title: editing.seo_title || null,
        orgId,
      });
      if (!res.ok) { setError(res.error ?? "Couldn't save the article."); return; }
      // Say what actually happened: an unpublished save is a draft, not a publish.
      toast(!editing.published ? "Draft saved" : editing.id ? "Article updated" : "Article published", "success");
      setEditing(null);
      router.refresh();
    });
  }

  function confirmDelete() {
    const p = deleting;
    if (!p) return;
    setDeleting(null);
    start(async () => {
      const res = await deleteSitePost(p.id, orgId);
      if (!res.ok) { toast(res.error ?? "Couldn't delete.", "error"); return; }
      toast("Article deleted", "success");
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Articles and guides on your public site — the content search engines rank. Paste an article
        (text or HTML) from your SEO team and it publishes at its web address on your domain.
      </p>

      {initial.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-400">
          No articles yet.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          {initial.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-4 py-3">
              <FileText className="h-4 w-4 shrink-0 text-slate-400" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium text-slate-800">{p.title}</span>
                  {!p.published && <Badge tone="slate">draft</Badge>}
                </div>
                <div className="truncate text-xs text-slate-400">/{p.path} · {formatDate(p.published_at)}</div>
              </div>
              {siteUrl && p.published && (
                <a
                  href={`${siteUrl}/${p.path}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  title="View on your site"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              )}
              {handle && !p.published && (
                // Draft preview goes through the APP host, not the org's domain: the editor's
                // session cookie lives here — on the custom domain the gate would see an
                // anonymous visitor and 404.
                <a
                  href={`/site/${handle}/${p.path}?preview=1`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-md p-1.5 text-xs font-medium text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  title="Preview the draft at its web address — only you can see it"
                >
                  <Eye className="h-4 w-4" /> <span className="hidden sm:inline">Preview draft</span>
                </a>
              )}
              <button
                type="button"
                onClick={() => openEdit(p)}
                className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-brand"
                title="Edit"
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setDeleting(p)}
                className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                title="Delete"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <Button type="button" variant="outline" size="sm" onClick={openNew}>
        <Plus className="h-4 w-4" /> New article
      </Button>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? "Edit article" : "New article"}
        footer={
          <ModalActions
            onCancel={() => setEditing(null)}
            onSave={save}
            saving={pending}
            // The button promises only what the Published checkbox will deliver.
            saveLabel={editing && !editing.published ? "Save draft" : editing?.id ? "Save article" : "Publish article"}
          />
        }
      >
        {editing && (
          <div className="space-y-4">
            <div>
              <Label htmlFor="post-title">Title</Label>
              <Input
                id="post-title"
                value={editing.title}
                onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                placeholder="Choosing decking that survives Tahoe winters"
              />
            </div>
            <div>
              <Label htmlFor="post-path">Web address</Label>
              <Input
                id="post-path"
                value={editing.path}
                onChange={(e) => setEditing({ ...editing, path: e.target.value })}
                placeholder="blank = blog/from-the-title"
              />
              <p className="mt-1 text-xs text-slate-400">
                The address on your domain. Restoring an old article? Keep its original address
                (e.g. blog-1-1/redwood) so Google&apos;s existing link still lands.
              </p>
            </div>
            <div>
              <Label htmlFor="post-desc">Short description</Label>
              <Input
                id="post-desc"
                value={editing.description}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                placeholder="Shown in search results and on the articles page."
              />
            </div>
            <div>
              <Label htmlFor="post-seo-title">Search title (optional)</Label>
              <Input
                id="post-seo-title"
                value={editing.seo_title}
                onChange={(e) => setEditing({ ...editing, seo_title: e.target.value })}
                placeholder={`Blank = "${editing.title || "Title"} — your business name"`}
              />
              <p className="mt-1 text-xs text-slate-400">
                The title shown in Google results — your SEO team can tune it for keywords without
                changing the headline on the page.
              </p>
            </div>
            <div>
              <Label htmlFor="post-cover">Cover image</Label>
              <ImageField
                id="post-cover"
                value={editing.cover_url}
                onChange={(url) => setEditing({ ...editing, cover_url: url })}
                orgId={orgId}
                placeholder="https://… (shown on the article + as the social preview image)"
              />
            </div>
            <div>
              <Label htmlFor="post-body">Article</Label>
              <Textarea
                id="post-body"
                rows={12}
                value={editing.body}
                onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                placeholder="Paste the article — plain text or HTML both work."
              />
            </div>
            <div>
              <Label htmlFor="post-date">Publish date</Label>
              <Input
                id="post-date"
                type="date"
                value={editing.published_at}
                onChange={(e) => setEditing({ ...editing, published_at: e.target.value })}
                className="max-w-[12rem]"
              />
              <p className="mt-1 text-xs text-slate-400">
                Restoring a migrated article? Set its original date so it doesn&apos;t read as
                published today. Blank = automatic.
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={editing.published}
                onChange={(e) => setEditing({ ...editing, published: e.target.checked })}
                className="h-4 w-4 rounded border-slate-300 text-brand"
              />
              Published (visible on your site)
            </label>
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        )}
      </Modal>

      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete this article?"
        size="sm"
        footer={<ModalActions onCancel={() => setDeleting(null)} onSave={confirmDelete} saveLabel="Delete" destructive />}
      >
        <p className="text-sm text-slate-600">
          This permanently deletes <span className="font-medium text-slate-900">{deleting?.title}</span> from your
          site. Its web address will redirect to your homepage.
        </p>
      </Modal>
    </div>
  );
}
