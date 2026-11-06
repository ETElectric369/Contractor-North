"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BookUser, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Label, Select } from "@/components/ui/input";
import { bulkImportCustomers, type CustomerImportRow } from "./actions";
import { parseCSV } from "@/lib/csv";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";

/** Parse vCards (iPhone/iCloud contact exports) into import rows. */
function parseVCF(text: string): CustomerImportRow[] {
  const cards = text.split(/BEGIN:VCARD/i).slice(1);
  const unfold = (s: string) => s.replace(/\r?\n[ \t]/g, ""); // RFC line folding
  return cards
    .map((raw) => {
      const lines = unfold(raw).split(/\r?\n/);
      const get = (prefix: RegExp) => {
        const l = lines.find((x) => prefix.test(x));
        return l ? l.slice(l.indexOf(":") + 1).trim() : "";
      };
      const name = get(/^FN[:;]/i) || get(/^N[:;]/i).split(";").reverse().filter(Boolean).join(" ");
      const adr = get(/^ADR[:;]/i).split(";"); // ;;street;city;state;zip;country
      return {
        name,
        company_name: get(/^ORG[:;]/i).replace(/;+$/, ""),
        phone: get(/^TEL[:;]/i),
        email: get(/^EMAIL[:;]/i),
        address: adr[2] ?? "",
        city: adr[3] ?? "",
        state: adr[4] ?? "",
        zip: adr[5] ?? "",
      };
    })
    .filter((r) => r.name);
}

// `label` is the column map's word in the reader's language (lib/words/customers cu_…).
const FIELDS: { key: keyof CustomerImportRow; label: string; match: RegExp }[] = [
  { key: "name", label: "cu_nameRequired", match: /^name$|full.?name|contact|first/i },
  { key: "company_name", label: "cu_company", match: /company|business|organization/i },
  { key: "email", label: "cu_email", match: /e-?mail/i },
  { key: "phone", label: "cu_phone", match: /phone|mobile|cell|tel/i },
  { key: "address", label: "cu_address", match: /address|street/i },
  { key: "city", label: "cu_city", match: /city|town/i },
  { key: "state", label: "cu_state", match: /state|province/i },
  { key: "zip", label: "cu_zip", match: /zip|postal/i },
  { key: "notes", label: "cu_notes", match: /note|comment|memo/i },
];

/** Import for the customer book. `csv` mode (Settings) takes a CSV with column
 *  mapping or a vCard; otherwise (CRM) it's a single-contact vCard import. */
/** The phone's own address book, where the platform offers it (iOS Safari / Android Chrome).
 *  Non-standard API, so everything is feature-detected and cast — absence just means the CSV
 *  door stays primary, which is right for a desktop anyway. */
type PickedContact = {
  name?: string[];
  tel?: string[];
  email?: string[];
  address?: { addressLine?: string[]; city?: string; region?: string; postalCode?: string }[];
};

