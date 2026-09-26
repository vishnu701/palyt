# KitchenVoice

Voice-based operations logging for restaurant kitchens. Hold a button, say what happened
(in Hindi, Kannada, Marathi, Tamil, Telugu, English or a mix), see a review card in your own
language, hear it read back, confirm with one tap. Inventory and the owner's dashboard update
live.

**Live demo:** https://demo.palyt.in/ (phone) · https://demo.palyt.in/dashboard (owner) ·
https://demo.palyt.in/present (projector). No login. Grant mic permission, hold the button, speak.

## The problem

Restaurants lose stock nobody records: wastage, deliveries, usage, temperature checks. The
people who know what happened are untrained kitchen staff with wet hands who never touch the
POS and speak in their own language. POS systems capture the counter; we capture the back of
house. Every confirmed entry is a labelled example of noisy, mixed-language kitchen speech.

## What to try

| Say (or type) | What happens |
|---|---|
| "पाँच किलो पनीर खराब हो गया" | Wastage card: 5 kg paneer, ₹1750, stock 12 → 7 |
| "ಇಪ್ಪತ್ತು ಲೀಟರ್ ಹಾಲು ಬಂದಿದೆ" | Receiving card in Kannada |
| "दस किलो चावल आया" | Asks "which rice?" — two rice items exist; it never guesses |
| "matcha 20" | Does **not** ask; assumes grams (wrong guess costs nothing) |
| "नहीं, तीन किलो" while a card is showing | Corrects the pending card |
| "रहने दो" | Cancels |
| "तीन किलो ब्रोकली आया" | Logged as unknown item, no question |

Numbers, unit conversion and the catalog decision are done in code, never by the model.
Nothing is saved without a ✓ tap. Latency is shown on the phone and on the dashboard's Speed
tile — it is measured, not claimed.

## Architecture

```
browser ──WS (JSON + PCM)──► Bun gateway (one process, Mumbai VM)
                               ├─► Sarvam realtime STT   (streams while the button is held)
                               ├─► Claude (claude-opus-5) structured output, prompt cached
                               ├─► Sarvam TTS bulbul:v3  (spoken question / confirm / readback)
                               └─► JSONL records + in-memory inventory ledger
                            broadcast record.new / inventory.update / activity to all clients
```

- **Stack:** Bun 1.x, TypeScript, zod 4, `@anthropic-ai/sdk`. No framework, no database.
- **Push-to-talk, not VAD:** audio only while held; release is end-of-speech. Context sent
  before audio; STT session, HTTPS keep-alive and Claude prompt cache are all warmed on connect.
- **Clarification is dynamic:** the model returns *candidate* catalog ids; code decides to ask
  (2+ candidates, missing quantity, unconvertible unit), max two rounds, options from the
  catalog in the speaker's language.
- **Reproducibility:** fixed JSON schema, all maths in code, identical transcript served from a
  result cache; every record stores `model` and `prompt_version`.

Full design record: [`SPEC.md`](SPEC.md). Contracts (frozen): [`app/contracts/`](app/contracts).

## Run locally

```bash
cp .env.example .env            # fill SARVAM_API_KEY, ANTHROPIC_API_KEY
cd app && bun install
bun run dev                     # http://localhost:3000  (typed input works without a mic)
```

`GET /healthz` → `{ok:true, stt, tts, model}`. `POST /api/interpret {"text":"..."}` returns a
draft for quick checks without the UI.

## Validate

```bash
cd app
bun test tests/client                     # phone / dashboard / presenter against a mock gateway
bun test tests/gateway                    # protocol replay, ledger, timeouts, photo
bun --env-file=../.env test tests/interpreter   # 20 real-API fixtures + unit tests + latency report
```

The interpreter suite prints `llm_ms` and `prompt_cache_read_tokens` per case and a median/p99
line. Current numbers (claude-opus-5, adaptive thinking, low effort): 20/20 fixtures pass,
median ≈ 3.0 s, p99 ≈ 4.7 s. That is above our 900 ms design budget: it is the model's
time-to-first-token (~2 s even for a 5-token reply), not the prompt or the network.
`tests/interpreter/latency-experiment.ts` reproduces the breakdown. `CLAUDE_MODEL=claude-haiku-4-5`
is ~0.5–1 s faster and one env var away.

## Repo layout

```
SPEC.md               design record (single source of truth)
briefs/               per-agent build briefs (client, gateway, interpreter)
app/contracts/        protocol.ts (every WS/HTTP frame as zod), interfaces.ts, catalog.ts, fixtures/
app/public/           phone (/), dashboard, presenter — vanilla JS, no build step
app/src/gateway/      Bun server: WS, Sarvam STT/TTS adapters, ledger, JSONL store
app/src/interpreter/  transcript → Draft: prompt, model schema, normalize, gaps, cache
app/tests/            client / gateway / interpreter suites
deploy/               Dockerfile, docker-compose (gateway + Caddy TLS), deploy.sh
```

## Deploy

`deploy/deploy.sh` tars `app/` + `deploy/`, uploads `.env`, and rebuilds the two containers on
the GCP VM (`asia-south1`, next to Sarvam). Caddy terminates TLS for `demo.palyt.in`.

## Team

Vishnu (tech) × Ayush (hospitality). Built during the hackathon; three parallel agents worked
from `SPEC.md` and the frozen contracts.
