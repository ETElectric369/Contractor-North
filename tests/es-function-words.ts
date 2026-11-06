/**
 * SPANISH TITLE CASE = THE SIGNIFICANT WORDS (Erik, cn-v1147, after the RAE's Diccionario panhispánico de dudas:
 * "Ministerio de Asuntos Sociales"). In a Spanish clickable or title these function words (every preposition, article and conjunction — the RAE's rule has no length limit) stay lowercase, except as
 * the first word or the first word after a separator (· — – / ( &). English is unchanged: every word capitalized.
 * One list and one rule for every check that judges it: tests/words-parity.test.ts (the catalogs), tests/title-case.test.ts
 * (every door in the app) and the per-screen tests that re-check their own doors (titleCaseIn / esTitleCase).
 */
export const ES_FUNCTION_WORDS: ReadonlySet<string> = new Set(
  "a al de del el la los las un una unos unas y e o u en con por para sin como lo desde hasta sobre entre hacia según tras ante bajo contra durante mediante que ni pero".split(" "),
);

/** English: every word begins with a capital, a digit or a symbol; a {slot} is a hole, not a word; "/", "&", "+", "·",
 *  a dash ("They Paid — Record It", the way tests/title-case.test.ts lets "Saved — Open It" through) pass. Spanish: the
 *  same, and Spanish's opening "¿" / "¡" ("¿Cobrar Ahora?"), except that a function word after the first word of a
 *  segment MUST be lowercase ("Lista De Precios" fails, "Lista de Precios" passes); a separator (· — – / ( &) starts a
 *  new segment. */
export const titleCaseIn = (s: string, lang: "en" | "es" = "en"): boolean => {
  let segStart = true;
  for (const tok of s.replace(/\{\w+\}/g, " ").split(/\s+/).filter(Boolean)) {
    if (/^[·—–&\/]+$/.test(tok)) {
      segStart = true;
      continue;
    }
    // "Sí/No": a "/" inside a word splits two words, and the second starts a segment of its own.
    for (const [i, piece] of tok.split("/").entries()) {
      if (i > 0 || piece.startsWith("(")) segStart = true;
      if (!piece) continue;
      const core = piece.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "");
      const fw = lang === "es" && !segStart && ES_FUNCTION_WORDS.has(core.toLowerCase());
      if (fw ? core !== core.toLowerCase() : !/^[¿¡]?[\p{Lu}\p{N}&\/+·(—–]/u.test(piece)) return false;
      if (core) segStart = false;
    }
  }
  return true;
};

/** The Spanish rule alone, for a test that checks only its Spanish words. */
export const esTitleCase = (s: string): boolean => titleCaseIn(s, "es");
