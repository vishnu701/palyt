// Entry point: `bun run start`. Wires real providers; falls back to fakes when keys or the
// interpreter module are missing so the gateway always boots.
import { join } from "node:path";
import { createGateway } from "./index";
import { JsonlStore } from "./store";
import { SarvamSttProvider } from "./sarvam-stt";
import { SarvamTtsProvider } from "./sarvam-tts";
import { FakeInterpreter } from "./fakes";
import type { Interpreter } from "../../contracts/interfaces";

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.DATA_DIR ?? join(import.meta.dir, "../../../data");
const PUBLIC_DIR = process.env.PUBLIC_DIR ?? join(import.meta.dir, "../../public");
const SARVAM = process.env.SARVAM_API_KEY?.trim();

async function loadInterpreter(): Promise<Interpreter> {
  if (!process.env.ANTHROPIC_API_KEY) { console.warn("[main] ANTHROPIC_API_KEY missing → FakeInterpreter"); return new FakeInterpreter(); }
  try {
    const modPath = "../interpreter/index.ts"; // built by the Interpreter agent; resolved at runtime
    const mod = (await import(modPath)) as { createInterpreter?: (o?: { model?: string }) => Interpreter };
    if (!mod.createInterpreter) throw new Error("createInterpreter not exported");
    const it = mod.createInterpreter({ model: process.env.CLAUDE_MODEL });
    console.log(`[main] interpreter: real (${process.env.CLAUDE_MODEL ?? "claude-opus-5"})`);
    return it;
  } catch (err) {
    console.warn(`[main] real interpreter unavailable (${(err as Error).message}) → FakeInterpreter`);
    return new FakeInterpreter();
  }
}

const gw = await createGateway({
  port: PORT,
  interpreter: await loadInterpreter(),
  stt: SARVAM ? new SarvamSttProvider({ apiKey: SARVAM, model: process.env.SARVAM_STT_MODEL ?? "saaras:v3-realtime", streamType: (process.env.SARVAM_STREAM as "fast" | "balanced") ?? "fast" }) : null,
  tts: SARVAM ? new SarvamTtsProvider(SARVAM) : null,
  store: new JsonlStore(DATA_DIR),
  publicDir: PUBLIC_DIR,
  dataDir: DATA_DIR,
});
if (!SARVAM) console.warn("[main] SARVAM_API_KEY missing → STT/TTS down; typed text still works");
console.log(`[main] gateway on :${gw.port}  public=${PUBLIC_DIR}  data=${DATA_DIR}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, async () => { await gw.stop(); process.exit(0); });
