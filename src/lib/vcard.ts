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

/** Parse vCards (iPhone/iCloud "Share Contact" exports) into contact rows. A single shared
 *  card prefills the New Customer form; a multi-card file feeds the bulk importer. */
export function parseVCards(text: string): VCardContact[] {
  const cards = text.split(/BEGIN:VCARD/i).slice(1);
  const unfold = (s: string) => s.replace(/\r?\n[ \t]/g, ""); // RFC line folding
  return cards
    .map((raw) => {
      const lines = unfold(raw).split(/\r?\n/);
      const get = (prefix: RegExp) => {
        const l = lines.find((x) => prefix.test(x));
        return l ? l.slice(l.indexOf(":") + 1).trim() : "";
      };
      const adr = get(/^ADR[:;]/i).split(";"); // ;;street;city;state;zip;country
      return {
        name: get(/^FN[:;]/i) || get(/^N[:;]/i).split(";").reverse().filter(Boolean).join(" "),
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
