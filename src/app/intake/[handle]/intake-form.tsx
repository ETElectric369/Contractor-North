"use client";

import { useMemo, useState, useTransition } from "react";
import { DropTarget } from "@/components/drop-target";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { mirrorAnswers, mirrorValue, siteAddressWhens } from "@/lib/playbook/address-mirror";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { INTAKE_BUCKET, MAX_UPLOAD_MB, isAllowedUpload, uploadAccept, uploadDisplayName } from "@/lib/playbook/uploads";
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

/**
 * CITY / STATE / ZIP, VISIBLE AND HIS OWN TO TYPE.
 *
 * Andrew asked for this three times across four days ("break out the residential address to have
 * all the fields associated"), which read as a conflict with 0177's law — "a guessed city is worse
 * than a blank one; city/state/zip are filled ONLY by the picker." It is not a conflict. 0177
 * forbids the APP inventing parts by parsing a typed blob. A customer typing their own city into a
 * CITY BOX is not a guess — it is the first-party answer, from the one person who cannot be wrong
 * about where they live. What the law actually bought was refusing to DERIVE; showing three boxes
 * the picker fills (and a person can correct) keeps that entirely.
 *
 * It also closes the silent case the hidden columns created: type an address WITHOUT picking a
 * suggestion and the parts stayed empty forever, invisibly — the lead arrived with a street and no
 * town, and nobody on either side could see that it had. Now the blanks are on screen, where a
 * person fills them without being asked.
 */
function AddressParts({
  value,
  onChange,
}: {
  value: { city: string; state: string; zip: string };
  onChange: (patch: Partial<{ city: string; state: string; zip: string }>) => void;
}) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div className="col-span-2">
        <Input placeholder="City" autoComplete="address-level2" value={value.city} onChange={(e) => onChange({ city: e.target.value })} />
      </div>
      <Input placeholder="State" autoComplete="address-level1" maxLength={2} value={value.state} onChange={(e) => onChange({ state: e.target.value.toUpperCase() })} />
      <Input placeholder="ZIP" autoComplete="postal-code" inputMode="numeric" value={value.zip} onChange={(e) => onChange({ zip: e.target.value })} />
    </div>
  );
}

