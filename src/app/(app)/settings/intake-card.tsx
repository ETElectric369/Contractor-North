"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Copy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setPublicIntake } from "./intake-actions";

/**
 * THE INTAKE DOOR'S SWITCH — Settings → Website. Every token portal needs three things from day
 * one: an on/off, a place to SEE it exists, and the link itself. This card is all three.
 *
 * The link is what goes on the org's own website (Justin's Wix "Request an estimate" button, a QR
 * on the truck): a customer answers the org's customer-facing questions and lands on the Leads
 * board, triaged and notified, with their answers on the row.
 */
const embedSnippet = (url: string) =>
  `<iframe src="${url}?embed=1" title="Request an estimate" style="width:100%;border:0;min-height:820px"></iframe>`;

export function IntakeCard({
  on,
  url,
  live,
}: {
  on: boolean;
  url: string | null;
  /** The form the door actually serves, if there is one. See the block below. */
  live?: { id: string; name: string; count: number };
}) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<"link" | "embed" | null>(null);
  const copy = (text: string, which: "link" | "embed") =>
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    });
  const [pending, start] = useTransition();

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        A public &ldquo;request an estimate&rdquo; page — put the link on your website or a QR code.
        Customers answer a few questions you control and land on your Leads board with everything
        they said. The questions live in the <strong className="font-medium">Customer intake</strong>{" "}
        form under Playbook once it&rsquo;s on. While it&rsquo;s on, the estimate buttons on your
        hosted website send people here too; switch it off and they fall back to the contact form.
      </p>
      {on && url ? (
        <div className="space-y-2">
          {/* WHICH FORM IS ON THE OTHER END OF THIS LINK.
              The card printed a URL and never said what it served, so there was no way to check
              the form against the editor — and when the two disagreed, the only available reading
              was "the website is broken". That is exactly what Andrew reported. It names the form,
              counts its questions and links straight into that form in the editor. */}
          {live ? (
            <p className="text-sm text-slate-600">
              This link serves <strong className="font-medium">{live.name}</strong> &mdash;{" "}
              {live.count} question{live.count === 1 ? "" : "s"}.{" "}
              <Link href={`/settings?tab=playbook&form=${live.id}`} className="font-medium text-slate-900 underline underline-offset-2">
                Edit these questions
              </Link>
            </p>
          ) : (
            <p className="text-sm text-amber-700">
              The door is on but no form is flagged for it &mdash; customers will see nothing. Switch it
              off and on again to seed one.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <code className="max-w-full overflow-x-auto rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">{url}</code>
            <Button type="button" size="sm" variant="secondary" onClick={() => copy(url, "link")}>
              <Copy className="h-4 w-4" /> {copied === "link" ? "Copied" : "Copy Link"}
            </Button>
          </div>
          {/* THE EMBED — paste into Wix (Add → Embed → Embed a site) or any site builder's HTML
              block. ?embed=1 drops our header so their page's branding carries it. */}
          <div className="flex flex-wrap items-center gap-2">
            <code className="max-w-full overflow-x-auto whitespace-nowrap rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">{embedSnippet(url)}</code>
            <Button type="button" size="sm" variant="secondary" onClick={() => copy(embedSnippet(url), "embed")}>
              <Copy className="h-4 w-4" /> {copied === "embed" ? "Copied" : "Copy Embed Code"}
            </Button>
          </div>
          <p className="text-xs text-slate-500">
            The first is a plain link for a button or QR. The second embeds the form inside a page
            on your own site — in Wix: Add &rarr; Embed &rarr; Embed a site; in Squarespace: edit a
            page &rarr; Add Block &rarr; Code — then paste the code.
          </p>
        </div>
      ) : null}
      {on && !url ? (
        <p className="text-sm text-amber-700">
          Set your public handle above first — the link needs it for the address.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant={on ? "secondary" : "primary"}
          disabled={pending}
          onClick={() =>
            start(async () => {
              setErr(null);
              const r = await setPublicIntake(!on);
              if (!r.ok) return setErr(r.error);
              router.refresh();
            })
          }
        >
          {pending ? <><Loader2 className="h-4 w-4 animate-spin" /> …</> : on ? "Turn It Off" : "Turn It On"}
        </Button>
        {err && <span className="text-sm text-rose-600">{err}</span>}
      </div>
    </div>
  );
}
