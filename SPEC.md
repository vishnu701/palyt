# Palyt — build spec (single source of truth)

Read this whole file, then your brief in `briefs/`. It records everything the founders and
the planning agent decided; the building agents have no other context and cannot talk to each
other. **`app/contracts/` is frozen.** If you believe the contract must change, stop and tell
the human; do not change it yourself.

Wireframe (eight boards, agreed with the founders): https://claude.ai/artifact/Ku66fj5CCuGdsmh8UaHAPq

---

## 1. What we are building and why

**Context.** Hackathon, a few hours of build time, live demo only (the organizers allow no
business pitch). Founders: Vishnu (tech) and Ayush (hospitality). The product is voice-based
operations logging for restaurant kitchens.

**The problem.** Restaurants lose stock nobody records: wastage, deliveries, usage, temperature
checks, cleaning. The people who know what happened are untrained kitchen staff with wet hands
who speak Hindi, Kannada, Marathi, Tamil, Telugu, or a mix, and who never touch the POS.

**The product in one sentence.** Hold a button, say what happened, see a review card in your
own language, hear it read back, confirm with one tap. Inventory and the owner's dashboard
update live.

**Positioning (for anyone writing copy).** POS systems capture sales at the counter; we capture
the kitchen from the people who never touch the POS. Every confirmed entry is a labelled
example of noisy, mixed-language kitchen speech, which is the durable asset. We integrate with
any POS rather than replace it. Never mention any dictation product by name in the app.

**Inspiration (design, not copy).** The interaction model is borrowed from push-to-talk
dictation tools that reach sub-second p99: hotkey instead of voice-activity detection,
context sent before audio, everything pre-warmed, streaming during speech, tiny model output.
See § 5.

---

## 2. Demo script (what must work on stage)

Two screens in the room:

| Where | URL | Who |
|---|---|---|
| Projector / laptop | `/present` — pointer strip + the live dashboard embedded | Vishnu, talking |
| Vishnu's phone (and judges' phones via QR) | `/` — the phone app in "guest mode" | Ayush first, then judges |

Presenter steps (← → keys; `?step=N`):
1. **Problem.** Kitchens lose stock nobody records · staff are untrained, hands are wet, they
   speak Kannada/Hindi/Marathi · the POS never sees the back of house.
2. **Why voice, why now.** Hold a button, say it, done · answered in their own language, out
   loud · asks when unsure, never guesses.
3. **Watch it.** Live dashboard (empty or seeded), phone in Ayush's hand. Strip says
   "Live · asia-south1 · release → card in ~640 ms".
4. **What it captured.** Same dashboard, now full. Pointers: three languages, one log ·
   wastage in ₹, stock dropping live · "which rice?" was generated, not scripted.
5. **Try it · what's next.** QR to `https://demo.palyt.in/` · every confirmed entry teaches it
   kitchen speech · plugs into any POS · Vishnu × Ayush.

Judges will hold the phone and try it themselves. So the phone app must be self-explanatory to
a stranger in 15 seconds, must never need a login/settings, must never get stuck, and must
recover from any error back to the mic within 3 s. There is **no reset** anywhere (a reset
would wipe the log the audience just watched build up); entries just keep stacking.

Practical: full brightness, Do Not Disturb, mic permission granted before handing over (the
permission dialog kills the moment), phone on a laptop hotspot, not venue Wi-Fi.

---

## 3. Architecture

```
phone/laptop browser ──WS /ws (JSON + binary PCM)──► Gateway (Bun, ONE process, Mumbai VM)
                                                        │  ├─► Sarvam realtime STT  (WS, opened at `hello`, kept warm, reopened on demand)
                                                        │  ├─► Interpreter.interpret()  (in-process; Claude API inside; prompt cache warm)
                                                        │  ├─► Sarvam TTS  (REST, one short clip per spoken line)
                                                        │  └─► RecordStore (JSONL on /data) + in-memory inventory ledger
                                                        └──broadcast record.new / inventory.update / activity to every connected client
```

- **Runtime:** Bun 1.x + TypeScript, zod 4, `@anthropic-ai/sdk`. No web framework, no client
  framework, no database, no queue. All hot-path state in memory; records append to a file.
- **Why one hop through our backend and not phone→Sarvam directly:** Sarvam has no short-lived
  browser tokens (the key would leak), we must process the transcript server-side, and the
  hop costs ~10–30 ms inside India.