export function IntakeForm({ handle, needs, orgName }: { handle: string; needs: PublicNeed[]; orgName: string }) {
  // city/state/zip are filled by the picker AND visible/typable (see AddressParts) — 0177's law
  // forbids the app DERIVING them from a typed blob, not the customer stating them.
  const [contact, setContact] = useState({ name: "", phone: "", email: "", address: "", city: "", state: "", zip: "" });
  // THE SECOND ADDRESS (0189). `contact.address` is where the PERSON is; this is where the WORK is,
  // and it is the one that becomes the job. Ticked by default so a residential service call is
  // still one address typed once — which is every lead ET Electric and TAHOE DECK have ever had.
  // UNCHECKED BY DEFAULT (Erik, after the mirror shipped): a builder's lead is usually a
  // project that is NOT at home, so the project-address block shows first and the tick is
  // the shortcut for when they are the same place.
  const [siteSame, setSiteSame] = useState(false);
  const [site, setSite] = useState({ address: "", city: "", state: "", zip: "" });
  const [answers, setAnswers] = useState<Answers>({});
  const [hp, setHp] = useState(""); // honeypot — hidden from people, filled by bots
  // Which questions the customer has opened "Something else" on. Only tracks the EMPTY in-between —
  // once there's text, the answer itself carries it and survives a re-render.
  const [otherOpen, setOtherOpen] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const pb = useMemo(() => ({ needs: needs as Need[] }), [needs]);

  // ── THE FORM OWNS THE PROJECT ADDRESS (Erik: "it shouldnt pop up if the box is checked —
  // it should autopopulate … and display it uneditable"). A playbook question that IS the
  // project address (or its City/State/Zip riding the same trigger) renders as a read-only
  // mirror of the form's own value instead of a second empty box. See address-mirror.ts.
  const effSite = siteSame ? { address: contact.address, city: contact.city, state: contact.state, zip: contact.zip } : site;
  const mirrorWhens = useMemo(() => siteAddressWhens(needs as Need[]), [needs]);
  const mirrorOf = (n: Need) => mirrorValue(n, mirrorWhens, effSite);
  // The when-engine sees mirrored answers LIVE (audit 7): a question gated on "project address
  // known" was unreachable — the mirror only landed values at submit, so its dependents never
  // rendered and the server then cleared whatever the customer had typed into them.
  const effAnswers = useMemo(
    () => ({ ...answers, ...mirrorAnswers(needs as Need[], effSite) }),
    [answers, needs, effSite.address, effSite.city, effSite.state, effSite.zip],
  );
  const visible = useMemo(() => applicableNeeds(pb, effAnswers), [pb, effAnswers]);

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
          // ── ONE BAR OF LTE MUST NOT DESTROY THE LEAD (audit 6) ────────────────────────────
          //
          // A homeowner fills in their name, phone, email, address, every playbook answer and two
          // uploaded photos, then taps Send with one bar. The server action rejected at the
          // network layer, and the unhandled rejection took the whole page to the error boundary —
          // which on this route showed a stranger a link to the CONTRACTOR'S LOGIN. Every answer
          // gone, and the contractor never learns the lead existed.
          //
          // Now the form stays exactly as they filled it, says so in their language, and the same
          // Send button retries. The uploads already happened, so nothing is re-uploaded.
          let r: Awaited<ReturnType<typeof submitIntake>>;
          try {
            r = await submitIntake(handle, {
              hp,
              contact,
              site: siteSame ? null : site,
              // Mirrored address questions land their values here — the mirror WINS over
              // anything typed into those keys before the tick was flipped.
              answers: { ...answers, ...mirrorAnswers(needs as Need[], effSite) },
            });
          } catch {
            return setErr("That didn't send — check your connection and tap Send again. Nothing you typed is lost.");
          }
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
          <Label className="mb-1.5">Home address</Label>
          {/* THE ONE LEAD-CAPTURE SURFACE THAT NEVER GOT THE PICKER. Andrew asked for address
              autocomplete here, and every sibling already had it — inquire/[org], the job form,
              the inspector, the lead form, the CRM. This door, the one on his actual website, was
              a plain box. It is also the single most valuable place for it: a stranger typing
              their own address is the very start of the chain Erik means by "the right address
              from the start", and everything downstream inherits whatever lands here.
              streetOnly, so the box holds a street and the resolved parts ride their own columns
              instead of being mashed into one blob. */}
          <AddressAutocomplete
            streetOnly
            placeholder="Street address"
            defaultValue={contact.address}
            onTextChange={(v) => setContact((c) => ({ ...c, address: v }))}
            onResolved={(p) =>
              setContact((c) => ({ ...c, address: p.line1 || c.address, city: p.city ?? "", state: p.state ?? "", zip: p.zip ?? "" }))
            }
          />
          <AddressParts value={contact} onChange={(patch) => setContact((c) => ({ ...c, ...patch }))} />
        </div>
      </div>

      {/* ── WHERE THE WORK IS ─────────────────────────────────────────────────────────────────
          Andrew: "the top box with the customer info … to say home address then the project is
          the project." A general contractor's lead lives in a house that already exists and is
          building on a lot that does not, so one address could never be both. The tick keeps the
          old behaviour for everybody else: leave it on and the site IS the home address, which is
          one box typed once, exactly as this form worked before. */}
      <div className="rounded-xl border border-slate-200 p-4">
        <label className="flex min-h-[44px] items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={siteSame}
            onChange={(e) => {
              setSiteSame(e.target.checked);
              if (e.target.checked) setSite({ address: "", city: "", state: "", zip: "" });
            }}
          />
          The project address is the same as my home address
        </label>
        {!siteSame && (
          <div className="mt-3">
            <Label className="mb-1.5">Project address</Label>
            <AddressAutocomplete
              streetOnly
              placeholder="Where the work happens"
              defaultValue={site.address}
              onTextChange={(v) => setSite((x) => ({ ...x, address: v }))}
              onResolved={(p) =>
                setSite((x) => ({ address: p.line1 || x.address, city: p.city ?? "", state: p.state ?? "", zip: p.zip ?? "" }))
              }
            />
            <AddressParts value={site} onChange={(patch) => setSite((x) => ({ ...x, ...patch }))} />
          </div>
        )}
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

      {visible.map((n) => {
        const mv = mirrorOf(n);
        return (
        <div key={n.key}>
          <Label className="mb-1.5">{n.ask}</Label>
          {mv !== null ? (
            // A mirrored address question — shown, never typed into. Empty until the address
            // above is, then it fills itself; the value rides into the answers at submit.
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700">
              {mv.trim() ? mv : <span className="text-slate-400">Fills in from the address above</span>}
            </p>
          ) : n.slot?.type === "file" ? (
            <DropTarget
              onFiles={(files) => void addFiles(n.key, files)}
              accept={uploadAccept(n.slot.accept).attr}
              multiple={n.slot.multi !== false}
              className="rounded-lg border border-dashed border-slate-300 p-3"
            >
              <input
                type="file"
                multiple={n.slot.multi !== false}
                accept={uploadAccept(n.slot.accept).attr}
                disabled={busyKey === n.key}
                onChange={(e) => {
                  void addFiles(n.key, Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
                className="block w-full text-sm text-slate-600 file:mr-3 file:min-h-[40px] file:rounded-full file:border-0 file:bg-slate-900 file:px-4 file:text-sm file:text-white"
              />
              <p className="mt-1.5 text-xs text-slate-500">
                {busyKey === n.key ? "Uploading…" : `${uploadAccept(n.slot.type === "file" ? n.slot.accept : undefined).hint} — up to ${MAX_UPLOAD_MB}MB each.`}
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
            </DropTarget>
          ) : n.slot?.type === "select" ? (
            n.slot.multi ? (
              // PICK SEVERAL — AND SAY THE THING NOBODY LISTED (cn-v698).
              //
              // `other` was read only in the single branch below, so a contractor who ticked
              // "Let me write my own answer too" on a many-choice question got a checkbox that
              // did nothing on the one surface it mattered most: the public door, where the
              // person answering is a CUSTOMER who cannot ask anybody what the chips mean. The
              // free value is derived from the ANSWER, never local state, exactly as the
              // inspector does it — a half-typed sentence has to survive a re-render.
              (() => {
                const cur = Array.isArray(answers[n.key]) ? (answers[n.key] as string[]) : [];
                const options = (n.slot as { options: string[] }).options;
                const other = (n.slot as { other?: boolean }).other;
                const listed = cur.filter((x) => options.includes(x));
                const free = cur.find((x) => !options.includes(x)) ?? "";
                const showOther = !!other && (!!free || otherOpen.includes(n.key));
                const put = (opts: string[], text: string) => {
                  const all = text.trim() ? [...opts, text] : opts;
                  set(n.key, all.length ? all : null);
                };
                return (
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-2">
                      {options.map((o) => {
                        const on = listed.includes(o);
                        return (
                          <button
                            key={o}
                            type="button"
                            onClick={() => put(on ? listed.filter((x) => x !== o) : [...listed, o], free)}
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
                      {other && (
                        <button
                          type="button"
                          onClick={() => {
                            if (showOther) {
                              put(listed, "");
                              setOtherOpen((k) => k.filter((x) => x !== n.key));
                            } else setOtherOpen((k) => [...k, n.key]);
                          }}
                          className={
                            showOther
                              ? "min-h-[40px] rounded-full border border-slate-900 bg-slate-900 px-4 text-sm text-white"
                              : "min-h-[40px] rounded-full border border-dashed border-slate-400 bg-white px-4 text-sm text-slate-600"
                          }
                        >
                          Something else
                        </button>
                      )}
                    </div>
                    {showOther && (
                      <Input
                        placeholder="In your own words"
                        value={free}
                        onChange={(e) => put(listed, e.target.value)}
                      />
                    )}
                  </div>
                );
              })()
            ) : (
              (() => {
                const cur = typeof answers[n.key] === "string" ? (answers[n.key] as string) : "";
                const listed = n.slot!.type === "select" && (n.slot as { options: string[] }).options.includes(cur);
                const other = (n.slot as { other?: boolean }).other;
                // Open when he's typed something unlisted, or when he asked for the box. Derived
                // from the ANSWER first so a half-written sentence survives a re-render.
                const showOther = !!other && ((!!cur && !listed) || otherOpen.includes(n.key));
                return (
                  <div className="space-y-2">
                    <Select
                      value={showOther ? "__other" : listed ? cur : ""}
                      onChange={(e) => {
                        if (e.target.value === "__other") {
                          setOtherOpen((k) => [...k, n.key]);
                          set(n.key, null);
                        } else {
                          setOtherOpen((k) => k.filter((x) => x !== n.key));
                          set(n.key, e.target.value || null);
                        }
                      }}
                    >
                      <option value="">Choose…</option>
                      {(n.slot as { options: string[] }).options.map((o) => (
                        <option key={o} value={o}>{o}</option>
                      ))}
                      {other && <option value="__other">Something else…</option>}
                    </Select>
                    {showOther && (
                      <Input
                        placeholder="In your own words"
                        value={listed ? "" : cur}
                        onChange={(e) => set(n.key, e.target.value || null)}
                      />
                    )}
                  </div>
                );
              })()
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
        );
      })}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? <><Loader2 className="h-4 w-4 animate-spin" /> Sending…</> : "Send it"}
        </Button>
        {err && <span className="text-sm text-rose-600">{err}</span>}
      </div>
    </form>
  );
}
