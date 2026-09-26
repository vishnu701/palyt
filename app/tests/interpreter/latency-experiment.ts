// Not a test. Latency breakdown for the founders' model decision (SPEC §7):
//   bun --env-file=../.env tests/interpreter/latency-experiment.ts     (from app/)
// A = production config · B/C = without structured output · D/E = raw TTFT floor of each model.
// Each variant gets a nonce suffix so it starts from a cold prompt cache.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { SYSTEM_PROMPT } from "../../src/interpreter/prompt";
import { ModelOutput } from "../../src/interpreter/schema";
const client = new Anthropic({ timeout: 20000, maxRetries: 0 });
const format = zodOutputFormat(ModelOutput);
const texts = ["पाँच किलो पनीर खराब हो गया", "दस किलो चावल आया"];
const user = (t: string) => `language_hint: hi-IN\npending_draft: none\ntranscript: ${t}`;
const N = Date.now().toString(36);
const sys = (nonce: string) => [{ type: "text" as const, text: SYSTEM_PROMPT + "\n<!-- " + nonce + " -->", cache_control: { type: "ephemeral" as const } }];

async function streamed(label: string, params: any) {
  const t0 = performance.now(); let ttft = 0; let firstText = 0; let n = 0;
  const s = client.messages.stream(params);
  s.on("streamEvent", (ev: any) => {
    if (!ttft && ev.type === "content_block_start") ttft = Math.round(performance.now() - t0);
    if (ev.type === "content_block_delta") { n++; if (!firstText && ev.delta?.type === "text_delta") firstText = Math.round(performance.now() - t0); }
  });
  const msg = await s.finalMessage();
  const u: any = msg.usage;
  console.log(`${label}: total=${Math.round(performance.now() - t0)}ms first_block=${ttft}ms first_text=${firstText}ms deltas=${n} out=${u.output_tokens} read=${u.cache_read_input_tokens} blocks=${msg.content.map((b: any) => b.type).join(",")}`);
}
// A: current config, streamed. B: no output format (JSON asked in the user turn). C: ping — minimal prompt, no cache, to measure raw RTT+TTFT.
for (const t of texts) await streamed("A adaptive+format ", { model: "claude-opus-5", max_tokens: 1024, thinking: { type: "adaptive" }, output_config: { format, effort: "low" }, system: sys(N + "A"), messages: [{ role: "user", content: user(t) }] });
for (const t of texts) await streamed("B adaptive,no fmt ", { model: "claude-opus-5", max_tokens: 1024, thinking: { type: "adaptive" }, output_config: { effort: "low" }, system: sys(N + "B"), messages: [{ role: "user", content: user(t) + "\nReply with ONLY the JSON object {language,intent,replaced_pending,entries:[{action,candidates,item_heard,quantity,unit,reason,temperature_c,ask_item,ask_quantity,ask_unit}],confirm_text,clarify}." }] });
for (const t of texts) await streamed("C disabled,no fmt ", { model: "claude-opus-5", max_tokens: 1024, thinking: { type: "disabled" }, output_config: { effort: "low" }, system: sys(N + "C"), messages: [{ role: "user", content: user(t) + "\nReply with ONLY the JSON object {language,intent,replaced_pending,entries:[{action,candidates,item_heard,quantity,unit,reason,temperature_c,ask_item,ask_quantity,ask_unit}],confirm_text,clarify}." }] });
for (let i = 0; i < 2; i++) await streamed("D ping (say hi)   ", { model: "claude-opus-5", max_tokens: 5, thinking: { type: "disabled" }, messages: [{ role: "user", content: "hi" }] });
for (let i = 0; i < 2; i++) await streamed("E haiku ping      ", { model: "claude-haiku-4-5", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