- **Pages served by the gateway:** `/` phone, `/dashboard` owner, `/present` projector shell
  (embeds `/dashboard` in an iframe; slides first, dashboard from step 3).
- **Deployment (already live):** GCP project `palyt-dev-test`, Compute Engine `e2-small` in
  `asia-south1-a` (Mumbai; Sarvam is in India, so the backend must be too), static IP
  `8.231.117.221`, DNS `demo.palyt.in` → that IP, Docker Compose with two containers: the
  Bun gateway (port 3000, `/data` volume) and Caddy (TLS via Let's Encrypt, HTTP/3, WebSocket
  pass-through with no buffering). `https://demo.palyt.in/healthz` already answers with a
  trusted cert. Deploy with `deploy/deploy.sh` from the repo root (tars `app/` + `deploy/`,
  uploads `.env`, rebuilds on the VM). Gateway must listen on `PORT` (3000) and serve
  `app/public/` at `/`. Why a VM and not Cloud Run: long-lived WebSockets, zero cold starts,
  one process = one warm STT pool and one warm prompt cache.
- **Secrets:** `.env` at repo root (never committed): `SARVAM_API_KEY`, `ANTHROPIC_API_KEY`,
  `CLAUDE_MODEL`, `SITE_ADDRESS`. Both keys are verified working (Sarvam TTS ~190 ms, Claude
  Opus 5 responds). Gateway also reads `PORT`, `DATA_DIR`.

---

## 4. The three agents

| Agent | Brief | Owns | Builds and tests against |
|---|---|---|---|
| Client | `briefs/01-client.md` | `app/public/` (phone, dashboard, presenter), `app/tests/mock-gateway.ts`, `app/tests/client/` | A mock server replaying `contracts/fixtures/session.json` |
| Gateway | `briefs/02-gateway.md` | `app/src/gateway/`, `app/package.json` `start`, `app/tests/gateway/` | Its own fakes of `Interpreter`, `SttProvider`, `TtsProvider` |
| Interpreter | `briefs/03-interpreter.md` | `app/src/interpreter/`, `app/tests/interpreter/` | `contracts/fixtures/interpreter.json` |

Contracts: `app/contracts/protocol.ts` (every WS/HTTP message as zod schemas),
`app/contracts/interfaces.ts` (code seams Gateway ↔ Interpreter, STT, TTS, store),
`app/contracts/catalog.ts` (demo inventory), `app/contracts/fixtures/`.
**Every frame on the wire must satisfy `ClientMsg.parse` / `ServerMsg.parse`.** A frame that
does not parse is a bug on the sender's side, whoever that is.

---

## 5. Latency rules (the design exists because of these)

1. **Push-to-talk, not voice-activity detection.** Audio is captured only while the button is
   held. Release is the explicit end-of-speech signal: no silence wait. Kitchen noise between
   turns is never sent. This is also the first line of noise defence (see § 9).
2. **Context first.** The first WS frame is `hello`. On it the gateway opens the STT session
   and warms the interpreter, before any audio arrives.
3. **Everything already open.** Mic permission, the WS, the STT session, an HTTPS keep-alive
   to Claude, and the Claude prompt cache are all warm before the button is pressed.
   `Interpreter.warm()` on `hello` and every 4 minutes.
4. **Stream while speaking.** PCM frames (16 kHz, mono, s16le, 40 ms = 1280 bytes) go to STT
   as captured; partial transcripts are shown live on the phone and on the dashboard strip. On
   release only the tail is left. (Yes, partials survive the relay: Sarvam emits
   `transcript.partial` while audio streams and the gateway forwards each one. Live text is a
   nice-to-have; nothing depends on it.)
5. **Small, constrained model output.** Fixed JSON schema, a few hundred tokens. Code does
   all maths, unit conversion and the catalog *decision*.
6. **Nothing slow on the critical path.** TTS is fetched after the draft is sent. Photos are
   attached after save. Records append to a file. The ledger is in memory.

Budgets, measured by the gateway and sent in `timings`: STT final ≤ 300 ms after `ptt.stop`;
interpreter ≤ 800–900 ms on a cached prompt; `ptt.stop → draft` p50 ≤ 900 ms, p99 ≤ 1.5 s.
Timings are shown on the phone (small mono line) and on the dashboard (speed tile), because
"it's fast" must be evidence, not a claim.

