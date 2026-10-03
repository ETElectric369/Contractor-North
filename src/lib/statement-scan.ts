import { readMoney, sayDollars } from "@/lib/supplier-open-list";
// ONE DATE READER FOR THE WHOLE LANE. The gate used readDate while the rows it was judging landed
// through readBankDate, which also takes "2026/09/03", "03-SEP-2026", "3 Sep 2026" and a day with a
// time on it. The gate then counted FEWER lines than the card carried: a correct read was refused as
// "$37.42 short", and a duplicated row in one of those date forms rode onto the card uncounted while
// the card said the read agreed. Two readers for one thing is the defect this repo keeps paying for.
import { readBankDate } from "@/lib/bank-download";

/**
 * A STATEMENT WHOSE LINES ARE PIXELS (2026-10-02).
 *
 * Measured on the owner's own September statement: the PDF carries 125 text marks over 3 pages and
 * every one of them is the back-of-statement legal notice — the bank's address, "Description of
 * problem", the error-resolution wording. The TRANSACTION TABLE IS AN IMAGE. July's file carries no
 * text at all. So the text lane shipped in cn-v1049 can never get those lines, and it behaves
 * correctly about it: pdf-table.ts builds a 45x8 table out of the small print, findBankHeader finds a
 * header-shaped row inside the notice (DATE/TYPE/DESCRIPTION/AMOUNT), and bankTableProof REFUSES it,
 * so the PDF falls through with no phantom card and no zero-line statement. That refusal stays.
 *
 * WHAT THIS FILE IS. The pages are read by a model — the same document block that reads his
 * handwriting today — and this is the part that decides whether to believe it. The model's answer is
 * a PROPOSAL; the ARITHMETIC judges it, never the other way round:
 *
 *     beginning balance + money in - money out === ending balance, to the cent
 *         (a CARD's balance is what is owed, so that walk runs the other way: + out - in)
 *     sum of the lines going in  === the printed total of deposits
 *     sum of the lines going out === the printed total of withdrawals
 *
 * A statement prints those control figures itself, so a read that misplaces a column, drops a line or
 * gets one sign backwards fails arithmetic it never saw. Nothing is written when a check fails, and
 * the refusal says WHICH check and BY HOW MUCH so a person can go find the line.
 *
 * AND IT NEVER CLAIMS WHAT IT DID NOT CHECK. A paper that prints no totals cannot be checked at all;
 * that is not a refusal (the lines are still the lines), but the read report SAYS, in plain words,
 * that nothing held them to account. A total that quietly went unverified is exactly the claim the
 * silent-write law is about.
 *
 * PURE: no model, no HTTP, no database. The prompts live here as strings so the shape the reader is
 * asked for and the shape this parses can never drift apart; the server action calls the model.
 */

// ── WHAT THE READER IS ASKED ───────────────────────────────────────────────────────────────────

/**
 * FIRST, CHEAPLY: WHAT IS THIS PAPER? A text sniff ("STATEMENT OF ACCOUNT", "statement period")
 * works on his September file and CANNOT work on July, which has no text on it at all — so the only
 * honest way to know a scan is a statement is to look at it. One cheap look answers that; the
 * expensive look is only paid for when the answer is yes. Two cheap calls beat one wrong guess.
 */
export const SCAN_KIND_SYSTEM = `You are looking at one piece of paper from a contractor's office. Say only what it is.

Respond with ONLY a JSON object (no prose, no code fences):
{
  "paper": "bank_statement" | "supplier_statement" | "one_paper" | "other",
  "what": "three or four plain words for what you are looking at, e.g. \\"a checking account statement\\" or \\"a hardware store receipt\\""
}

"bank_statement" = a bank's or card company's statement for an account over a period, with a list of transactions on it (deposits, withdrawals, purchases, checks, fees).
"supplier_statement" = a supplier's or vendor's statement of account: a list of INVOICES and what is still owed on them.
"one_paper" = one single document — an invoice, a bill, a receipt, a counter ticket, a credit memo, a purchase order, a quote.
"other" = anything else — a plan, a permit, a letter, a photograph, a form.`;

