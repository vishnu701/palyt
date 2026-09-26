# Brief · Client agent

You build everything the user sees, as static files in `app/public/`. Read `SPEC.md` first.
The wire contract is `app/contracts/protocol.ts`; the scripted conversation you develop
against is `app/contracts/fixtures/session.json`. The wireframe (eight boards) is the design:
phone screens Guest → Listening → Clarify → Review → Saved, the Dashboard, the Presenter
view and the Flow map. Match it closely; it was agreed with the founders.

You cannot talk to the Gateway or Interpreter agents. If the contract is missing something
you need, stop and tell the human.

## Deliverables

```
app/public/index.html        phone app  (served at /)
app/public/dashboard.html    owner view (served at /dashboard)
app/public/present.html      projector  (served at /present)
app/public/*.js, *.css       plain TS compiled with `bun build`, or plain JS; no framework, no bundler config beyond one bun build line
app/public/audio-worklet.js  mic capture worklet
app/tests/mock-gateway.ts    fake server replaying fixtures/session.json (Bun.serve + WebSocket), `bun run app/tests/mock-gateway.ts` → http://localhost:3001
app/tests/client/*.test.ts   DOM/protocol tests (bun test; happy-dom or jsdom)
```

Fonts: IBM Plex Sans + Noto Sans Devanagari/Kannada/Tamil/Telugu from Google Fonts (link tag;
preconnect). Palette from the wireframe: ground `#f4f1ea`, ink `#1c1b19`, orange `#c2410c`,
green `#1f7a4d`, blue `#35507a`, card `#ffffff` with `#e0d9ca` border.

## Phone app (`/`)

Single page, four states driven by one WS connection. All copy the staff member sees is in
the language of the *draft* (`draft.language`); UI chrome (banner, hints) is English as in
the Guest board.

**Connect.** On load: `new WebSocket(wss://<host>/ws)`; first frame `hello {client_id: uuid
stored in localStorage, role: "staff"}`. Show green dot on `ready`; grey the mic while not
connected. Reconnect on close with backoff 0.5 s → 4 s, re-send `hello`. Request the Wake
Lock API (`navigator.wakeLock.request("screen")`) after the first tap; re-request on
`visibilitychange`.

**Audio capture.** Ask for the mic on the first touch of the button (mobile browsers require a
gesture). `getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression:
true, autoGainControl: true}})`. Run an `AudioWorklet` that downsamples the context rate
(often 48 kHz) to 16 kHz, converts Float32 → Int16 LE, and posts 640-sample (40 ms, 1280 byte)
frames. Keep the stream open between turns; only *send* between `ptt.start` and `ptt.stop`.
iOS: create/resume the `AudioContext` inside that same first touch handler, otherwise both
capture and playback stay muted.

**Push-to-talk.** `pointerdown` → `ptt.start {turn}` then stream frames; `pointerup` /
`pointercancel` / `pointerleave` → `ptt.stop {turn}`. `turn` increments per press.
`touch-action: none`, `user-select: none`, suppress the context menu on long press. While
held: red state, waveform, live text from `stt.partial` (last partial replaces the whole
line; render trailing portion grey as in the Listening board). On release show "…" until the
`draft` arrives. If nothing arrives in 4 s show "Taking longer than usual" and keep waiting;
on `error` speak nothing, show the message for 3 s, return to idle.

**TTS playback.** On `tts` decode `audio_b64` (WAV) with `AudioContext.decodeAudioData` and
play. On `ptt.start` stop any playing clip immediately (kills echo into the mic).

