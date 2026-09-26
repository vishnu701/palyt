# Brief · Interpreter agent

You build `app/src/interpreter/`: transcript in, `Draft` out. Read `SPEC.md` first. Contracts:
`app/contracts/protocol.ts` (`Draft`, `Entry`, `Clarification`), `app/contracts/interfaces.ts`
(`Interpreter`, `RawEntry`), `app/contracts/catalog.ts`, and your done-criteria
`app/contracts/fixtures/interpreter.json`. You own `app/src/interpreter/**` and
`app/tests/interpreter/**`. You never touch the gateway; you don't know about WebSockets.

You cannot talk to the other agents. If the contract is missing something, stop and tell the human.

## Deliverables

```
app/src/interpreter/index.ts     createInterpreter({model?}) → Interpreter; export PROMPT_VERSION, normalizeEntry
app/src/interpreter/prompt.ts    frozen system prompt (built once from CATALOG_PROMPT)
app/src/interpreter/schema.ts    zod schema of the MODEL output (not the Draft)
app/src/interpreter/normalize.ts units, ₹, labels, warnings (pure)
app/src/interpreter/gaps.ts      deterministic clarification rules (pure)
app/src/interpreter/cache.ts     result cache keyed on (normalized text, languageHint, pending draft_id+round)
app/tests/interpreter/*.test.ts  fixture runner + unit tests for normalize/gaps
```

## Claude API — exact usage

SDK `@anthropic-ai/sdk` (installed). Model from `opts.model ?? process.env.CLAUDE_MODEL ??
"claude-opus-5"`. Client: `new Anthropic({ timeout: 8000, maxRetries: 1 })`.

```ts
const res = await client.messages.parse({
  model,
  max_tokens: 1024,
  thinking: { type: "adaptive" },                 // omit entirely on claude-haiku-4-5
  output_config: { format: zodOutputFormat(ModelOutput), effort: "low" },   // no `effort` on haiku
  system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: userTurn }],
});
res.parsed_output   // typed; null → throw
```

Rules that bite:
- `zodOutputFormat` from `@anthropic-ai/sdk/helpers/zod`. Structured output means the JSON
  always matches `ModelOutput`; still validate with zod before use.
