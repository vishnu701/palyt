// Zod schema of what the MODEL returns (not the Draft). Structured output forces this shape;
// we still validate. Deliberately minimal (~60 output tokens): every token the model writes
// costs ~11 ms, so confirm text and clarification questions come from templates in text.ts,
// and gaps.ts decides whether to ask. The model only lists `candidates`; it never decides.
import { z } from "zod";
import { SPOKEN_UNITS } from "../../contracts/protocol";

export const ModelEntry = z.object({
  action: z.string(),            // repaired to a valid Action by transcript.repairAction
  candidates: z.array(z.string()),
  item_heard: z.string(),
  quantity: z.number().nullable(),
  unit: z.enum(SPOKEN_UNITS),
  reason: z.string().nullable(),
  temperature_c: z.number().nullable(),
});
export type ModelEntry = z.infer<typeof ModelEntry>;

export const ModelOutput = z.object({
  language: z.string(),
  intent: z.enum(["log", "correction", "cancel", "unclear"]),
  replaced_pending: z.boolean(),
  entries: z.array(ModelEntry),
});
export type ModelOutput = z.infer<typeof ModelOutput>;
