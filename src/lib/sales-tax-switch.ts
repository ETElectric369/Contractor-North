/**
 * SALES TAX, THE SWITCH (the switch board, 0352, rule g), said once for every tax field and tax row.
 *
 * Off: a NEW document starts untaxed (no default rate seeds it) and its tax field isn't drawn. A
 * document that already carries tax keeps its field and its tax row, so what it charges is always on
 * the screen and can still be changed or taken off. The Tax Report and the mileage deduction are not
 * sales tax and never read this.
 *
 * On, or no switches stored: always shown, exactly as before the switch existed.
 */
export function taxFieldShown(salesTax: boolean, doc?: { tax_rate?: unknown; tax?: unknown } | null): boolean {
  return salesTax || Number(doc?.tax_rate) > 0 || (Number(doc?.tax) || 0) !== 0;
}