---

## 6. Reproducibility (the founders asked for a "seed"; none exists)

The Claude API has no `seed`, and the current models reject `temperature`. Repeatability comes
from design:
- Model output is forced into a fixed JSON schema (`output_config.format`, zod).
- All numbers (unit conversion, ₹ value, stock after) are computed in code, never by the model.
- Identical (normalized transcript, language hint, pending draft) is served from an in-memory
  result cache without a model call.
- Every record stores `meta.model` and `meta.prompt_version`.
- What staff confirm on the review card is the source of truth; the ledger replays confirmed
  records only.

---

## 7. Model choice

**Decided 2026-09-26 (late): the interpreter runs on Sarvam `sarvam-105b-conversations`**
(`LLM_PROVIDER=sarvam`), India-hosted, ~250–350 ms per call, so release → card is ~0.3–0.8 s.
Claude Opus 5 remains available (`LLM_PROVIDER` unset) at ~2.1 s. On its own the Sarvam model
was ~75% accurate (wrong numbers like "dus" → 12, invalid actions, forgetting entries when
answering); it reaches 28/28 on the fixtures only because a **deterministic layer in code**
(`src/interpreter/transcript.ts`, applied to both providers) now owns everything the transcript
states literally:
- quantities and unit words are parsed from the text (hi/mr/kn/ta/te/en number words, Indic
  digits) and override the model when they line up one-to-one with the entries;
- catalog items named in `item_heard` override the model's candidate list ("मक्खन" → butter,
  "chawal" → both rices);
- an invalid action is repaired from the verbs in the text;
- voice answers to our own question are resolved in code first (item names, numbers, units);
- an answer only changes the entry that was asked about; the rest is copied from the pending draft;
- a merged "A aur B" entry is split when the text has two quantities;
- new-entry-vs-correction while a card is pending is decided by comparing items, not by the model.
Rule of thumb that made this work: **the model decides which item and what happened; the code
decides every number.** The Sarvam reasoning model (`sarvam-105b`) is accurate but takes
4–26 s and is not used.

Earlier reasoning, kept for context:

Default **`claude-opus-5`**, adaptive thinking, `effort: "low"`, structured output. Reason:
accuracy on mixed-language, misheard transcripts, and prompt caching works (512-token
minimum). `claude-haiku-4-5` is one env var away (`CLAUDE_MODEL`) for a latency comparison on
stage; note that on Haiku the cacheable minimum is 4096 tokens, larger than our prompt, so
`prompt_cache_read_tokens` stays 0 there. That is expected, not a bug. If Opus median
`llm_ms` exceeds ~900 ms in the Interpreter agent's fixture run, report it; the founders will
decide whether to flip the default.

---

## 8. Languages

Sarvam STT runs with `language_code=auto` and returns a detected `language` plus
`language_confidence`. On 3-second clips this is unreliable (Hinglish may come back as `hi-IN`
or `en-IN`), so it is only a **hint**; the interpreter decides `draft.language` from the
transcript, with the rule Latin-script Hindi → Devanagari Hindi. Everything the staff member
sees or hears (`confirm_text`, `clarification.question`, option labels, `speak_text`, readback)
is in that language and native script. Data fields (`item_id`, `action`, `reason`) are always
English so the dashboard is consistent. Demo languages: hi-IN, kn-IN, mr-IN, en-IN; ta/te
should work.

**Observed with the live adapter (2026-09-26):** Sarvam `saaras:v3-realtime` frequently returns
Indic speech as **Latin-script transliteration tagged `en-IN`** ("5 kg paneer kharab ho gaya",
"20 liter haalu bandide"). The interpreter must infer the language from the vocabulary
(haalu/bandide → kn-IN, kharab/aaya → hi-IN) and answer in native script. `saaras:v4`
translated a Kannada sentence into English on a fresh session, so v3-realtime is the gateway's
default STT model; the gateway also opens a fresh upstream session after every final because
auto-detection otherwise sticks to the previous utterance's language.

---

## 9. Noise (kitchens are loud)

Five layers, in order of effect:
1. Push-to-talk: nothing is captured between turns.
2. Browser: `echoCancellation`, `noiseSuppression`, `autoGainControl` on. A lapel/earphone mic
   for the demo helps a lot.
