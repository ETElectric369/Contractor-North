/**
 * SALES TAX OFF (the switch board, 0352, rule g) on Nort's live estimate preview (api/chat's
 * quote_draft tool). Off: the tool offers no tax rate, and a rate the model sends anyway never
 * reaches the preview, so Nort can't show a taxed estimate that the Save (saveQuoteFromDraft) would
 * then write untaxed. On: the very same tool and the very same draft, untouched.
 */
type ToolShape = { description: string; input_schema: { properties: Record<string, unknown> } };

export function quoteDraftToolFor<T extends ToolShape>(tool: T, salesTax: boolean): T {
  if (salesTax) return tool;
  const properties = { ...tool.input_schema.properties };
  delete properties.tax_rate;
  return {
    ...tool,
    description: tool.description.replace(", tax_rate as a fraction,", ","),
    input_schema: { ...tool.input_schema, properties },
  } as T;
}

/** What the preview is handed: the model's draft, less any tax rate while Sales Tax is off. */
export function quoteDraftShown(input: unknown, salesTax: boolean): Record<string, unknown> {
  const draft = { ...((input ?? {}) as Record<string, unknown>) };
  if (!salesTax) delete draft.tax_rate;
  return draft;
}
