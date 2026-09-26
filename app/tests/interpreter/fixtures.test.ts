// Fixture runner: contracts/fixtures/interpreter.json against the REAL Claude API.
// Cases run in order (later cases reference earlier drafts). Skips without ANTHROPIC_API_KEY.
//   bun --env-file=../.env test app/tests/interpreter        (from app/)  or
//   bun --env-file=.env test app/tests/interpreter           (from repo root)
import { describe, expect, test } from "bun:test";
import { Draft } from "../../contracts/protocol";
import fixtures from "../../contracts/fixtures/interpreter.json";
import { createInterpreter } from "../../src/interpreter";

const API_KEY = process.env.ANTHROPIC_API_KEY;
const SCRIPTS: Record<string, RegExp> = {
  Devanagari: /[ऀ-ॿ]/,
  Kannada: /[ಀ-೿]/,
  Tamil: /[஀-௿]/,
  Telugu: /[ఀ-౿]/,
};

interface Case {
  name: string; text: string; languageHint: string | null; pending: string | null; tapAnswer?: boolean;
  expect: Record<string, unknown>;
}

/** Recursively check `expect` against `actual`: plain keys exact, `~` keys by rule. */
function check(actual: any, exp: Record<string, unknown>, path: string, errors: string[], draft: Draft) {
  for (const [key, want] of Object.entries(exp)) {
    const at = path ? `${path}.${key}` : key;
    if (key.startsWith("~")) {
      const texts = [draft.confirm_text, draft.clarification?.question ?? "", draft.speak_text].filter(Boolean);
      switch (key) {
        case "~script": {
          const re = SCRIPTS[want as string]!;
          if (!texts.length || !texts.every((t) => re.test(t))) errors.push(`${at}: expected ${want} script in ${JSON.stringify(texts)}`);
          break;
        }
        case "~language_prefix":
          if (draft.language.slice(0, 2) !== want) errors.push(`${at}: language ${draft.language} !~ ${want}`);
          break;
        case "~option_values_set": {
          const got = (actual?.options ?? []).map((o: any) => o.value).sort();
          if (JSON.stringify(got) !== JSON.stringify([...(want as string[])].sort())) errors.push(`${at}: options ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
          break;
        }
        case "~option_values_include": {
          const got = (actual?.options ?? []).map((o: any) => o.value);
          for (const v of want as string[]) if (!got.includes(v)) errors.push(`${at}: options ${JSON.stringify(got)} lack ${v}`);
          break;
        }
        case "~warnings_include":
          for (const w of want as string[]) if (!(actual?.warnings ?? []).includes(w)) errors.push(`${at}: warnings ${JSON.stringify(actual?.warnings)} lack ${w}`);
          break;
        case "~meta_local_cache_hit":
          if (draft.meta.local_cache_hit !== want) errors.push(`${at}: local_cache_hit=${draft.meta.local_cache_hit}`);
          break;
        default:
          errors.push(`${at}: unknown matcher`);
      }
      continue;
    }
    if (Array.isArray(want)) {
      const arr = actual?.[key];
      if (!Array.isArray(arr)) { errors.push(`${at}: expected array, got ${JSON.stringify(arr)}`); continue; }
      if (arr.length !== want.length) errors.push(`${at}: length ${arr.length} ≠ ${want.length}`);
      want.forEach((w, i) => {
        if (w && typeof w === "object") check(arr[i], w as Record<string, unknown>, `${at}[${i}]`, errors, draft);
        else if (JSON.stringify(arr[i]) !== JSON.stringify(w)) errors.push(`${at}[${i}]: ${JSON.stringify(arr[i])} ≠ ${JSON.stringify(w)}`);
      });
    } else if (want && typeof want === "object") {
      check(actual?.[key], want as Record<string, unknown>, at, errors, draft);
    } else if (JSON.stringify(actual?.[key]) !== JSON.stringify(want)) {
      errors.push(`${at}: ${JSON.stringify(actual?.[key])} ≠ ${JSON.stringify(want)}`);
    }
  }
}

const cases = (fixtures as { cases: Case[] }).cases;
const results: { name: string; llm_ms: number; cache_read: number; cache_hit: boolean; errors: string[] }[] = [];
const byName = new Map<string, Draft>();
const order: Draft[] = [];

function resolvePending(ref: string | null): Draft | null {
  if (ref === null) return null;
  if (ref === "$prev") return order[order.length - 1] ?? null;
  if (ref === "$prev2") return order[order.length - 2] ?? null;
  if (ref.startsWith("$case:")) return byName.get(ref.slice(6)) ?? null;
  throw new Error(`unknown pending ref ${ref}`);
}

function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}

describe.skipIf(!API_KEY)("interpreter.json against the real API", () => {
  const interp = createInterpreter();
  let warmRead: number | null = null;

  test("warm() never throws", async () => {
    const t0 = performance.now();
    await interp.warm();
    console.log(`warm: ${Math.round(performance.now() - t0)} ms`);
  }, 20_000); // first warm after a prompt change writes a fresh cache entry; can exceed bun's 5 s default

  for (const c of cases) {
    test(c.name, async () => {
      const pending = resolvePending(c.pending);
      if (c.pending && !pending) throw new Error(`pending ref ${c.pending} unresolved (earlier case failed?)`);
      const t0 = performance.now();
      const draft = await interp.interpret({ text: c.text, languageHint: c.languageHint, pending, tapAnswer: c.tapAnswer ?? false });
      const wall = Math.round(performance.now() - t0);
      Draft.parse(draft);
      order.push(draft);
      byName.set(c.name, draft);

      const errors: string[] = [];
      check(draft, c.expect, "", errors, draft);
      for (const e of draft.entries) if (e.stock_after !== null) errors.push("stock_after must be null");
      if ((draft.intent === "needs_clarification") !== (draft.clarification !== null)) errors.push("clarification/intent mismatch");
      if (draft.intent !== "log" && draft.intent !== "correction" && draft.confirm_text !== "") errors.push("confirm_text must be empty");

      results.push({ name: c.name, llm_ms: draft.meta.llm_ms, cache_read: draft.meta.prompt_cache_read_tokens, cache_hit: draft.meta.local_cache_hit, errors });
      console.log(
        `${errors.length ? "FAIL" : "ok  "} ${c.name.padEnd(64)} llm_ms=${String(draft.meta.llm_ms).padStart(5)} wall=${String(wall).padStart(5)} ` +
        `cache_read=${draft.meta.prompt_cache_read_tokens} local=${draft.meta.local_cache_hit} intent=${draft.intent} lang=${draft.language}` +
        `\n     speak: ${draft.speak_text}`,
      );
      if (errors.length) {
        console.log("     draft:", JSON.stringify({ intent: draft.intent, entries: draft.entries, clarification: draft.clarification, replaced_pending: draft.replaced_pending }));
        throw new Error(errors.join("\n"));
      }
    }, 30_000);
  }

  test("latency report", () => {
    const modelCalls = results.filter((r) => !r.cache_hit && r.llm_ms > 0);
    const ms = modelCalls.map((r) => r.llm_ms);
    const cacheReadsAfterFirst = modelCalls.slice(1).map((r) => r.cache_read);
    console.log(`\n=== latency: ${modelCalls.length} model calls · median ${pct(ms, 50)} ms · p90 ${pct(ms, 90)} ms · p99 ${pct(ms, 99)} ms · max ${Math.max(...ms)} ms`);
    console.log(`=== prompt cache reads from 2nd call on: ${cacheReadsAfterFirst.join(", ")} (${cacheReadsAfterFirst.every((n) => n > 0) ? "all > 0" : "SOME ZERO"})`);
    console.log(`=== failed: ${results.filter((r) => r.errors.length).map((r) => r.name).join("; ") || "none"}`);
    if (pct(ms, 50) > 900) console.log("=== WARNING: median llm_ms exceeds the 900 ms budget — report to the founders (SPEC §7)");
    expect(results.length).toBe(cases.length);
  });
});

if (!API_KEY) {
  test("fixture runner skipped", () => {
    console.log("ANTHROPIC_API_KEY not set — fixture run skipped. Run: bun --env-file=../.env test app/tests/interpreter");
  });
}