3. STT hints: Sarvam `prompt` ("restaurant kitchen inventory…") and `keyterms` from the catalog.
4. The interpreter is told the text is from speech recognition and may be garbled; it matches
   against the catalog and asks rather than guesses; STT confidence < 0.5 adds
   `low_stt_confidence`.
5. The review card is the safety net: numbers huge, fixable by voice or tap.

Stretch (not MVP): in-browser RNNoise. Testing tip: record 10–15 real clips with kitchen noise.

---

## 10. Clarification loop (dynamic, never hardcoded)

The founders' requirement: "chawal" with two rice items in the catalog must trigger a question,
never an arbitrary pick; "matcha 20" must *not* trigger a question. And it must generalize to
any item without hardcoding.

**Design (decided after a critical review; this replaces an earlier "deterministic fuzzy
resolver" idea, which cannot work across scripts like ಹಾಲು/haalu/दूध):**
- The **model** sees the full catalog (all names in all scripts, aliases) and returns, per entry,
  `candidates: [catalog ids…]`, best first. It never decides to ask.
- **Code** decides: 1 candidate → use it; 2+ → `needs_clarification` with options built from
  the catalog names in the speaker's language; 0 on a stock action → **ask once**: "star fruit
  isn't in the inventory list — which item do you mean?" (free voice answer, no options). If the
  answer names a catalog item, resolved; if it still isn't one, the card is shown with
  `item_id "unknown"` + warning `unknown_item` (client renders "not in inventory"), no second
  question, and the ledger ignores it. (Changed 2026-09-26 after the founders saw "4 kg star
  fruit wasted" accepted silently; the earlier rule was "log unknown items without asking".)
- Other deterministic gaps, in order: missing quantity → ask (free voice answer); unit that
  cannot convert to the item's base ("do litre paneer") → ask with the valid units. Unit
  merely *missing* with a plausible number → assume the base unit, warning `unit_assumed`,
  no question ("matcha 20" → 20 g). Rule of thumb: ask only when a wrong guess costs money.
- The question **text** is written by the model in the speaker's language from the structured
  gap; option labels come from the catalog. So new items and new gap types need no strings.
- The model may also propose a question of its own for genuinely confusing utterances; code
  accepts it only when no rule-based gap exists.
- **Max two rounds** per turn; afterwards the card is shown with warning `unresolved`.
- Answers arrive by tap (`draft.answer`, value = option value) or by voice (same push-to-talk;
  the interpreter receives the pending draft including its open question).
- The question is spoken aloud (TTS) and shown with tall tap buttons.

**Utterance while a card is pending** (decided): every utterance goes to the model *with* the
pending draft. The model returns `correction` (same entry, changed fields: "nahi, 3 kilo"),
`log` with `replaced_pending: true` (a different thing: the gateway discards the unconfirmed
card and says so aloud), `cancel` ("rehne do"), or the answer to an open question. Nothing is
ever saved without a ✓ tap.

---

## 11. Inventory (no CRUD)

Stock is derived: `current = opening (catalog) + Σ confirmed entries`, signed:

| action | effect on `item_id` stock (in base unit) |
|---|---|
| receiving | + quantity_base |
| usage, wastage | − quantity_base |
| stock_count | = quantity_base (overwrite) |
| prep, usage, wastage of a **menu item** | menu items have no stock; n portions consume n × the recipe from the ingredients (added 2026-09-26: `RECIPES` in `contracts/catalog.ts`; dish price = recipe cost) |
| prep of a raw item | + quantity_base |
| temperature_check, cleaning, incident | none |

**Menu items** (dal makhani, paneer butter masala, chicken curry, paneer tikka) are listed, not
stocked: "ek plate dal makhani kharab" pulls dal, butter, cream, tomato and onion down together.
The gateway fills `Entry.ingredients` (per-ingredient quantity, ₹, stock after); the phone card
shows "इसमें गया: …", the dashboard log row shows "↳ …", and a **Menu** panel shows cost per portion
and "portions possible from stock" with the limiting ingredient. `GET /api/menu`. Receiving or
counting a dish is ignored. No sub-recipes; no recipe editing.

Nothing is editable on the dashboard; a wrong entry is fixed by cancelling the record (ledger
must support replay; a cancel UI is out of scope). Every `Entry` carries `stock_after`, filled by
the gateway before the draft is sent, so the card says "बचा: 12 → 7 किलो". `low` =
`current < low_threshold`. `exceeds_stock` is a warning, never a block. Inventory panel on the
dashboard shows bar (current/opening), ₹ value, "↓ just now", "low".

---

## 12. Voice feedback (TTS)

Spoken on **every** response: the clarification question, the confirm question on the card,
the post-save readback ("5 किलो पनीर खराब, दर्ज हो गया। बचा 7 किलो।"), "didn't catch that",
"cancelled". Sarvam `bulbul:v3` REST (v2 is deprecated), one short clip per line, ~200–500 ms,
delivered as a `tts` frame with base64 WAV **after** the `draft`/`record.saved` frame so it
never delays the card. **`ptt.start` stops any playing clip** (otherwise the mic hears the phone).
Streaming TTS was considered and dropped: fiddly in mobile browsers, no gain on one sentence.

---

## 13. Photo on wastage (optional, after save)

Decided: the camera button lives on the **Saved** screen ("add photo") for records with a
`wastage` entry, never on the review card, so confirm stays instant and a laptop demo without a
camera loses nothing. Client resizes to ≤ 1024 px JPEG and `POST /api/photo/:record_id`;
gateway stores `/data/photos/<id>.jpg`, sets `photo_url`, broadcasts `record.updated`;
dashboard shows a thumbnail. Sending the photo to the model for a plausibility check is **cut**.

---

## 14. Dashboard "Now on the phone" strip

Instead of mirroring the phone UI on the projector (judged too fiddly), the gateway broadcasts
`activity` events to dashboards at these moments: `listening` (with the growing live
transcript), `thinking`, `asking` (the question), `reviewing` (card summary), `idle`. The
dashboard renders a one-line strip above the log. Combined with the log row flashing on
`record.new` and the inventory bar moving, the audience sees both sides of the conversation.

---

## 15. Failure handling (all decided)

- STT down → `ready.stt "down"`, typed text still works; phone shows the text box.
- STT final missing after release → gateway uses the last partial after 2.5 s.
- Empty transcript → `error EMPTY_TRANSCRIPT` + spoken "didn't catch that", back to mic.
- Interpreter > 8 s or refusal → `error INTERPRET_FAILED`, spoken line, back to mic.
- TTS failure → silent; never blocks.
- Phone screen sleep → Wake Lock; WS reconnect with `hello` on close; mic greyed while offline.
- Sarvam session dies while idle (their idle timeout is unknown) → `SttSession.start()` checks
  `alive` and reopens (< 200 ms) before the first frame.
- Pending draft older than 90 s → `draft.cleared expired`.
- Multiple judges at once → one session each; single process handles it; if Sarvam rate-limits,
  typed fallback still works.

Things deliberately **cut** from the MVP: photo → model check, streaming TTS, deterministic
fuzzy resolver, prep ingredient deduction, inventory editing, any reset, RNNoise.

---

## 16. Done criteria (the human runs these)

```
bun test app/tests/client        # Client:      session.json replays through the mock; DOM assertions
bun test app/tests/gateway       # Gateway:     protocol replay, ledger, timeouts, photo, latency with fakes
bun test app/tests/interpreter   # Interpreter: interpreter.json passes; normalize/gaps unit tests; latency report
bun run start                    # serves app/public at /, /healthz {ok:true}
deploy/deploy.sh                 # then https://demo.palyt.in on a real phone
```

---

## 17. Repo layout

```
SPEC.md                     this file
briefs/01-client.md 02-gateway.md 03-interpreter.md
app/
  contracts/                FROZEN — protocol.ts, interfaces.ts, catalog.ts, fixtures/{interpreter,session}.json
  public/                   Client
  src/gateway/              Gateway (+ fakes.ts)
  src/interpreter/          Interpreter
  tests/{client,gateway,interpreter}/ · tests/mock-gateway.ts
  package.json              Gateway owns "start"; deps: zod, @anthropic-ai/sdk (installed)
  server.placeholder.ts     delete when the gateway lands
deploy/                     Dockerfile, docker-compose.yml, Caddyfile, deploy.sh (live)
.env                        secrets (never committed); .env.example documents it
```
