/**
 * THE WORDS ON THE YOUR DATA CARD (cn-v1138), in a plain module: the server component, the client
 * list and their tests read them from one place, and a client file never imports the server one.
 */
export const YOUR_DATA_TITLE = "Your Data";
export const YOUR_DATA_LINE = "Everything the company has typed and uploaded, yours to keep.";

/** Behind the info icon: what the records zip holds, and that the files come separately. */
export const YOUR_DATA_FACTS: readonly string[] = [
  "Download Everything is a zip of the company's records: a README that explains the files, company.json with the company's own settings, one CSV per table (customers, jobs, estimates, invoices, payments, bills, time entries and the rest), and files.csv, a list of every uploaded file and where it belongs.",
  "The uploaded files themselves come separately, because they are big: Company Files is one zip of everything outside a job (the crew's documents, insurance, what Organize My filed, intake uploads, every visit's photos and files, the logo and portfolio), and each job's files are their own zip under Files By Job.",
  "Only the owner can download. A company whose plan has lapsed can still take its data out.",
  "The CSVs open in Excel, Numbers or Google Sheets. Downloading changes none of your records; North only notes who downloaded and when.",
];

export const askOwnerWords = (first: string | null | undefined): string => `Ask ${first?.trim() || "the owner"} to download the company's data.`;

export const NO_JOB_FILES_WORDS = "No job has files yet.";
export const FILES_BY_JOB = "Files By Job";

/** "12 Files", "1 File". */
export const filesWord = (n: number): string => `${n} ${n === 1 ? "File" : "Files"}`;
