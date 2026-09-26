# Brief · Gateway agent

You build the Bun server in `app/src/gateway/`. Read `SPEC.md` first. Contracts:
`app/contracts/protocol.ts` (wire), `app/contracts/interfaces.ts` (your seams),
`app/contracts/catalog.ts` (ledger seed), `app/contracts/fixtures/session.json` (protocol
tests). You own `app/package.json` `"start"`, `app/src/gateway/**`, `app/tests/gateway/**`.
You never import from `app/src/interpreter` except its `createInterpreter` factory in `main.ts`;
all tests use your own fakes. Replace `app/server.placeholder.ts` (delete it).

You cannot talk to the other agents. If the contract is missing something, stop and tell the human.

## Deliverables

```
app/src/gateway/index.ts     createGateway(opts): Bun.serve with WS + HTTP routes, static files
app/src/gateway/session.ts   per-connection state machine
app/src/gateway/ledger.ts    inventory replay + stats (pure)
app/src/gateway/store.ts     JSONL RecordStore on <dataDir>/records.jsonl
app/src/gateway/sarvam-stt.ts  SttProvider over Sarvam realtime WS
app/src/gateway/sarvam-tts.ts  TtsProvider over Sarvam REST
app/src/gateway/fakes.ts     FakeInterpreter (replays session.json drafts), FakeStt, FakeTts
app/src/gateway/main.ts      wires real providers + createInterpreter; `bun run start`
app/tests/gateway/*.test.ts
```

`main.ts` reads `PORT` (3000), `DATA_DIR` (`/data`), `SARVAM_API_KEY`, `ANTHROPIC_API_KEY`
(passed through to the interpreter), `CLAUDE_MODEL`. Missing Sarvam key → run with
`stt: null, tts: null` and log a warning; the app still works with typed text.

## Session state machine (one per staff WS)

```
idle ──ptt.start──► listening ──ptt.stop──► finalizing ──stt.final──► interpreting ──draft──► pending
  ▲                                                                                        │
  └──────── draft.confirm / draft.cancel / expired / replaced (new log) ◄──────────────────┘
pending ──ptt.start──► listening (pending kept; passed to interpreter) …
pending ──draft.answer──► interpreting (tapAnswer=true)
```

