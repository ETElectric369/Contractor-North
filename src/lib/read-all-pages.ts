/**
 * A WHOLE LIST, OR A FAILURE (the paging rule storage-sweep's readAllRefs and owner-money's readEvery
 * keep, as a shared helper). PostgREST caps a select at the project's db-max-rows (1000 by default,
 * a setting that lives nowhere in this repo) and says nothing: status 200, no error, the rest simply
 * missing. So a list that decides something is read a page at a time, advancing by the rows ACTUALLY
 * returned (a page can come back capped short), and it is whole only when an empty page comes back.
 * An error, a non-list, or more pages than `maxPages` is a failure, never a partial list.
 *
 * `page(from, to)` must order by something unique (the id), or rows can repeat or go missing
 * between pages.
 */
export const PAGE_ROWS = 1000;

export async function readAllPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  maxPages = 50,
): Promise<{ rows: T[]; error: unknown }> {
  const out: T[] = [];
  for (let i = 0, from = 0; i < maxPages; i++) {
    const { data, error } = await page(from, from + PAGE_ROWS - 1);
    if (error) return { rows: [], error };
    if (!Array.isArray(data)) return { rows: [], error: new Error("read returned no rows array") };
    if (!data.length) return { rows: out, error: null };
    out.push(...data);
    from += data.length;
  }
  return { rows: [], error: new Error(`more than ${maxPages * PAGE_ROWS} rows to read at once`) };
}