/**
 * THEN, CAREFULLY: THE LINES, AND THE FIGURES THAT JUDGE THEM.
 *
 * money_out and money_in are asked for as SEPARATE POSITIVE numbers, the way a statement prints its
 * two columns, rather than as one signed amount. A sign is one character for a model to drop and it
 * turns a withdrawal into a deposit; two named fields cannot be dropped, and a line that arrives in
 * both columns or neither is counted and said rather than guessed at.
 */
export const SCAN_LINES_SYSTEM = `You are transcribing a bank or credit-card statement so a contractor's books can be reconciled against it. Transcribe EVERY transaction line exactly as printed, and copy the statement's own control figures.

Respond with ONLY a JSON object (no prose, no code fences):
{
  "account_kind": "deposit" | "card" — "card" for a CREDIT-CARD statement, where the balance is what you OWE; "deposit" for a bank account (checking, savings), where the balance is money you HAVE,
  "beginning_balance": number or null — the opening/previous balance the statement prints,
  "ending_balance": number or null — the closing/new balance it prints,
  "deposits_total": number or null — its own printed total of deposits / credits / additions (on a card: payments and credits),
  "withdrawals_total": number or null — its own printed total of withdrawals / debits / subtractions / checks (on a card: purchases, fees and interest),
  "account_last4": "1234" or null — the LAST FOUR DIGITS ONLY of the account or card number,
  "lines": [{"date": "YYYY-MM-DD", "description": "as printed", "money_out": number or null, "money_in": number or null}]
}

Rules:
- One object per transaction line, in the order they are printed: every purchase, check, deposit, transfer, fee and interest line.
- EXACTLY ONE of money_out and money_in on each line, as a POSITIVE number, never both, never a minus sign. Money that LEFT the account is money_out (a purchase, a withdrawal, a check, a payment, a fee). Money that ARRIVED is money_in (a deposit, a credit, a refund, interest).
- ON A CREDIT-CARD STATEMENT the same two columns mean: money_out is what ADDED to the balance (a purchase, a cash advance, a fee, interest), and money_in is what TOOK IT DOWN (the payment you made to the card, a credit, a return, a refund). A card's "PAYMENT - THANK YOU" line is money_in, never money_out.
- A running balance is NOT a transaction. Never put a balance in money_out or money_in, and never make a line out of a subtotal, a carried-forward figure or a section heading.
- Copy the control figures ONLY if the statement prints them, exactly as printed. If it does not print one, use null. NEVER add them up yourself and never estimate one — code checks your lines against them, and a figure you invented would check nothing.
- If a line prints no year, take the year from the statement period.
- Never invent a line, never leave one out, never merge two.
- Write each description as printed, but if it contains an account, card or reference number, write only its last four digits.`;

/** Continuing a transcription that ran out of room: the lines after the last one that arrived. */
export function scanMoreAsked(last: { date: string; description: string } | null): string {
  const after = last ? `The last line you gave me was ${last.date} "${last.description}".` : "Your answer was cut off.";
  return `${after} Continue with the transaction lines AFTER that one, in the same JSON shape, and do not repeat it or any line before it. Repeat the control figures as you read them. If there are no lines left, answer with an empty "lines" array.`;
}

/**
 * HOW MUCH ROOM THE ANSWER GETS. 4,096 tokens is a receipt's budget: one transaction line costs
 * roughly 60 tokens of JSON, so a dense month would be cut off mid-list — and a cut-off read whose
 * totals then disagree looks like a bad parse rather than a short one. 16,000 holds about 250 lines,
 * which is a busy card month and more; beyond that the cut is DETECTED (stop_reason) and the read
 * continues from its last line, up to SCAN_MORE_CALLS times. A read still cut off after that is
 * refused outright — a short list that looks complete is the worst thing this path could produce.
 */
export const SCAN_MAX_TOKENS = 16_000;
export const SCAN_MORE_CALLS = 3;

/**
 * THE MOST A SCAN MAY WEIGH, AND IT IS THE TRANSPORT THAT SETS IT, NOT THE READER.
 *
 * This was 8 MB, copied from the paper reader's own limit (organize/actions.ts READ_LIMIT) — but that
 * limit is on bytes the server DOWNLOADS from storage, and a scan's bytes ride up as an argument to a
 * server action. base64 inflates a file by a third, and a server function accepts a request body of
 * about 4.5 MB (this repo has recorded that twice in the field: cn-v737's plan sets, and a month of
 * CED PDFs failing a whole import with a 413). So an 8 MB cap meant every file from about 3.3 MB up
 * passed every check here, became a 10.7 MB body and was rejected by the platform before the action
 * existed — "Not added: An unexpected response was received from the server.", no cause, no next
 * action. 3 MB raw is a 4 MB body, which is the same discipline the two sibling scan readers already
 * keep (price-list/vendor-import.tsx SEND_MAX, vendor-lookup-actions.ts READ_LIMIT).
 */
