# Wastyd

Voice-based operations logging for restaurant kitchens. Hold a button, say what happened
(in Hindi, Kannada, Marathi, Tamil, Telugu, English or a mix), see a review card in your own
language, hear it read back, confirm with one tap. Inventory, recipes and the owner's dashboard
update live.

**Live demo:** https://demo.palyt.in/ (phone) · https://demo.palyt.in/dashboard (owner) ·
https://demo.palyt.in/present (projector). No login. Grant mic permission, hold the button, speak.

## The problem

Restaurants lose stock nobody records: wastage, deliveries, usage, temperature checks. The
people who know what happened are untrained kitchen staff with wet hands who never touch the
POS and speak in their own language. POS systems capture the counter; we capture the back of
house. Every confirmed entry is a labelled example of noisy, mixed-language kitchen speech.

## Speed

A turn is **sub-second end to end**: from releasing the button to the review card on screen is
typically **0.3–0.8 s** on the deployed system (Mumbai VM, Indian phone network). Where it goes,
all measured, none of it claimed:

| Step | Measured |
|---|---|
| Speech recognition final after release (Sarvam realtime, streamed while holding) | 150–250 ms |
| Interpretation (Sarvam `sarvam-105b-conversations`, India-hosted) | median ≈ 250–300 ms, p99 ≈ 0.5 s |
| Gateway, inventory ledger, broadcast (in-process) | p99 < 2 ms |
| Spoken reply (Sarvam TTS `bulbul:v3`) | ~200–500 ms, **off the critical path**: the card is sent first |

The first turn after a long idle can take ~1 s (a fresh upstream session). The Speed tile on
the dashboard shows the live p50 of release → card for the day; the phone prints each turn's
`stt / llm / total` ms under the card.

For comparison, the same pipeline on Claude Opus 5 (`LLM_PROVIDER` unset) is 2.1–2.5 s per
turn, dominated by ~0.8 s to first token from India plus ~95 output tokens; both providers pass
the same 26-case fixture suite.

## What to try

| Say (or type) | What happens |
|---|---|
| "पाँच किलो पनीर खराब हो गया" | Wastage card: 5 kg paneer, ₹1,750, stock 12 → 7 |
| "ಇಪ್ಪತ್ತು ಲೀಟರ್ ಹಾಲು ಬಂದಿದೆ" (or "20 liter haalu bandide") | Receiving card in Kannada script, even when speech recognition returns Latin letters |
| "दस किलो चावल आया" | Asks aloud "which rice?" — two rice items exist; it never guesses |
| "matcha 20" | Does **not** ask; assumes grams (a wrong guess costs nothing) |
| "चार किलो स्टार फ्रूट खराब" | Asks once: "star fruit isn't in the inventory — which item?"; answer "टमाटर" resolves it; insist and it is logged flagged *not in inventory*, never touching stock |
| "5 kilo paneer aur 4 kilo star fruit kharab" | Two entries; only the unknown one is questioned, paneer is kept |
| "ek plate dal makhani kharab" | Menu item: no stock of its own; dal, butter, cream, tomato and onion drop by one portion's recipe; card shows the breakdown |
| "नहीं, तीन किलो" while a card is showing | Corrects the pending card |
| "पाँच लीटर दूध आया" while a card is showing | New entry replaces the unconfirmed card, says so aloud |
| "रहने दो" | Cancels |

Nothing is saved without a ✓ tap. Every card is read aloud in the speaker's language.

## Architecture

```
browser ──WS (JSON + 16 kHz PCM)──► Bun gateway (one process, GCP asia-south1)
                                      ├─► Sarvam realtime STT  (streams while held; fresh session per turn)
                                      ├─► Interpreter: Sarvam LLM (default) or Claude, + deterministic layer
                                      ├─► Sarvam TTS            (question / confirm / readback, after the card)
                                      └─► JSONL records + in-memory ledger (inventory, recipes, stats)
                                   broadcast record.new / inventory.update / activity to every client
```

- **Stack:** Bun 1.x, TypeScript, zod 4, `@anthropic-ai/sdk`. No web framework, no client
  framework, no database. Deployed as two containers (gateway + Caddy for TLS) on one VM.
- **Push-to-talk, not VAD:** audio only while held; release is end-of-speech. The first frame on
  the socket carries context; STT session and LLM connection are warmed on connect and every
  4 minutes. Partial transcripts stream to the phone and to the dashboard while speaking.
- **The model decides which item and what happened; the code decides every number.** The
  transcript's quantities, unit words, and catalog names (any script) are parsed in code and
  override the model; invalid actions are repaired from the verbs; answers to our own questions
  ("बासमती", "तीन किलो") are resolved in code without a model call; an answer changes only the
  entry it was asked about. This is what lets a ~300 ms model reach 26/26 on the fixtures
  (it scored ~75% alone). Details in `SPEC.md` §7 and `app/src/interpreter/transcript.ts`.
