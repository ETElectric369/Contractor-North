/**
 * WHAT A DROP TAKES, AND WHAT IT LEAVES BEHIND BY NAME (dropbox plan, Phase 0).
 *
 * DropTarget used to answer a drop with nothing at all when some of the files fit and some did
 * not: three PDFs and a Word file went in as three, and the fourth simply never existed. A door
 * that takes one file (multiple=false) did the same to every file after the first. Both are the
 * silence this app is not allowed to make, so the sorting is here, pure and tested, and the
 * target names every file it did not take.
 */

export type DropFileLike = { name: string; type?: string | null };

/** The accept= attribute's rule: ".pdf" by name, "image/*" by family, "application/pdf" exact. */
export function matchesAccept(file: DropFileLike, accept?: string | null): boolean {
  if (!accept) return true;
  const type = String(file.type ?? "").toLowerCase();
  const name = String(file.name ?? "").toLowerCase();
  return accept.split(",").some((raw) => {
    const a = raw.trim().toLowerCase();
    if (!a) return false;
    if (a.startsWith(".")) return name.endsWith(a);
    if (a.endsWith("/*")) return type.startsWith(a.slice(0, -1));
    return type === a;
  });
}

export type DropSort<F extends DropFileLike> = {
  /** Handed to the door, in the order they were dropped. */
  take: F[];
  /** Wrong type for this door. */
  skipped: F[];
  /** Right type, but this door takes one file and these came after it. */
  extra: F[];
};

export function sortDrop<F extends DropFileLike>(files: readonly F[], accept?: string | null, multiple = true): DropSort<F> {
  const fits = files.filter((f) => matchesAccept(f, accept));
  const skipped = files.filter((f) => !matchesAccept(f, accept));
  const take = multiple ? fits : fits.slice(0, 1);
  const extra = multiple ? [] : fits.slice(1);
  return { take, skipped, extra };
}

function names(files: readonly DropFileLike[]): string {
  const list = files.map((f) => f.name || "a file with no name");
  if (list.length <= 1) return list[0] ?? "";
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  if (list.length > 4) return `${list.slice(0, 3).join(", ")} and ${list.length - 3} more`;
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/**
 * The sentence for what was left behind, or null when everything was taken. Every file is named
 * (up to three, then a count), because "some files were skipped" is not something a person can
 * act on.
 */
export function describeLeftBehind(sort: DropSort<DropFileLike>): string | null {
  const parts: string[] = [];
  if (sort.skipped.length) {
    parts.push(`${names(sort.skipped)} ${sort.skipped.length === 1 ? "isn't a kind of file" : "aren't kinds of file"} this takes, so ${sort.skipped.length === 1 ? "it was" : "they were"} left out.`);
  }
  if (sort.extra.length) {
    parts.push(`This takes one file at a time, so ${names(sort.extra)} ${sort.extra.length === 1 ? "was" : "were"} left out. Drop ${sort.extra.length === 1 ? "it" : "them"} again after this one.`);
  }
  return parts.length ? parts.join(" ") : null;
}