export const SCAN_MAX_BYTES = 3 * 1024 * 1024;

/**
 * HOW LONG THE WHOLE CAREFUL READ GETS, under /reconcile's own maxDuration (300 s). The read is up to
 * four Opus passes that each write thousands of tokens; without a budget of its own the PLATFORM is
 * what ends it, and a killed invocation says nothing, meters nothing (the usage of a call that never
 * returns is not knowable) and bills the tokens anyway — the loss price-list/vendor-lookup.ts names.
 * Coming back in words, inside the page's budget, is the whole point.
 */
export const SCAN_READ_MS = 240_000;

// ── WHAT CAME BACK ─────────────────────────────────────────────────────────────────────────────

export type ScanKind = "bank_statement" | "supplier_statement" | "one_paper" | "other";

/** The cheap look's answer. Anything it did not say plainly is "other": a guess is not an answer. */
export function scanKindFrom(parsed: unknown): { kind: ScanKind; what: string } {
  const o = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const said = String(o.paper ?? "").trim().toLowerCase();
  const kind: ScanKind = said === "bank_statement" || said === "supplier_statement" || said === "one_paper" ? said : "other";
  // THE MODEL'S WORDS GO ON SCREEN, so they are cut to one short phrase: no newlines, no essay.
  const what = String(o.what ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return { kind, what };
}

/** One transaction line that read cleanly. `cents` is SIGNED: money in positive, money out negative. */
export type ScanLine = {
  /** Which line of the reader's answer it was, for a report that has to name one. */
  at: number;
  date: string;
  description: string;
  cents: number;
};

/** Which way this account's balance moves. Null: the reader didn't say, so "deposit" is assumed. */
export type ScanAccountKind = "deposit" | "card";

/** The statement's own control figures, in cents. Null means the paper does not print it. */
export type ScanControls = {
  beginning: number | null;
  ending: number | null;
  /** Printed totals as positive magnitudes: a statement may print its withdrawals as -4,210.00. */
  deposits: number | null;
  withdrawals: number | null;
  /**
   * A BANK ACCOUNT'S BALANCE AND A CARD'S RUN OPPOSITE WAYS, and the gate has to walk the right one.
   * On a deposit account the balance is money you HAVE, so money in raises it; on a card it is what
   * you OWE, so a purchase raises it and a payment lowers it. One walk for both refused EVERY
   * correctly read card statement — and this lane is offered for cards in as many words (SCAN_KIND
   * _SYSTEM: "a bank's or card company's statement").
   */
  account: ScanAccountKind | null;
};

const accountKindOf = (v: unknown): ScanAccountKind | null => {
  const said = String(v ?? "").trim().toLowerCase();
  if (/credit\s*card|^card$|\bcard\b/.test(said)) return "card";
  if (/deposit|checking|savings|current|bank/.test(said)) return "deposit";
  return null;
};

export type ScanStatement = {
  /** The reader's lines as the SAME string[][] a CSV of them would make, so the one existing bank
   *  reader (bank-download.ts) turns them into lines and the one existing card shows them. */
  table: string[][];
  /**
   * The lines that read cleanly, read with the BANK READER'S OWN day reader so this is exactly the set
   * `readBankTable` will make of the same table. What the gate is actually handed is that reader's own
   * lines (`landedScanLines`), so the gate can only ever judge what lands; these are what the
   * continuation counts from and names its last line by.
   */
  lines: ScanLine[];
  /** Every line the reader returned, read or not: what the read report calls the rows on the pages. */
  returned: number;
  controls: ScanControls;
  last4: string | null;
};

/**
 * The headings the table carries. Bank words on purpose (bank-download.ts BANK_WORDS): Withdrawal and
 * Deposit are words only a bank prints, so these rows can only ever read as a bank's lines, and the
 * two-column shape means a sign can never be the thing that decides which way money went.
 *
 * ACCOUNT carries the last 4 the reader found, down every row, because the bank reader takes the
 * account from a column (last4Of) and that last 4 is what stops the same fee on two accounts reading
 * as one line twice. Only four digits ever go in it: `readScannedBank` cuts whatever it was given to
 * its last four before it is a cell at all.
 */
export const SCAN_TABLE_HEADER = ["Date", "Description", "Withdrawal", "Deposit", "Account"];

const centsOrNull = (v: unknown): number | null => {
  const n = readMoney(v);
  return n === null ? null : Math.round(n * 100);
};
const absCentsOrNull = (v: unknown): number | null => {
  const n = centsOrNull(v);
  return n === null ? null : Math.abs(n);
};
/** A magnitude as a cell the bank reader parses: "1234.56". The column says which way it went. */
const cell = (cents: number): string => (Math.abs(cents) / 100).toFixed(2);

/**
 * THE READER'S ANSWER AS ROWS. Every line it returned becomes a row, INCLUDING the ones that could
 * not be read: a line whose date is unreadable keeps its date cell as printed, and a line that
 * arrived in both money columns or neither has both left empty. The bank reader then counts those
 * rows and says why each failed, in the ONE read report — dropping them here would make the card one
 * line shorter with nothing said anywhere, which is this whole path's worst outcome.
 *
 * `lines` holds only the rows that read, with the SAME day reader the bank reader uses, so this set and
 * the set that lands cannot differ.
 */
export function readScannedBank(parsed: unknown): ScanStatement {
  const o = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const returned = Array.isArray(o.lines) ? (o.lines as unknown[]) : [];
  const table: string[][] = [[...SCAN_TABLE_HEADER]];
  const lines: ScanLine[] = [];
  // THE ACCOUNT NUMBER IS CUT HERE, BEFORE IT IS EVER A CELL (0363 CHECKs that no stored description
  // holds a run of 6+ digits). A reader told to hand back four digits may hand back twelve; four is
  // all this keeps, so the database CHECK is never the thing that finds out.
  const last4 = String(o.account_last4 ?? "").replace(/\D/g, "").slice(-4) || null;
  returned.forEach((r, i) => {
    const l = r && typeof r === "object" ? (r as Record<string, unknown>) : {};
    // THE BANK READER'S OWN DAY READER, so a line this counts and a line that lands are the same set.
    const date = readBankDate(l.date);
    const description = String(l.description ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    const out = centsOrNull(l.money_out) ?? 0;
    const money = centsOrNull(l.money_in) ?? 0;
    // WHICH WAY THE MONEY WENT IS NEVER GUESSED. Printed in both columns, or in neither, and the row
    // goes on with no amount on it: the bank reader says "No amount on it" by line number.
    const oneWay = (out !== 0) !== (money !== 0);
    const cents = money !== 0 ? Math.abs(money) : -Math.abs(out);
    const printed = date ?? String(l.date ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    // A LINE THAT CAME BACK WITH NOTHING ON IT STILL SAYS SO. An empty row is the one row the bank
    // reader skips in silence (it reads as a blank line in a file), and then the card is a line short
    // with no reason given anywhere. Words in the cell make it a row that gets counted and named.
    const blank = !printed && !description && !oneWay;
    table.push([
      printed,
      blank ? "(this line came back blank)" : description,
      oneWay && cents < 0 ? cell(cents) : "",
      oneWay && cents > 0 ? cell(cents) : "",
      last4 ?? "",
    ]);
    if (date && oneWay) lines.push({ at: i + 1, date, description, cents });
  });
  return {
    table,
    lines,
    returned: returned.length,
    controls: {
      beginning: centsOrNull(o.beginning_balance),
      ending: centsOrNull(o.ending_balance),
      deposits: absCentsOrNull(o.deposits_total),
      withdrawals: absCentsOrNull(o.withdrawals_total),
      account: accountKindOf(o.account_kind),
    },
    last4,
  };
}

/**
 * THE LINES THAT ACTUALLY LANDED, as the gate's own shape. The gate must judge the rows the card will
 * carry, never a parallel reading of the same answer: `readBankTable` is what turns the table into
 * lines inside `addOpenList`, so handing its lines to `checkScanTotals` makes drift between the two
 * structurally impossible rather than a thing a test has to keep catching.
 */
export function landedScanLines(lines: readonly { postedOn: string; description: string; cents: number }[]): ScanLine[] {
  return lines.map((l, i) => ({ at: i + 1, date: l.postedOn, description: l.description, cents: l.cents }));
}

/**
 * A CUT-OFF ANSWER, CLOSED IN CODE AND NEVER BY A MODEL.
 *
 * An answer that stopped at max_tokens is not valid JSON, and handing it to the JSON repair round trip
 * (ai-json.ts) could never work: the repair has to re-emit the whole document, and a 16,000-token
 * answer does not fit in a repair's budget — so it threw "too large to repair" and the continuation
 * this lane is built around was unreachable in production. Every statement past one answer died with
 * "it got 0 and the statement goes on", which is both a dead capability and a false count.
 *
 * So the cut is closed HERE, deterministically: walk the text, and cut back to the last point a
 * container closed — the end of the last whole transaction line — then shut the arrays and objects
 * that are still open. Nothing is invented and nothing is re-worded; the half line that was cut
 * through is simply dropped, and the continuation asks for the lines after the last whole one, so it
 * comes back on the next pass. The control figures come BEFORE "lines" in the asked-for shape on
 * purpose, so they survive the cut and the gate still judges the total.
 *
 * Null when not one container closed before the cut: there is nothing to keep, and saying so beats
 * guessing. A reply that was NOT cut never comes here — it goes through the ordinary parse.
 */
export function closeCutJson(raw: string): string | null {
  const text = String(raw ?? "");
  const start = text.indexOf("{");
  if (start === -1) return null;
  const open: string[] = [];
  let inString = false;
  let escaped = false;
  let end = -1;
  let closers = "";
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      open.push(ch);
      continue;
    }
    if (ch !== "}" && ch !== "]") continue;
    const was = open.pop();
    // More closers than openers, or a `]` shutting a `{`: this is not text to cut up. Keep what held.
    if (was === undefined) break;
    if ((ch === "}") !== (was === "{")) return null;
    // A CLOSED CONTAINER IS ALWAYS A WHOLE VALUE, never a key waiting for one, so this is always a
    // place the text can be cut and shut. That is the only reason this needs no JSON grammar.
    end = i + 1;
    closers = open
      .map((c) => (c === "{" ? "}" : "]"))
      .reverse()
      .join("");
    if (!open.length) break; // The whole object closed: anything after it is prose, not JSON.
  }
  return end === -1 ? null : text.slice(start, end) + closers;
}

// ── THE GATE ───────────────────────────────────────────────────────────────────────────────────

export type ScanFail = { which: "withdrawals" | "deposits" | "balance"; said: string; offByCents: number };

export type ScanCheck = {
  /** May these lines be proposed at all? False only when a check RAN and disagreed. */
  pass: boolean;
  /** The checks that ran and agreed, in plain words. */
  agreed: string[];
  /** The checks that could not run, each saying which figure the paper does not print. */
  unchecked: string[];
  /** Every check that ran and disagreed: which, by how much, in words a person can act on. */
  failed: ScanFail[];
};

/** A MAGNITUDE: what went out, what came in, how far apart two figures are. Never a balance. */
const D = (cents: number) => sayDollars(Math.abs(cents) / 100);
/**
 * A BALANCE, WITH ITS SIGN. An overdrawn account prints -300.00 and the reader copies it as printed,
 * so stripping the sign gave a sentence that contradicted itself and the paper: "$300.00 to start …
 * ends at $190.00 — $10.00 short" reads as OVER, and neither figure is on his statement. The sentence
 * exists so a person can go and find the line; it has to match what he is holding.
 */
const S = (cents: number) => sayDollars(cents / 100);
const gap = (lines: number, printed: number) => `${D(Math.abs(lines - printed))} ${lines < printed ? "short" : "over"}`;

/** How the balance walk is named in the report, so which direction held is never left to be guessed. */
const BALANCE_SAID = { deposit: "the balance from end to end", card: "the balance from end to end (a card's balance: what you owe)" } as const;

/**
 * THE WHOLE REASON A MODEL MAY TOUCH A STATEMENT AT ALL: its own printed figures judge the read.
 *
 * Nothing in here knows about models, HTTP or the database — it is cents in, verdict out, so it can
 * be tested to the cent. A check with no figure to check against does not fail: it goes unrun, and
 * is NAMED, because "never claim what you did not check" is the law this path lives or dies by.
 */
export function checkScanTotals(lines: readonly ScanLine[], c: ScanControls): ScanCheck {
  const out = lines.reduce((n, l) => (l.cents < 0 ? n - l.cents : n), 0);
  const money = lines.reduce((n, l) => (l.cents > 0 ? n + l.cents : n), 0);
  const agreed: string[] = [];
  const unchecked: string[] = [];
  const failed: ScanFail[] = [];

  // WHETHER THE PAPER'S OWN TWO TOTALS PINNED EVERY LINE. It decides one thing below and nothing else:
  // whether the balance may be walked the other way round when the named direction doesn't hold.
  let pinned = 0;

  if (c.withdrawals === null) unchecked.push("the money going out (it prints no total of withdrawals)");
  else if (out !== c.withdrawals) {
    failed.push({
      which: "withdrawals",
      offByCents: Math.abs(out - c.withdrawals),
      said: `The money going out doesn't add up: these lines come to ${D(out)} out and your statement prints ${D(c.withdrawals)} — ${gap(out, c.withdrawals)}.`,
    });
  } else {
    agreed.push("the money going out");
    pinned++;
  }

  if (c.deposits === null) unchecked.push("the money coming in (it prints no total of deposits)");
  else if (money !== c.deposits) {
    failed.push({
      which: "deposits",
      offByCents: Math.abs(money - c.deposits),
      said: `The money coming in doesn't add up: these lines come to ${D(money)} in and your statement prints ${D(c.deposits)} — ${gap(money, c.deposits)}.`,
    });
  } else {
    agreed.push("the money coming in");
    pinned++;
  }

  if (c.beginning === null || c.ending === null) {
    const missing = c.beginning === null && c.ending === null ? "no beginning or ending balance" : c.beginning === null ? "no beginning balance" : "no ending balance";
    unchecked.push(`the balance from end to end (it prints ${missing})`);
  } else {
    /**
     * THE WALK GOES THE WAY THIS ACCOUNT'S BALANCE GOES. A bank account: beginning + in - out. A card:
     * beginning + out - in, because the balance is what is OWED and a purchase adds to it. Walking
     * every statement as a bank account refused every correctly read card month — $709.38 "over" on a
     * paper with no error on it — and "Drop it again" could never fix it, so each retry bought a fresh
     * Opus read to print the same sentence.
     *
     * THE OTHER DIRECTION IS ONLY EVER ACCEPTED WHEN THE PAPER'S OWN TWO TOTALS ALREADY AGREED. Then
     * every line's side is pinned by the statement's own printed labels, so the only thing the other
     * direction can mean is that this is a liability account the reader named wrongly — it cannot
     * launder a read with its signs inverted, because inverted lines fail those two totals first.
     * Accepting either direction with no printed totals WOULD launder exactly that, so it is not done.
     */
    const asDeposit = c.beginning + money - out;
    const asCard = c.beginning + out - money;
    const named: ScanAccountKind = c.account === "card" ? "card" : "deposit";
    const walked = named === "card" ? asCard : asDeposit;
    const other = named === "card" ? asDeposit : asCard;
    if (walked === c.ending) agreed.push(BALANCE_SAID[named]);
    else if (pinned === 2 && other === c.ending) agreed.push(BALANCE_SAID[named === "card" ? "deposit" : "card"]);
    else {
      const how =
        named === "card"
          ? `this reads as a card, so ${S(c.beginning)} owed to start, ${D(out)} charged and ${D(money)} paid makes ${S(walked)}`
          : `${S(c.beginning)} to start, ${D(money)} in and ${D(out)} out makes ${S(walked)}`;
      failed.push({
        which: "balance",
        offByCents: Math.abs(walked - c.ending),
        said: `The balances don't meet: ${how}, but your statement ends at ${S(c.ending)} — ${gap(walked, c.ending)}.`,
      });
    }
  }
  return { pass: failed.length === 0, agreed, unchecked, failed };
}

const list = (parts: readonly string[]): string =>
  parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

/**
 * WHAT THE READ REPORT SAYS THE ARITHMETIC DID — carried into pdfReadSaid (supplier-open-list.ts) as
 * the one report's own "held against" clause, never printed as a second summary somewhere else.
 *
 * A paper with no totals on it is the case this sentence exists for: the lines still reach the card,
 * and the card says out loud that NOTHING checked them.
 */
export function scanCheckSaid(check: ScanCheck): string {
  const cannot = check.unchecked.length ? ` It could not check ${list(check.unchecked)}, so go down those lines against the paper before you Apply.` : "";
  if (!check.agreed.length) {
    return "This statement prints no totals to hold the read against, so NOTHING here checked it: every line is the reader's word. Go down them against the paper before you Apply.";
  }
  return `Held against the statement's own printed figures: ${list(check.agreed)} agree to the cent.${cannot}`;
}

/**
 * WHEN A CHECK DISAGREES, NOTHING IS WRITTEN AND THE AMOUNT IS NAMED. One next action and it is the
 * same button: a reader asked twice rarely misses the same line, and the figure he now has is what
 * he hunts for on the paper if it does.
 *
 * AND THEN THE FALLBACK, because the same refusal twice IS a dead end otherwise. A read the paper's own
 * arithmetic keeps disagreeing with is not something dropping it a third time will mend, and the paper
 * must not be lost over it — so the sentence ends the way READER_SILENT does: one action, then the door
 * that keeps it whatever the reader is doing. A sequence, never a menu of doors to choose between.
 */
export function scanRefusalSaid(name: string, check: ScanCheck): string {
  const first = check.failed[0];
  const more = check.failed.length - 1;
  const also = more > 0 ? ` ${more === 1 ? "One other check disagrees" : `${more} other checks disagree`} too.` : "";
  return `${name} was read, but the statement's own figures say the read is wrong, so nothing was added. ${first?.said ?? ""}${also} Drop it again to read it afresh — and if the same figure comes back, add it with the + button at the top, which keeps it as a paper.`;
}

/**
 * A read still cut off after SCAN_MORE_CALLS continuations. Never a short list that looks whole.
 *
 * IT NO LONGER ADVISES A SPLIT, because the gate is built to refuse one. A statement's printed
 * beginning balance, ending balance and totals describe the WHOLE month, so the first half of a split
 * PDF arrives with half the lines and all of the totals and is refused "$20,500.00 short" — the one
 * next action named was an action this app rejects, which is a dead end wearing a sentence. What is
 * named instead is a path that works: the month as a file from the bank (no length limit at all, and
 * an OFX carries the bank's own transaction ids), then the + button, which keeps the paper whatever
 * else happens. One action and then its fallback, never a menu.
 *
 * AND THE COUNT IS ONLY SAID WHEN IT IS TRUE. "it got 0" was printed for every long statement while
 * the continuation was unreachable; a count that is really zero now says nothing rather than a number.
 */
export function scanTruncatedSaid(name: string, got: number): string {
  const sofar = got > 0 ? ` — it got ${got} ${got === 1 ? "line" : "lines"} and the statement goes on` : "";
  return `${name} has more lines on it than the reader can hand back in one go${sofar}. Nothing was added, because a list that stops in the middle looks complete and isn't. Download the month from your bank as CSV or OFX and drop that — a file has no length limit here. If the paper is all you have, add it with the + button at the top, which keeps it as a paper.`;
}

/**
 * A READ THE PLATFORM WOULD HAVE KILLED, ended in words instead (SCAN_READ_MS). A spinner that stops
 * with "an unexpected response" is how a person decides the button is broken; this says what happened
 * and names one action, then the fallback that always works.
 */
export function scanTooSlowSaid(name: string): string {
  return `${name} was still being read when the time one read gets ran out, so nothing was added. Drop it again — and if it runs out again, add it with the + button at the top, which keeps it as a paper.`;
}

/** A scan that is not a bank statement. It names the door that reads it, which is one action. */
export function notABankScanSaid(name: string, kind: ScanKind, what: string): string {
  const looks = what ? `reads as ${what}` : "doesn't read as a bank statement";
  if (kind === "supplier_statement") {
    return `${name} ${looks} — a supplier's statement rather than a bank's. Add it with the + button at the top: it is read as a paper there, and the open items on it come off it the same way.`;
  }
  return `${name} ${looks}, not a statement. Add it with the + button at the top and it is read as a paper.`;
}
