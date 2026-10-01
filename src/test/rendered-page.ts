/**
 * READING A RENDERED PAGE THE WAY A PERSON READS IT — ONE COPY (cn-v1037).
 *
 * `bills-page-doors.test.ts` grew these four helpers to prove every door on /bills keeps exactly one
 * home. /reconcile needed the same proof for the doors that moved onto it, and a fourth hand-copy of
 * "what is inside the element carrying this id" is how two door tests come to disagree about whether
 * a button is in a section. So they live here, once.
 *
 * THEY READ STATIC MARKUP ON PURPOSE. Everything below Needs You is a native <details>, so a folded
 * door is still in the HTML: a server render through renderToStaticMarkup sees every one of them
 * without a tap, which is what makes these tests behavioural rather than a source grep.
 */

/** The element carrying `id`, whole: from its opening tag to the tag that closes it. */
export function sectionOf(html: string, id: string): string {
  const at = html.indexOf(` id="${id}"`);
  if (at < 0) throw new Error(`no element with id ${id}`);
  const open = html.lastIndexOf("<", at);
  const tag = /^<([a-zA-Z0-9]+)/.exec(html.slice(open))![1];
  const re = new RegExp(`<(/?)${tag}(?=[\\s>])[^>]*>`, "g");
  re.lastIndex = open;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(open, re.lastIndex);
  }
  return html.slice(open);
}

/** What a person reads on a control: its text, tags and whitespace dropped. */
export const textOf = (s: string): string =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

/** The words on every <button>, <a> and <summary> in a piece of the page. */
export function doorsIn(s: string): string[] {
  return Array.from(s.matchAll(/<(button|a|summary)\b[^>]*>([\s\S]*?)<\/\1>/g)).map((m) => textOf(m[2]).trim());
}

/** How many of those doors read exactly like this. */
export const countDoors = (list: string[], label: string | RegExp): number =>
  list.filter((d) => (typeof label === "string" ? d === label : label.test(d))).length;