- No `temperature`, no `seed` (don't exist here). Determinism comes from the schema + code + cache.
- **The system prompt must be byte-identical on every call** (prompt caching is a prefix
  match). No timestamps, no stock levels, no per-request data in it. Per-request data goes in
  the user turn. Verify: `res.usage.cache_read_input_tokens > 0` on the second call with Opus.
  On `claude-haiku-4-5` the cacheable minimum is 4096 tokens so reads stay 0 — expected.
- `warm()`: `client.messages.create({ model, max_tokens: 0, thinking, output_config: {effort},
  system: <same block with cache_control>, messages: [{role:"user", content:"warm"}] })`.
  `max_tokens: 0` is rejected together with `output_config.format`, so warm-up omits the
  format; the cached prefix (system) is identical, which is what matters. Swallow all errors.
- `stop_reason === "refusal"` → throw (gateway reports INTERPRET_FAILED).

## Model output schema (`schema.ts`) — what Claude fills

```ts
ModelOutput = {
  language: string,                 // BCP-47 the staff member SPOKE (hint given; Hinglish → "hi-IN")
  intent: "log" | "correction" | "cancel" | "unclear",
  replaced_pending: boolean,        // true only when pending existed and this is a different thing
  entries: RawEntry[],              // candidates: catalog ids, best first; [] when nothing matches
  confirm_text: string,             // native script, digits, ends with "is this correct?" in that language; "" unless log/correction
  clarify: null | { entry_index, field, question: string, option_labels?: string[] }
                                    // ONLY when the rules below can't see the problem; usually null
}
```

The model never outputs `needs_clarification` itself; **code decides** from `candidates` and
gaps (below), then asks the model for the *question text* in a second tiny call only when
needed (or, cheaper: ask for `question_if_ambiguous` texts in the first call — your choice;
keep total ≤ 2 calls per turn, and 1 on the happy path).

## System prompt (`prompt.ts`) — content requirements

- Role: turn kitchen-staff speech (Hindi, Kannada, Marathi, Tamil, Telugu, English, mixed)
  into entries. Text is from speech recognition: may be misheard; infer from kitchen context.
- The action list with local trigger words (aaya/bandide/aala = receiving; kharab/kedide/
  phenk diya = wastage; bana diya = prep; bacha hai/gina = stock_count; degree = temperature_check).
- Number words: aadha/ardha .5, dedh/ondu-vare 1.5, dhai/adich 2.5, sawa X, paune X, darjan.
  Devanagari/Kannada digits → Arabic. Units: kilo→kg, gram→g, litre→l, packet/dabba→packet,
  plate/portion→portion, piece/anda/nag→pcs. Keep the unit as spoken; never convert.
- `CATALOG_PROMPT` verbatim (ids, names in all scripts, aliases). Rule: `candidates` = every
  catalog id the spoken item could reasonably mean; if the speaker's word maps to two items
  (e.g. "chawal"), list both; if nothing fits, `[]`.
- Pending draft semantics: if a pending draft is given, decide `correction` (changes the same
  entry), `log` + `replaced_pending` (different thing), `cancel`, or — when pending has an open
  question — treat the utterance as the answer and return the completed `log`.
- Language: reply in the language actually spoken; hint is a tie-breaker; Latin-script Hindi
  → Devanagari output. `confirm_text` short, restates the entries with digits.

## Deterministic layer (pure, unit-tested)

`normalizeEntry(raw, language)`:
- `item_id` = `candidates[0]` when exactly one candidate, else `"unknown"` (gaps handle 2+).
- `unit === "none"` and item known: assume the item's base unit, warning `unit_assumed`
  (grams for matcha-like items whose base is kg and quantity ≥ 5 → treat as g).
- Conversions to base: g→kg /1000, ml→l /1000, dozen→pcs ×12, portion/packet/pcs as-is when
  they match the base; `c` only for `temperature_check`. Unconvertible → `quantity_base null`,
  warning `unit_mismatch`. `quantity null` → warning `missing_quantity`.
- `value_inr = round(quantity_base × price)`; null for temperature/cleaning/incident/unknown.
- `item_label = displayName(item_id, language)` else `item_heard`. `stock_after = null`.

`findGap(entries, rawEntries, pendingRound)` → first gap or null, checked in this order:
1. `candidates.length ≥ 2` → `field item_id`, options = candidates as `{value: id, label:
   displayName(id, language)}`.
2. `missing_quantity` on a quantity-bearing action → `field quantity`, options `[]`.
3. `unit_mismatch` → `field unit`, options = units convertible to the item's base.
4. Action unclear is left to the model (it will pick); no gap.
Never ask about `unknown_item` (log it as unknown). Round = `pending.clarification.round + 1`
when continuing a chain, else 1; if that would be 3 → no gap, add warning `unresolved`.

Assembling the `Draft`: `draft_id = crypto.randomUUID()`, `intent` = `needs_clarification` if
a gap else the model's intent, `clarification` built from the gap + question text,
`speak_text` = question or `confirm_text` or a short per-language "didn't get that" for
`unclear` / "cancelled" for `cancel`, `confirm_text` "" unless log/correction, `meta` filled.

`applyEdits(entries, edits, language)`: apply quantity/unit/item_id, re-run
`normalizeEntry`-equivalent on the touched entries (no model). `readback(record)`: one
sentence per language template with digits: "5 किलो पनीर खराब, दर्ज हो गया। बचा 7 किलो।"
(hi/mr), "20 ಲೀಟರ್ ಹಾಲು ಬಂದಿದೆ, ದಾಖಲಾಗಿದೆ. ಉಳಿದಿದೆ 60 ಲೀಟರ್." (kn), English fallback.

`cache.ts`: key = `normalize(text)` (trim, collapse spaces, lowercase Latin, strip trailing
punctuation) + `|` + languageHint + `|` + (pending ? `${pending.draft_id}:${round}` : ""). Value
= the Draft minus `draft_id` (regenerate) with `meta.local_cache_hit = true, llm_ms = 0`. LRU 500.

## Tests (done criteria)

`bun test app/tests/interpreter`:
1. Fixture runner over `interpreter.json` against the real API (needs `ANTHROPIC_API_KEY`;
   skip with a clear message if absent). Exact-match keys, `~script` via Unicode ranges
   (Devanagari U+0900–097F, Kannada U+0C80–0CFF, Tamil U+0B80–0BFF), `~option_values_set`,
   `~warnings_include`, `~meta_local_cache_hit`. Resolve `$prev`/`$case:` references.
   Print `llm_ms` and `prompt_cache_read_tokens` per case.
2. Unit tests for `normalizeEntry` and `findGap` without the API (every rule above).
3. Latency report: median `llm_ms` over the fixture run ≤ 900 ms on Opus 5 effort low; if it
   is not, say so in your final report with the numbers — don't hide it.

## Performance rules

- Exactly one model call on the happy path; ≤ 2 when asking.
- `max_tokens: 1024`; the schema keeps output small.
- Reuse one `Anthropic` client (keeps the HTTPS connection warm).
- Never put anything variable in `system`.