- **Clarification is dynamic, never scripted:** the model lists *candidate* catalog ids; code
  decides to ask (2+ candidates, item not in catalog, missing quantity, unconvertible unit),
  max two questions per turn, options from the catalog in the speaker's language, spoken aloud.
- **Inventory has no CRUD.** Stock = opening + confirmed entries. Menu items (dal makhani,
  paneer butter masala, chicken curry, paneer tikka) are recipes, not stock: logging a portion
  consumes its ingredients; dish price = recipe cost.
- **Reproducibility (there is no seed):** fixed JSON schema validated with zod, all maths in
  code, identical transcript served from a result cache, every record stores `model` and
  `prompt_version`, and what staff confirm is the source of truth.
- **Failure handling:** short hold or silence → "didn't catch that" (STT hallucinates a word on
  silence); STT final missing → last partial after 2.5 s; STT down → typed fallback; model
  error → spoken retry line; TTS failure never blocks; phone sleep → wake lock + reconnect.

Full design record: [`SPEC.md`](SPEC.md). Frozen contracts: [`app/contracts/`](app/contracts).

## Pages

| URL | Who | What |
|---|---|---|
| `/` | staff, judges | Guest banner, hold-to-talk, live transcript, clarification with tap options, review card (±1, other item, ingredient breakdown), saved screen with readback and optional photo |
| `/dashboard` | owner | Tiles (entries, wastage ₹, received ₹, speed), "now on the phone" line, live log grouped by day, Inventory / Recipes panel with per-dish ingredient view |
| `/present` | projector | Five-step pointer rail (← →, `?step=N`), embeds the live dashboard from step 3, QR to the phone app on step 5 |

HTTP: `/healthz`, `/api/catalog`, `/api/records`, `/api/inventory`, `/api/menu`, `/api/stats`,
`POST /api/interpret`, `POST /api/photo/:record_id`, `/photos/:id.jpg`; WebSocket at `/ws`.
Every frame is a zod schema in `app/contracts/protocol.ts`.

## Run locally

```bash
cp .env.example .env            # SARVAM_API_KEY, ANTHROPIC_API_KEY, LLM_PROVIDER=sarvam
cd app && bun install
bun run dev                     # http://localhost:3000  (typed input works without a mic)
```

`GET /healthz` → `{ok, stt, tts, model}`. `POST /api/interpret {"text":"..."}` returns a draft
without the UI. `LLM_PROVIDER` unset switches the interpreter to Claude (`CLAUDE_MODEL`,
default `claude-opus-5`).

## Validate

```bash
cd app
bun test tests/client                              # phone / dashboard / presenter against a mock gateway (19)
bun test tests/gateway                             # protocol replay, ledger + recipes, timeouts, photo, latency (25)
bun --env-file=../.env test tests/interpreter      # 26 real-API fixture cases + offline unit tests (66 on Sarvam)
LLM_PROVIDER= bun --env-file=../.env test tests/interpreter/fixtures.test.ts   # same fixtures on Claude
```

The interpreter suite prints `llm_ms` per case and a median/p90/p99 line. Latest: Sarvam
median 246–308 ms, p99 ≤ 0.6 s, 28/28; Claude median ≈ 2.1 s, 28/28. The gateway suite's
fake-provider run reports the in-process cost of a turn (p99 ≈ 2 ms).

## Repo layout

```
SPEC.md               design record (single source of truth, every decision and why)
app/contracts/        protocol.ts (every WS/HTTP frame as zod), interfaces.ts, catalog.ts (+ recipes), fixtures/
app/public/           phone (/), dashboard, presenter — vanilla JS, no build step
app/src/gateway/      Bun server: WS sessions, Sarvam STT/TTS adapters, ledger, JSONL store
app/src/interpreter/  transcript → Draft: prompt, model schema, transcript.ts (deterministic layer), normalize, gaps, cache
app/tests/            client / gateway / interpreter suites, mock gateway
deploy/               Dockerfile, docker-compose (gateway + Caddy TLS), deploy.sh
```

## Deploy

`deploy/deploy.sh` tars `app/` + `deploy/`, uploads `.env`, and rebuilds the two containers on
the GCP VM (`asia-south1`, next to Sarvam). Caddy terminates TLS for `demo.palyt.in` with an
automatic Let's Encrypt certificate (required for microphone access on phones). Records persist
in `/data/records.jsonl` on the VM; there is deliberately no reset in the UI.

## Team

Vishnu (tech) × Ayush (hospitality). Built during the hackathon; three parallel agents worked
from `SPEC.md` and the frozen contracts.
