// Sarvam text-to-speech, REST, one short clip per line (SPEC §12). Verified: bulbul:v3, ~190 ms.
import type { TtsProvider } from "../../contracts/interfaces";

const SUPPORTED = new Set(["hi-IN", "bn-IN", "kn-IN", "ml-IN", "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN", "en-IN", "gu-IN"]);

export class SarvamTtsProvider implements TtsProvider {
  constructor(private readonly apiKey: string, private readonly timeoutMs = 1500) {}

  async synthesize(text: string, language: string): Promise<{ audio_b64: string }> {
    const lang = SUPPORTED.has(language) ? language : `${language.slice(0, 2)}-IN`;
    const res = await fetch("https://api.sarvam.ai/text-to-speech", {
      method: "POST",
      headers: { "api-subscription-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text, target_language_code: SUPPORTED.has(lang) ? lang : "hi-IN", model: "bulbul:v3" }),
      signal: AbortSignal.timeout(this.timeoutMs),
      keepalive: true,
    });
    if (!res.ok) throw new Error(`sarvam tts ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { audios?: string[] };
    const audio_b64 = body.audios?.[0];
    if (!audio_b64) throw new Error("sarvam tts: empty audio");
    return { audio_b64 };
  }
}