- `hello` must be the first text frame; anything else before it → `error BAD_MESSAGE`, close.
  On `hello` (staff): create `session_id`, `await stt.open()` (ok/down), fire
  `interpreter.warm()` (don't await), send `ready`.
- Binary frames outside `listening` are dropped silently.
- `ptt.start`: `await session.stt.start()` (reopens if `!alive`), set turn, broadcast
  `activity listening ""`. If STT is down, still accept; on `ptt.stop` reply `error STT_UNAVAILABLE`.
- `stt.partial` → forward to the client as `stt.partial` and to dashboards as
  `activity listening <text>`.
- `ptt.stop`: mark `t0 = now`, call `stt.stop()`; wait for `onFinal` up to `finalTimeoutMs`;
  on timeout use the last partial (log it). Send `stt.final`. Empty text → `error
  EMPTY_TRANSCRIPT` + a TTS clip of a fixed per-language "didn't catch that" line (table in
  `speak.ts`; default Hindi) and back to idle/pending unchanged.
- Interpret: `interpreter.interpret({text, languageHint, pending, tapAnswer:false})`.
  Timeout 8 s → `error INTERPRET_FAILED`. Fill `stock_after` for every entry from the ledger
  (`current + signed quantity_base`), add `exceeds_stock` warning when wastage/usage >
  current, add `low_stt_confidence` when STT confidence < 0.5. Then:
  - `needs_clarification` → pending = draft (round from draft), send `draft`, `tts speak_text`,
    `activity asking`.
  - `log`/`correction` → if a different pending existed, send `draft.cleared {replaced}` for it;
    pending = draft; send `draft`, `tts speak_text`, `activity reviewing <summary>`.
  - `cancel` → clear pending (`draft.cleared cancelled`), send `draft`, `tts`, `activity idle`.
  - `unclear` → send `draft`, `tts`, keep pending as it was.
- `draft.answer` → `interpret({text: value, languageHint: pending.language, pending, tapAnswer: true})`.
- `draft.confirm`: `interpreter.applyEdits` if edits; build `LogRecord` (`edited`,
  `clarified` = any round happened for this draft chain, `timings` = the last draft's);
  `store.append`; ledger apply; send `record.saved`, `draft.cleared confirmed`; broadcast
  `record.new`, `inventory.update`; TTS `interpreter.readback(record)`; `activity idle`.
- Pending expires after `pendingTtlMs` → `draft.cleared expired`.
- `timings`: `stt_ms = final − t0`, `llm_ms` from the interpreter meta, `total_ms = send − t0`
  (for `text`/`draft.answer`, `t0` = message receipt, `stt_ms = null`).
- Dashboards (`role: "dashboard"`) get `ready`, broadcasts and `activity`; never drafts.
- Keep a 4-minute timer calling `interpreter.warm()`.

## Sarvam realtime STT (`sarvam-stt.ts`)

Docs: https://docs.sarvam.ai/api-reference/speech-to-text/transcribe/realtime/ws and the
guide at https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming.
Verified shape:

- URL `wss://api.sarvam.ai/speech-to-text-realtime/ws?language_code=auto&model=saaras:v3-realtime&stream_type=fast&encoding=linear16&sample_rate=16000&endpointing=manual&prompt=<urlenc>&keyterms=<urlenc>`
  Header `api-subscription-key: <key>` (Bun's WebSocket supports `headers`). `prompt` =
  "Restaurant kitchen inventory: items received, used, wasted; temperatures; quantities in kg,
  litre, pieces." `keyterms` = `KEYTERMS.join(",")` from catalog (check their max length; trim).
- Client → `{event:"audio_input", audio:<base64 of the PCM frame>}` (batch two 40 ms frames
  per message if throughput is a problem); `{event:"flush"}` on stop; `{event:"end"}` on close;
  `{event:"ping"}` every 20 s while idle.
- Server → `session.begin`, `transcript.partial {utterance_idx,text,language}`,
  `transcript.final {utterance_idx,text,language,language_confidence}`, `error {code,is_fatal,message}`,
  `pong`, `session.end`.
- `alive` = socket open and no fatal error. `start()` reopens when not alive (< 200 ms).
  With `endpointing=manual`, send `{event:"speech_start"}` on start and `{event:"speech_end"}`
  then `flush` on stop; take the first `transcript.final` after stop as THE final (if several
  arrive, concatenate with spaces). Fallback if `fast` misbehaves: `stream_type=balanced`.
- Do not retry on 4xxx close codes (auth/quota). Log every upstream error with the request id.

## Sarvam TTS (`sarvam-tts.ts`)

`POST https://api.sarvam.ai/text-to-speech` header `api-subscription-key`, body
`{"text": ..., "target_language_code": "hi-IN", "model": "bulbul:v3"}` (v2 is deprecated;
default speaker is fine). Response `{"audios": ["<base64 wav>"]}` — verified ~190 ms.
Map any `xx-IN` we get; unknown → `hi-IN`. Keep-alive the HTTPS connection. Reject after 1500 ms;
a TTS failure must never block the draft (send the `draft` first, then `tts` when ready).

## Ledger (`ledger.ts`, pure)

`replay(records) → Map<item_id, current>` using the SPEC table; `stockAfter(entry)`;
`inventory()` in catalog order with `value_inr`, `low`, `changed_at`; `stats(records)` for
`/api/stats` (IST day boundary, p50/p99 of `timings.total_ms`, `corrected_by_voice` = records
whose chain had a `correction` intent, `clarified` count). Prep adds portions for the dish;
`stock_count` overwrites.

## HTTP

Routes as listed at the bottom of `protocol.ts`. Static: serve `app/public/` with correct
MIME types, `Cache-Control: no-store` for HTML, 1 h for assets. `/api/photo/:record_id`:
multipart `photo`, jpeg ≤ 2 MB, write `<dataDir>/photos/<record_id>.jpg`, update record,
`store.update`, broadcast `record.updated`. `/healthz` reports provider status. Every JSON
response is built from the contract schemas (`parse` before send in dev).

## Tests (done criteria)

`bun test app/tests/gateway` with fakes:
1. Full replay of `session.json` over a real WS on port 0: every expected frame arrives in
   order and parses; `*` fields ignored; dashboard client receives the activity sequence.
2. Ledger: replay table, `stock_count` overwrite, `exceeds_stock`, `stats` percentiles.
3. STT final timeout falls back to the last partial; STT `alive=false` gets reopened on start.
4. Pending TTL expiry sends `draft.cleared expired`.
5. `/api/photo` attaches and broadcasts.
6. Latency: with fakes, `ptt.stop → draft` < 30 ms p99 over 100 turns (no accidental awaits).

Manual (real providers): `bun run start` → speak Hindi/Kannada into `/` on a phone via
`https://demo.palyt.in`; log `timings` for 10 turns; `stt_ms` should be < 300 ms.

## Performance rules

- One process, all state in memory, JSONL append only. No DB, no queue.
- Never `await` TTS or photo work before sending `draft` / `record.saved`.
- Broadcast with one `JSON.stringify` per event (Bun `publish` on a topic), not per client.
- Keep upstream sockets and HTTPS agents warm; never open one on the request path.