export function ImportCustomersButton({ csv = true, label }: { csv?: boolean; label?: string }) {
  const router = useRouter();
  const t = translator(useLang());
  /** "Imported 3 contacts (1 duplicates skipped)." — the count's pair, the skipped tail when any. */
  const counted = (one: string, many: string, n: number, tailKey: string, tail?: number) =>
    fillText(t(n === 1 ? one : many), { n: String(n), skipped: tail ? ` ${fillText(t(tailKey), { n: String(tail) })}` : "" });
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [headers, setHeaders] = useState<string[]>([]);
  const [dataRows, setDataRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function runVcfImport(rows: CustomerImportRow[]) {
    start(async () => {
      const res = await bulkImportCustomers(rows);
      setMsg(
        res.ok
          ? counted("cu_importedContactsOne", "cu_importedContactsMany", res.imported ?? 0, "cu_dupesSkipped", res.skipped)
          : res.error ?? t("cu_importFailed"),
      );
      setOpen(true);
      router.refresh();
    });
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");

      // iPhone "Share Contact" / iCloud exports arrive as vCards.
      if (/^BEGIN:VCARD/im.test(text) || f.name.toLowerCase().endsWith(".vcf")) {
        const rows = parseVCF(text);
        if (!rows.length) {
          setMsg(t("cu_noContactsInVcard"));
          setOpen(true);
          return;
        }
        setHeaders([]);
        runVcfImport(rows);
        return;
      }

      if (!csv) {
        setMsg(t("cu_csvGoToSettings"));
        setOpen(true);
        return;
      }
      const rows = parseCSV(text);
      if (rows.length < 2) {
        setMsg(t("cu_csvNeedsRows"));
        setOpen(true);
        return;
      }
      const hdr = rows[0];
      const auto: Record<string, number> = {};
      for (const f of FIELDS) {
        const idx = hdr.findIndex((h) => f.match.test(h));
        if (idx >= 0) auto[f.key] = idx;
      }
      setHeaders(hdr);
      setDataRows(rows.slice(1));
      setMapping(auto);
      setMsg(null);
      setOpen(true);
    };
    reader.readAsText(f);
  }

  /* A CONTACT PICKER, NOT A SPREADSHEET RITUAL. Erik, on his phone: "it still has that archaic
     import from csv big box... it should be a contact picker." On iOS Safari and Android Chrome
     the platform HAS one — navigator.contacts.select opens the phone's real address book, he taps
     the people, and they land as customers through the same bulk importer (dedupe included). CSV
     stays for the desktop and the platforms without the API. */
  const [hasPicker, setHasPicker] = useState(false);
  useEffect(() => {
    const nav = navigator as unknown as { contacts?: { select?: unknown } };
    setHasPicker(!!nav.contacts && typeof nav.contacts.select === "function");
  }, []);

  function pickFromPhone() {
    start(async () => {
      setMsg(null);
      let picked: PickedContact[] = [];
      try {
        const nav = navigator as unknown as {
          contacts: { select: (props: string[], opts: { multiple: boolean }) => Promise<PickedContact[]> };
        };
        // `address` isn't supported everywhere — ask for it, fall back without it.
        try {
          picked = await nav.contacts.select(["name", "tel", "email", "address"], { multiple: true });
        } catch {
          picked = await nav.contacts.select(["name", "tel", "email"], { multiple: true });
        }
      } catch {
        return; // he closed the sheet — not an error, nothing to say
      }
      if (!picked.length) return;
      const rows: CustomerImportRow[] = picked
        .map((c) => {
          const adr = c.address?.[0];
          return {
            name: c.name?.[0] ?? "",
            company_name: "",
            email: c.email?.[0] ?? "",
            phone: c.tel?.[0] ?? "",
            address: adr?.addressLine?.join(" ") ?? "",
            city: adr?.city ?? "",
            state: adr?.region ?? "",
            zip: adr?.postalCode ?? "",
            notes: "",
          };
        })
        .filter((r) => r.name || r.phone);
      if (!rows.length) { setMsg(t("cu_pickedNoName")); return; }
      const res = await bulkImportCustomers(rows);
      if (!res.ok) return setMsg(res.error ?? t("cu_importFailed"));
      setMsg(fillText(t("cu_addedFromContacts"), { n: String(res.imported), skipped: res.skipped ? ` ${fillText(t("cu_alreadyInBook"), { n: String(res.skipped) })}` : "" }));
      router.refresh();
    });
  }

  function runImport() {
    if (mapping.name === undefined) {
      setMsg(t("cu_mapNameFirst"));
      return;
    }
    setMsg(null);
    start(async () => {
      const rows: CustomerImportRow[] = dataRows.map((r) => {
        const get = (k: string) => (mapping[k] !== undefined ? r[mapping[k]] ?? "" : "");
        return {
          name: get("name"),
          company_name: get("company_name"),
          email: get("email"),
          phone: get("phone"),
          address: get("address"),
          city: get("city"),
          state: get("state"),
          zip: get("zip"),
          notes: get("notes"),
        };
      });
      const res = await bulkImportCustomers(rows);
      if (!res.ok) return setMsg(res.error ?? t("cu_importFailed"));
      setMsg(counted("cu_importedCustomersOne", "cu_importedCustomersMany", res.imported ?? 0, "cu_dupesSkipped", res.skipped));
      router.refresh();
    });
  }

  return (
    <>
      <span className="inline-flex flex-col gap-1">
        {/* On a phone with the real picker, the address book IS the import — the CSV door demotes
            to a small secondary. On desktop the CSV door stays primary, as it should. */}
        {hasPicker && (
          <Button onClick={pickFromPhone} disabled={pending}>
            <BookUser className="h-4 w-4" /> {pending ? t("cu_btn_adding") : t("cu_btn_addFromContacts")}
          </Button>
        )}
        <Button
          variant="outline"
          size={hasPicker ? "sm" : "md"}
          onClick={() => fileRef.current?.click()}
          title={!csv ? t("cu_iphoneVcfTitle") : undefined}
        >
          <Upload className="h-4 w-4" /> {label ?? (csv ? t("cu_btn_importCustomers") : t("cu_btn_importAContact"))}
        </Button>
        {!csv && (
          <span className="text-[11px] text-slate-400">
            {t("cu_iphoneVcfHint")}
          </span>
        )}
      </span>
      <input
        ref={fileRef}
        type="file"
        accept={csv ? ".csv,text/csv,.vcf,text/vcard" : ".vcf,text/vcard"}
        className="hidden"
        onChange={onFile}
      />

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={csv ? t("cu_btn_importCustomers") : t("cu_btn_importAContact")}
        footer={
          headers.length > 0 ? (
            <ModalActions
              onCancel={() => setOpen(false)}
              onSave={runImport}
              saving={pending}
              saveLabel={fillText(t("cu_btn_importRows"), { n: String(dataRows.length) })}
            />
          ) : msg ? (
            // A VCF import (or any info/error message) clears the headers, so the
            // mapping footer is gone — without this the result modal had only an X
            // and looked broken ("import does not work"). Give it a clear Done.
            <ModalActions onCancel={() => setOpen(false)} onSave={() => setOpen(false)} saveLabel={t("cu_btn_done")} hideCancel />
          ) : undefined
        }
      >
        <div className="space-y-4">
          {msg && <div className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">{msg}</div>}
          {headers.length > 0 && (
            <>
              <p className="text-sm text-slate-500">
                {fillText(t("cu_rowsFound"), { n: String(dataRows.length) })}
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {FIELDS.map((f) => (
                  <div key={f.key}>
                    <Label>{t(f.label)}</Label>
                    <Select
                      value={mapping[f.key] ?? ""}
                      onChange={(e) =>
                        setMapping((m) => {
                          const next = { ...m };
                          if (e.target.value === "") delete next[f.key];
                          else next[f.key] = Number(e.target.value);
                          return next;
                        })
                      }
                    >
                      <option value="">{t("cu_optSkip")}</option>
                      {headers.map((h, i) => (
                        <option key={i} value={i}>{h || fillText(t("cu_btn_column"), { n: String(i + 1) })}</option>
                      ))}
                    </Select>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