**Draft rendering** by `draft.intent`:
- `log` / `correction` → Review board. One card per entry (stack vertically for multiple).
  Number huge, unit, `item_label`, `reason`, `value_inr`, `stock_after` line ("बचा: 7 किलो"
  — build it from `item_label`, the number and the unit word; the model doesn't give it),
  warnings as small amber chips (map codes to English text), `confirm_text` with speaker icon.
  Buttons: −1 / +1 / other item (a list of catalog names in `draft.language` from
  `/api/catalog`) → these send `draft.confirm {edits}` only when ✓ is tapped; the card
  recomputes `value_inr` locally as `quantity × price` for display until then. ✓ → `draft.confirm`.
  ✕ → `draft.cancel`. Mic → normal ptt (the gateway knows a draft is pending).
  If `replaced_pending` is true, show a one-line toast "Previous entry discarded".
- `needs_clarification` → Clarify board. `clarification.question` large, options as tall
  buttons with `label` (+ stock hint if you can find the item in `/api/inventory`), a
  "something else" button that just focuses the mic, mic for voice answer. Tap → `draft.answer
  {draft_id, value}`. Footer "round N of 2".
- `unclear` / `cancel` → brief toast with `speak_text`, back to idle.

**Saved** (`record.saved`) → Saved board: green panel with the readback (the `tts` frame that
follows carries the text; show it), today's list from `record.new` events (keep last 10 in
memory; on load fetch `/api/records?limit=10`), optional **Add photo** button on the newest
record if it has a `wastage` entry: `<input type=file accept=image/* capture=environment>`,
resize to ≤ 1024 px JPEG 0.8 in a canvas, `POST /api/photo/<record_id>` multipart field
`photo`. Show thumbnail from `photo_url` on success. Never block anything on it.

**Guest mode** is simply the idle state (Guest board): banner + four example lines. No
settings, no login, no reset.

## Dashboard (`/dashboard`)

Connect with `role: "dashboard"`. On load fetch `/api/stats`, `/api/records?limit=50`,
`/api/inventory`; then update from `record.new` / `record.updated` / `inventory.update` /
`activity`. Layout per the Dashboard board: four tiles (entries, wastage ₹, received ₹, speed
p50/p99), live log (time IST, action, transcript in original script with language tag and
"asked" marker when `record.clarified`, entry summary, value, photo thumbnail), inventory
panel (bar = current/opening, red when `low`, "↓ just now" for 5 s when `changed_at` is new).
**Activity strip** above the log: `listening` → red dot + live text; `thinking` → "…";
`asking` → blue "asked: <text>"; `reviewing` → "reviewing: <text>"; `idle` → strip collapses.
New `record.new` rows flash orange for 2 s. Refetch `/api/stats` after every `record.new`.

## Presenter (`/present`)

Static shell per the Present board. Dark pointer strip with 5 steps; ← → and Space move;
`?step=N` deep-links. Steps 1–2: three lines each (copy in `SPEC.md` § Presenter copy).
Step 3–4: an `<iframe src="/dashboard">` fills the area (mounted from load, hidden behind
steps 1–2, so it's live the moment it appears). Left rail shows the step's pointers; step 5
adds a QR (generate client-side; any small inline QR routine or an `<img>` from
`/api/qr` is NOT available — encode with a ~100-line QR implementation you include, or draw
the URL large as fallback) pointing at `https://demo.palyt.in/`.

## Tests (done criteria)

`bun test app/tests/client` must:
1. Replay `session.json` through the mock gateway and assert the DOM reaches each state
   (listening text visible, clarify options rendered with the fixture labels, review card
   shows `5`/`किलो`/`₹1,750`-style values, saved panel, dashboard rows and inventory).
2. Assert every frame the client sends parses with `ClientMsg.parse`, in the fixture order.
3. Assert `ptt.start` stops a playing clip (stub AudioContext).
4. Assert reconnect re-sends `hello`.

Manual: open `/` on an Android phone and an iPhone via `https://demo.palyt.in` (once the
gateway is deployed) — mic prompt appears on first touch, hold-to-talk streams, TTS audible.

## Performance rules

- One WS, opened at load. No per-turn fetches on the critical path (`/api/catalog` and
  `/api/inventory` are fetched once and cached; refresh on `inventory.update`).
- No layout thrash while streaming partials: update one text node.
- Total JS ≤ 60 KB gzipped. No frameworks.
