export type VCardContact = {
  name: string;
  company_name: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  state: string;
  zip: string;
};

/**
 * Parse vCards (iPhone/iCloud "Share Contact" exports) into contact rows. A single shared
 * card prefills the New Customer form; a multi-card file feeds the bulk importer.
 *
 * ── THE `item1.` BUG, and why "the importer doesn't work" ───────────────────────────────────
 *
 * Erik: "we havent been able to get my contact importer to work."
 *
 * It parsed, and it returned a name, and NOTHING ELSE — which is worse than failing, because an
 * import that half-works looks like a contact with no phone number rather than like a bug. Apple
 * emits GROUPED properties, and it does this for essentially every real contact:
 *
 *     item1.TEL;type=CELL;type=pref:(775) 555-0142
 *     item2.EMAIL;type=INTERNET;type=pref:sara@example.com
 *     item3.ADR;type=HOME;type=pref:;;1234 Alder Creek Rd;Truckee;CA;96161;United States
 *
 * The old matchers were anchored `^TEL[:;]` / `^EMAIL[:;]` / `^ADR[:;]`, so the `itemN.` prefix
 * pushed every one of them off the anchor and they matched nothing. Only FN — which Apple happens
 * to emit ungrouped — survived. Hence: a name, and no way to call the person.
 *
 * So the group prefix is now part of the grammar (it is optional in the spec and near-universal in
 * practice), and a line flagged `type=pref` wins over the first one found, because a contact with
 * three numbers has a right one.
 */
export function parseVCards(text: string): VCardContact[] {
  const cards = text.split(/BEGIN:VCARD/i).slice(1);
  const unfold = (s: string) => s.replace(/\r?\n[ \t]/g, ""); // RFC line folding
  return cards
    .map((raw) => {
      const lines = unfold(raw).split(/\r?\n/);
      /** `prop` is a bare property name; the optional `itemN.` group prefix is handled here. */
      const get = (prop: string) => {
        const re = new RegExp(`^(?:item\\d+\\.)?${prop}[:;]`, "i");
        const hits = lines.filter((x) => re.test(x));
        // A contact with a mobile, a home line and a work line: take the one Apple marked preferred.
        const l = hits.find((x) => /;type=pref\b/i.test(x.split(":")[0] ?? "")) ?? hits[0];
        return l ? l.slice(l.indexOf(":") + 1).trim() : "";
      };
      const adr = get("ADR").split(";"); // ;;street;city;state;zip;country
      return {
        name: get("FN") || get("N").split(";").reverse().filter(Boolean).join(" "),
        company_name: get("ORG").replace(/;+$/, ""),
        phone: get("TEL"),
        email: get("EMAIL"),
        address: adr[2] ?? "",
        city: adr[3] ?? "",
        state: adr[4] ?? "",
        zip: adr[5] ?? "",
      };
    })
    .filter((r) => r.name);
}
