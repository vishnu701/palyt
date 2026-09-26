// Shared by the phone app, the dashboard and the presenter. Plain ES module, no build step.

// ── Words in the staff member's language (UI chrome stays English) ───────────
export const UNIT_WORDS = {
  en: { kg: "kg", g: "g", l: "L", ml: "ml", pcs: "pcs", dozen: "dozen", portion: "portions", packet: "packets", c: "°C", none: "" },
  hi: { kg: "किलो", g: "ग्राम", l: "लीटर", ml: "मिली", pcs: "पीस", dozen: "दर्जन", portion: "प्लेट", packet: "पैकेट", c: "°C", none: "" },
  kn: { kg: "ಕಿಲೋ", g: "ಗ್ರಾಂ", l: "ಲೀಟರ್", ml: "ಮಿಲಿ", pcs: "ಪೀಸ್", dozen: "ಡಜನ್", portion: "ಪ್ಲೇಟ್", packet: "ಪ್ಯಾಕೆಟ್", c: "°C", none: "" },
  mr: { kg: "किलो", g: "ग्रॅम", l: "लिटर", ml: "मिली", pcs: "नग", dozen: "डझन", portion: "प्लेट", packet: "पॅकेट", c: "°C", none: "" },
  ta: { kg: "கிலோ", g: "கிராம்", l: "லிட்டர்", ml: "மில்லி", pcs: "எண்ணம்", dozen: "டஜன்", portion: "தட்டு", packet: "பாக்கெட்", c: "°C", none: "" },
  te: { kg: "కిలో", g: "గ్రాము", l: "లీటర్", ml: "మిల్లీ", pcs: "ముక్కలు", dozen: "డజను", portion: "ప్లేట్", packet: "ప్యాకెట్", c: "°C", none: "" },
};
export const WORDS = {
  en: { left: "Left", somethingElse: "Something else", yes: "Yes", no: "No" },
  hi: { left: "बचा", somethingElse: "कुछ और", yes: "हाँ", no: "नहीं" },
  kn: { left: "ಉಳಿದಿದೆ", somethingElse: "ಬೇರೆ", yes: "ಹೌದು", no: "ಇಲ್ಲ" },
  mr: { left: "शिल्लक", somethingElse: "दुसरं काही", yes: "हो", no: "नाही" },
  ta: { left: "மீதம்", somethingElse: "வேறு ஏதாவது", yes: "ஆம்", no: "இல்லை" },
  te: { left: "మిగిలింది", somethingElse: "ఇంకేదైనా", yes: "అవును", no: "కాదు" },
};
export const ACTION_LABEL = {
  receiving: "Received", usage: "Used", wastage: "Wasted", prep: "Prepped", stock_count: "Counted",
  temperature_check: "Temp check", cleaning: "Cleaning", incident: "Incident",
};
export const WARNING_LABEL = {
  unit_assumed: "unit assumed", unit_mismatch: "unit mismatch", missing_quantity: "no quantity", unknown_item: "unknown item",
  exceeds_stock: "more than in stock", low_stt_confidence: "low confidence", unresolved: "unresolved",
};
export const LANG_TAG = { "hi-IN": "hi", "kn-IN": "kn", "mr-IN": "mr", "ta-IN": "ta", "te-IN": "te", "en-IN": "en" };

export const lang2 = (bcp) => (bcp || "en").slice(0, 2);
export const unitWord = (unit, language) => (UNIT_WORDS[lang2(language)] || UNIT_WORDS.en)[unit] ?? unit ?? "";
export const word = (key, language) => (WORDS[lang2(language)] || WORDS.en)[key] ?? WORDS.en[key];
export const langTag = (bcp) => LANG_TAG[bcp] || lang2(bcp);

// ── Numbers ──────────────────────────────────────────────────────────────────
const nf = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });
const nf0 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
export const fmtNum = (n) => (n == null || Number.isNaN(n) ? "–" : nf.format(n));
export const fmtInr = (n) => (n == null ? "" : "₹" + nf0.format(Math.round(n)));
export const fmtTimeIst = (iso) => new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });

// ── Unit conversion for local recompute on the review card (display only) ───
const TO_BASE = {
  kg: { kg: 1 }, g: { kg: 0.001 }, l: { l: 1 }, ml: { l: 0.001 }, pcs: { pcs: 1 }, dozen: { pcs: 12 },
  portion: { portion: 1 }, packet: {}, c: { c: 1 }, none: { kg: 1, l: 1, pcs: 1, portion: 1, c: 1 },
};
export function toBase(quantity, unit, base) {
  if (quantity == null || !base) return null;
  const f = TO_BASE[unit]?.[base];
  return f == null ? null : Math.round(quantity * f * 1000) / 1000;
}

// ── Catalog helpers ──────────────────────────────────────────────────────────
export function catalogName(catalog, id, language) {
  const item = catalog?.find((i) => i.id === id);
  if (!item) return id;
  return item.names[lang2(language)] || item.names.en;
}

// ── WebSocket with reconnect (0.5 s → 4 s) and hello-first ──────────────────
export function wsUrlFor(loc) {
  return (loc.protocol === "https:" ? "wss://" : "ws://") + loc.host + "/ws";
}
export function clientId(storage) {
  try {
    let id = storage.getItem("kv_client_id");
    if (!id) {
      id = globalThis.crypto?.randomUUID ? crypto.randomUUID() : "c-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      storage.setItem("kv_client_id", id);
    }
    return id;
  } catch { return "c-" + Math.random().toString(36).slice(2); }
}
export function connect({ url, role, clientId: cid, onMsg, onStatus, WebSocketImpl, pingMs = 25000 }) {
  const WS = WebSocketImpl || globalThis.WebSocket;
  let ws = null, backoff = 500, closed = false, timer = null, pinger = null, attempts = 0;
  const status = (s) => { try { onStatus?.(s); } catch {} };
  function open() {
    attempts++;
    ws = new WS(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => { backoff = 500; send({ type: "hello", client_id: cid, role }); status("open"); };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      let m; try { m = JSON.parse(e.data); } catch { return; }
      try { onMsg(m); } catch (err) { console.error("onMsg", err); }
    };
    ws.onclose = () => { status("closed"); if (!closed) { timer = setTimeout(open, backoff); backoff = Math.min(4000, backoff * 2); } };
    ws.onerror = () => {};
  }
  function send(obj) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; } return false; }
  function sendBinary(buf) { if (ws && ws.readyState === 1) ws.send(buf); }
  open();
  if (pingMs > 0) pinger = setInterval(() => send({ type: "ping" }), pingMs);
  return {
    send, sendBinary,
    get isOpen() { return !!ws && ws.readyState === 1; },
    get attempts() { return attempts; },
    close() { closed = true; clearTimeout(timer); clearInterval(pinger); try { ws?.close(); } catch {} },
  };
}

// ── TTS playback: one clip at a time, stop() on ptt.start ───────────────────
export function b64ToBytes(b64) {
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function createPlayer(getCtx) {
  let current = null, gen = 0;
  async function play(b64) {
    const ctx = getCtx();
    if (!ctx) return false;
    stop();
    const my = ++gen;
    try {
      const bytes = b64ToBytes(b64);
      const buf = await new Promise((res, rej) => {
        const p = ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), res, rej);
        if (p && p.then) p.then(res, rej);
      });
      if (my !== gen) return false; // a newer play()/stop() happened while decoding
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.onended = () => { if (current === src) current = null; };
      src.start(0);
      current = src;
      return true;
    } catch (err) { console.warn("tts play failed", err); return false; }
  }
  function stop() { gen++; if (current) { try { current.stop(0); } catch {} current = null; } }
  return { play, stop, get playing() { return !!current; } };
}

// ── Mic capture: AudioWorklet → 16 kHz s16le 40 ms frames ───────────────────
export async function createCapture(ctx, { workletUrl = "/audio-worklet.js", mediaDevices = navigator.mediaDevices } = {}) {
  const stream = await mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  await ctx.audioWorklet.addModule(workletUrl);
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm16k", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
  const sink = ctx.createGain();
  sink.gain.value = 0; // Safari only runs the graph when it reaches the destination
  src.connect(node); node.connect(sink); sink.connect(ctx.destination);
  let onFrame = null, onStopped = null;
  node.port.onmessage = (e) => {
    if (!e.data) return;
    if (e.data.pcm && onFrame) onFrame(e.data.pcm, e.data.level);
    if (e.data.stopped && onStopped) { const f = onStopped; onStopped = null; f(); }
  };
  return {
    start(cb) { onFrame = cb; node.port.postMessage({ cmd: "start" }); },
    /** Resolves once the worklet has flushed its tail frame (or after 40 ms). */
    stop() {
      return new Promise((res) => {
        let done = false;
        const finish = () => { if (done) return; done = true; onFrame = null; res(); };
        onStopped = finish;
        node.port.postMessage({ cmd: "stop" });
        setTimeout(finish, 40);
      });
    },
    get stream() { return stream; },
  };
}

// ── Misc DOM helpers ─────────────────────────────────────────────────────────
export function el(doc, tag, attrs = {}, children = []) {
  const n = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.appendChild(typeof c === "string" ? doc.createTextNode(c) : c);
  return n;
}
