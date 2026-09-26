// KitchenVoice phone app. One WebSocket, four states: idle → listening → (clarify | review) → saved.
// boot(opts) is exported so tests can inject a fake capture, a stub AudioContext and the mock's URLs.
import {
  connect, wsUrlFor, clientId, createPlayer, createCapture, el, fmtNum, fmtInr, fmtTimeIst, unitWord, word,
  ACTION_LABEL, WARNING_LABEL, toBase, catalogName, langTag,
} from "./common.js";

export function boot(opts = {}) {
  const doc = opts.document || document;
  const win = opts.window || window;
  const fetchImpl = opts.fetchImpl || ((u, o) => fetch(u, o));
  const httpBase = opts.httpBase ?? "";
  const wsUrl = opts.wsUrl || wsUrlFor(win.location);
  const storage = opts.storage || safeStorage(win);
  const $ = (id) => doc.getElementById(id);

  const S = {
    status: "connecting", ready: false, stt: "ok", view: "idle", turn: 0, activeTurn: 0, holding: false,
    pending: null, entries: [], original: [], catalog: [], inventory: new Map(), records: [],
    audioCtx: null, capture: null, captureInit: false, awaitReadback: false, lastSaved: null,
    lastPartial: "", levels: [], timers: {},
  };
  const player = createPlayer(() => S.audioCtx);

  const els = {
    dot: $("dot"), status: $("status"), timings: $("timings"), mic: $("mic"), micHint: $("micHint"),
    liveStable: $("liveStable"), liveTail: $("liveTail"), wave: $("wave"), waitText: $("waitText"), waitSlow: $("waitSlow"),
    question: $("question"), options: $("options"), somethingElse: $("somethingElse"), roundHint: $("roundHint"),
    cards: $("cards"), confirmText: $("confirmText"), confirmBtn: $("confirmBtn"), cancelBtn: $("cancelBtn"),
    readback: $("readback"), photoRow: $("photoRow"), photoBtn: $("photoBtn"), photoInput: $("photoInput"), photoThumb: $("photoThumb"), photoStatus: $("photoStatus"),
    todayList: $("todayList"), idleToday: $("idleToday"), picker: $("picker"), pickerList: $("pickerList"), pickerClose: $("pickerClose"),
    toast: $("toast"), typeForm: $("typeForm"), typeInput: $("typeInput"), typeToggle: $("typeToggle"),
  };
  const views = Array.from(doc.querySelectorAll("section[data-view]"));

  // ── View switching ───────────────────────────────────────────────────────
  function showView(name) {
    S.view = name;
    for (const v of views) v.hidden = v.getAttribute("data-view") !== name;
    els.picker.hidden = true;
    if (name !== "waiting") clearWait();
  }
  function toast(text, ms = 2500) {
    els.toast.textContent = text; els.toast.hidden = false;
    clearTimeout(S.timers.toast);
    S.timers.toast = setTimeout(() => { els.toast.hidden = true; }, ms);
  }
  function setStatus(text, on) {
    els.status.textContent = text;
    els.dot.classList.toggle("on", !!on);
    els.mic.classList.toggle("off", !on);
  }
  function startWait() {
    clearWait();
    els.waitText.textContent = "…"; els.waitSlow.hidden = true;
    S.timers.slow = setTimeout(() => { els.waitSlow.hidden = false; }, 4000);
  }
  function clearWait() { clearTimeout(S.timers.slow); els.waitSlow.hidden = true; }

  // ── Live transcript: stable prefix black, new tail grey; one text node each ─
  function resetLive() { S.lastPartial = ""; els.liveStable.textContent = ""; els.liveTail.textContent = ""; }
  function setLive(text, final = false) {
    if (final) { els.liveStable.textContent = text; els.liveTail.textContent = ""; S.lastPartial = text; return; }
    const prev = S.lastPartial;
    let i = 0;
    while (i < prev.length && i < text.length && prev[i] === text[i]) i++;
    // keep the stable part on a word boundary: if the split lands mid-word, back up to the last space
    if (i < text.length && text[i] !== " ") { while (i > 0 && text[i - 1] !== " ") i--; }
    els.liveStable.textContent = text.slice(0, i);
    els.liveTail.textContent = text.slice(i);
    S.lastPartial = text;
  }
  function drawLevel(level) {
    S.levels.push(Math.min(1, level * 6)); if (S.levels.length > 40) S.levels.shift();
    const c = els.wave, ctx = c && c.getContext ? c.getContext("2d") : null;
    if (!ctx) return;
    const w = c.width, h = c.height, bw = w / 40;
    ctx.clearRect(0, 0, w, h); ctx.fillStyle = "#c2410c";
    S.levels.forEach((l, i) => { const bh = Math.max(3, l * h); ctx.fillRect(i * bw + 1, (h - bh) / 2, bw - 3, bh); });
  }

  // ── Audio: create/resume inside the first touch handler (iOS) ────────────
  async function ensureAudio() {
    if (!S.audioCtx) { const AC = win.AudioContext || win.webkitAudioContext; if (AC) S.audioCtx = new AC(); }
    if (S.audioCtx && S.audioCtx.state === "suspended" && S.audioCtx.resume) S.audioCtx.resume().catch(() => {});
    if (!S.capture && !S.captureInit) {
      S.captureInit = true;
      try {
        S.capture = opts.capture ? await opts.capture(S.audioCtx) : await createCapture(S.audioCtx, { mediaDevices: win.navigator.mediaDevices });
        els.micHint.textContent = "Hold to talk";
      } catch (err) {
        console.warn("mic unavailable", err);
        S.captureInit = false;
        els.micHint.textContent = "Mic blocked · type instead";
        showType(true);
      }
    }
    requestWakeLock();
  }
  async function requestWakeLock() {
    try {
      if (win.navigator.wakeLock && !S.wakeLock) {
        S.wakeLock = await win.navigator.wakeLock.request("screen");
        S.wakeLock.addEventListener?.("release", () => { S.wakeLock = null; });
      }
    } catch {}
  }
  doc.addEventListener("visibilitychange", () => { if (doc.visibilityState === "visible" && S.audioCtx) requestWakeLock(); });

  // ── Push-to-talk ─────────────────────────────────────────────────────────
  function onDown(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.pointerId != null && els.mic.setPointerCapture) { try { els.mic.setPointerCapture(e.pointerId); } catch {} }
    if (S.holding) return;
    if (!conn.isOpen || !S.ready) { toast("Offline · reconnecting…", 1500); ensureAudio(); return; }
    S.holding = true;
    S.turn++; const turn = S.turn; S.activeTurn = turn;
    player.stop();
    conn.send({ type: "ptt.start", turn });
    resetLive(); S.levels = [];
    showView("listening");
    els.mic.classList.add("held"); els.mic.classList.remove("pulse");
    els.dot.classList.add("rec");
    ensureAudio().then(() => {
      if (S.holding && S.activeTurn === turn && S.capture) {
        S.capture.start((pcm, level) => { if (S.holding && S.activeTurn === turn) { conn.sendBinary(pcm); drawLevel(level || 0); } });
      }
    });
  }
  async function onUp(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!S.holding) return;
    S.holding = false;
    els.mic.classList.remove("held"); els.dot.classList.remove("rec");
    const turn = S.activeTurn;
    if (S.capture) { try { await S.capture.stop(); } catch {} }
    conn.send({ type: "ptt.stop", turn });
    showView("waiting"); startWait();
  }
  els.mic.addEventListener("pointerdown", onDown);
  els.mic.addEventListener("pointerup", onUp);
  els.mic.addEventListener("pointercancel", onUp);
  els.mic.addEventListener("pointerleave", onUp);
  els.mic.addEventListener("contextmenu", (e) => e.preventDefault());
  // Laptop convenience: hold Space.
  doc.addEventListener("keydown", (e) => { if (e.code === "Space" && !e.repeat && doc.activeElement !== els.typeInput) onDown(e); });
  doc.addEventListener("keyup", (e) => { if (e.code === "Space" && doc.activeElement !== els.typeInput) onUp(e); });

  // ── Typed fallback ───────────────────────────────────────────────────────
  function showType(on) { els.typeForm.hidden = !on; if (on) els.typeInput.focus?.(); }
  els.typeToggle.addEventListener("click", () => showType(els.typeForm.hidden));
  els.typeForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = els.typeInput.value.trim();
    if (!text || !conn.isOpen) return;
    S.turn++; S.activeTurn = S.turn;
    player.stop();
    conn.send({ type: "text", turn: S.turn, text });
    els.typeInput.value = "";
    showView("waiting"); startWait();
  });

  // ── Server messages ──────────────────────────────────────────────────────
  function onMsg(m) {
    switch (m.type) {
      case "ready":
        S.ready = true; S.stt = m.stt;
        setStatus(m.stt === "down" ? "mic unavailable" : "live", true);
        if (m.stt === "down") { showType(true); els.micHint.textContent = "Mic unavailable · type instead"; }
        break;
      case "stt.partial": if (m.turn === S.activeTurn && S.view === "listening") setLive(m.text); break;
      case "stt.final": if (m.turn === S.activeTurn) { setLive(m.text, true); if (S.view === "waiting" && m.text) els.waitText.textContent = m.text; } break;
      case "draft": onDraft(m); break;
      case "draft.cleared":
        if (m.reason === "expired" && S.pending && S.pending.draft_id === m.draft_id) { S.pending = null; toast("Entry expired"); showView("idle"); }
        break;
      case "tts":
        if (S.awaitReadback) { S.awaitReadback = false; els.readback.textContent = m.text; }
        player.play(m.audio_b64);
        break;
      case "record.saved": onSaved(m.record); break;
      case "record.new": pushRecord(m.record); break;
      case "record.updated": pushRecord(m.record); break;
      case "inventory.update": setInventory(m.items); break;
      case "error": onError(m); break;
      default: break;
    }
  }
  function onError(m) {
    clearWait();
    S.holding = false; els.mic.classList.remove("held"); els.dot.classList.remove("rec");
    toast(m.message || m.code, 3000);
    if (S.pending && S.pending.intent === "needs_clarification") showView("clarify");
    else if (S.pending) showView("review");
    else showView("idle");
  }
  function onDraft(m) {
    clearWait();
    const d = m.draft, t = m.timings;
    if (t) els.timings.textContent = `${t.stt_ms != null ? "stt " + t.stt_ms + " · " : ""}llm ${t.llm_ms} · total ${t.total_ms} ms`;
    if (d.replaced_pending) toast("Previous entry discarded");
    switch (d.intent) {
      case "log": case "correction":
        S.pending = d; S.original = d.entries.map((e) => ({ ...e })); S.entries = d.entries.map((e) => ({ ...e }));
        renderReview(); showView("review"); break;
      case "needs_clarification":
        S.pending = d; renderClarify(d); showView("clarify"); break;
      default:
        S.pending = null; toast(d.speak_text || "Didn't catch that", 2500); showView("idle");
    }
  }

  // ── Review card ──────────────────────────────────────────────────────────
  function priceOf(id) { return S.catalog.find((i) => i.id === id)?.price ?? null; }
  function baseOf(id) { return S.catalog.find((i) => i.id === id)?.base ?? null; }
  function recompute(e) {
    const base = baseOf(e.item_id) ?? e.base_unit;
    e.base_unit = base;
    e.quantity_base = toBase(e.quantity, e.unit, base);
    const p = priceOf(e.item_id);
    e.value_inr = p && e.quantity_base != null ? Math.round(e.quantity_base * p) : (p === 0 ? null : e.value_inr);
    const inv = S.inventory.get(e.item_id);
    if (inv && e.quantity_base != null) {
      if (e.action === "receiving" || e.action === "prep") e.stock_after = round3(inv.current + e.quantity_base);
      else if (e.action === "usage" || e.action === "wastage") e.stock_after = round3(inv.current - e.quantity_base);
      else if (e.action === "stock_count") e.stock_after = e.quantity_base;
    }
    // Menu item: no stock of its own; the recipe's ingredients move instead.
    const recipe = (S.recipes || {})[e.item_id];
    if (recipe && e.quantity_base != null && (e.action === "usage" || e.action === "wastage" || e.action === "prep")) {
      const lang = S.pending?.language || "en-IN";
      e.stock_after = null;
      e.ingredients = recipe.map((l) => {
        const ing = S.inventory.get(l.item_id);
        const qty = round3(l.quantity_base * e.quantity_base);
        const price = priceOf(l.item_id) ?? 0;
        return { item_id: l.item_id, label: catalogName(S.catalog, l.item_id, lang), quantity_base: qty, base_unit: ing?.base_unit || baseOf(l.item_id), value_inr: Math.round(qty * price), stock_after: round3((ing?.current ?? 0) - qty) };
      });
    } else if (!recipe) delete e.ingredients;
  }
  const INGREDIENTS_WORD = { hi: "इसमें गया", mr: "यात गेलं", kn: "ಇದರಲ್ಲಿ ಹೋಯಿತು", ta: "இதில் போனது", te: "ఇందులో పోయింది", en: "Ingredients used" };
  function fmtQty(q, base, lang) {
    if (base === "kg" && q < 1) return `${fmtNum(Math.round(q * 1000))} ${unitWord("g", lang)}`;
    if (base === "l" && q < 1) return `${fmtNum(Math.round(q * 1000))} ${unitWord("ml", lang)}`;
    return `${fmtNum(q)} ${unitWord(base, lang)}`;
  }
  function ingredientsBlock(e, lang) {
    if (!e.ingredients || !e.ingredients.length) return null;
    return el(doc, "div", { class: "ingredients" }, [
      el(doc, "div", { class: "k", text: INGREDIENTS_WORD[lang.slice(0, 2)] || INGREDIENTS_WORD.en }),
      el(doc, "ul", {}, e.ingredients.map((g) => el(doc, "li", { class: g.stock_after < 0 ? "short" : "" }, [
        el(doc, "span", { text: g.label }),
        el(doc, "span", { class: "q", text: fmtQty(g.quantity_base, g.base_unit, lang) }),
        el(doc, "span", { class: "after", text: `${word("left", lang)} ${fmtNum(g.stock_after)} ${unitWord(g.base_unit, lang)}` }),
      ]))),
    ]);
  }
  const round3 = (n) => Math.round(n * 1000) / 1000;
  function stockLine(e, lang) {
    if (e.stock_after == null) return "";
    const inv = S.inventory.get(e.item_id);
    const u = unitWord(e.base_unit, lang);
    const before = inv && inv.current !== e.stock_after ? `${fmtNum(inv.current)} → ` : "";
    return `${word("left", lang)}: ${before}${fmtNum(e.stock_after)} ${u}`;
  }
  function renderReview() {
    const d = S.pending, lang = d.language;
    els.cards.replaceChildren();
    S.entries.forEach((e, i) => {
      const isTemp = e.action === "temperature_check";
      const num = isTemp ? e.temperature_c : e.quantity;
      const unit = isTemp ? "°C" : unitWord(e.unit === "none" ? e.base_unit : e.unit, lang);
      const card = el(doc, "div", { class: "card", "data-index": String(i) }, [
        el(doc, "div", { class: "card-top" }, [
          el(doc, "span", { class: `chip action ${e.action}`, text: ACTION_LABEL[e.action] || e.action }),
          ...e.warnings.map((w) => el(doc, "span", { class: "chip warn", text: WARNING_LABEL[w] || w })),
        ]),
        el(doc, "div", { class: "qty-row" }, [
          el(doc, "button", { class: "btn round minus", type: "button", "aria-label": "minus one", text: "−1", onclick: () => bump(i, -1) }),
          el(doc, "div", { class: "qty" }, [el(doc, "span", { class: "num", text: fmtNum(num) }), el(doc, "span", { class: "unit", text: unit })]),
          el(doc, "button", { class: "btn round plus", type: "button", "aria-label": "plus one", text: "+1", onclick: () => bump(i, +1) }),
        ]),
        el(doc, "div", { class: "item-row" }, [
          el(doc, "button", { class: "link item-btn", type: "button", text: e.item_label, onclick: () => openPicker(i) }),
          e.reason ? el(doc, "span", { class: "reason", text: e.reason }) : null,
        ]),
        el(doc, "div", { class: "meta" }, [
          el(doc, "span", { class: "value", text: e.value_inr != null ? fmtInr(e.value_inr) : "" }),
          el(doc, "span", { class: "stock", text: stockLine(e, lang) }),
        ]),
        ingredientsBlock(e, lang),
      ]);
      els.cards.appendChild(card);
    });
    els.confirmText.textContent = d.confirm_text;
  }
  function bump(i, delta) {
    const e = S.entries[i];
    if (e.action === "temperature_check") { e.temperature_c = (e.temperature_c ?? 0) + delta; renderReview(); return; }
    e.quantity = Math.max(0, round3((e.quantity ?? 0) + delta));
    if (e.unit === "none") e.unit = baseOf(e.item_id) || "none";
    recompute(e); renderReview();
  }
  function openPicker(i) {
    const lang = S.pending?.language || "en-IN";
    els.pickerList.replaceChildren();
    for (const item of S.catalog) {
      const inv = S.inventory.get(item.id);
      els.pickerList.appendChild(el(doc, "button", { class: "opt", type: "button", onclick: () => pickItem(i, item.id) }, [
        el(doc, "span", { text: item.names[lang.slice(0, 2)] || item.names.en }),
        inv ? el(doc, "span", { class: "stock", text: `${fmtNum(inv.current)} ${unitWord(inv.base_unit, lang)}` }) : null,
      ]));
    }
    els.picker.hidden = false;
  }
  function pickItem(i, id) {
    const e = S.entries[i];
    e.item_id = id; e.item_label = catalogName(S.catalog, id, S.pending.language);
    e.warnings = e.warnings.filter((w) => w !== "unknown_item");
    if (e.unit === "none" || toBase(1, e.unit, baseOf(id)) == null) e.unit = baseOf(id) || e.unit;
    recompute(e); els.picker.hidden = true; renderReview();
  }
  els.pickerClose.addEventListener("click", () => { els.picker.hidden = true; });
  function editsDiff() {
    const edits = [];
    S.entries.forEach((e, i) => {
      const o = S.original[i]; if (!o) return;
      const ed = { index: i };
      if (e.quantity !== o.quantity) ed.quantity = e.quantity;
      if (e.unit !== o.unit) ed.unit = e.unit;
      if (e.item_id !== o.item_id) ed.item_id = e.item_id;
      if (Object.keys(ed).length > 1) edits.push(ed);
    });
    return edits;
  }
  els.confirmBtn.addEventListener("click", () => {
    if (!S.pending) return;
    const edits = editsDiff();
    const msg = { type: "draft.confirm", draft_id: S.pending.draft_id };
    if (edits.length) msg.edits = edits;
    conn.send(msg);
    player.stop();
    showView("waiting"); startWait();
  });
  els.cancelBtn.addEventListener("click", () => {
    if (!S.pending) return;
    conn.send({ type: "draft.cancel", draft_id: S.pending.draft_id });
    S.pending = null; player.stop();
    showView("idle");
  });

  // ── Clarify ──────────────────────────────────────────────────────────────
  function renderClarify(d) {
    const c = d.clarification, lang = d.language;
    els.question.textContent = c.question;
    els.options.replaceChildren();
    for (const o of c.options) {
      const inv = S.inventory.get(o.value);
      els.options.appendChild(el(doc, "button", { class: "opt", type: "button", "data-value": o.value, onclick: () => answer(d, o.value) }, [
        el(doc, "span", { text: o.label }),
        inv ? el(doc, "span", { class: "stock", text: `${fmtNum(inv.current)} ${unitWord(inv.base_unit, lang)}` }) : null,
      ]));
    }
    els.somethingElse.textContent = word("somethingElse", lang);
    els.roundHint.textContent = `round ${c.round} of 2 · or hold the mic and say it`;
  }
  function answer(d, value) {
    conn.send({ type: "draft.answer", draft_id: d.draft_id, value });
    player.stop();
    showView("waiting"); startWait();
  }
  els.somethingElse.addEventListener("click", () => { els.mic.classList.add("pulse"); els.micHint.textContent = "Hold the mic and say it"; });

  // ── Saved ────────────────────────────────────────────────────────────────
  function summary(r) {
    const e = r.entries[0]; if (!e) return r.transcript;
    const num = e.action === "temperature_check" ? `${fmtNum(e.temperature_c)} °C` : `${fmtNum(e.quantity)} ${unitWord(e.unit === "none" ? e.base_unit : e.unit, r.language)}`;
    return `${num} ${e.item_label}`;
  }
  function onSaved(r) {
    clearWait();
    S.pending = null; S.lastSaved = r; S.awaitReadback = true;
    els.readback.textContent = summary(r);
    const wast = r.entries.some((e) => e.action === "wastage");
    els.photoRow.hidden = !wast;
    els.photoThumb.hidden = true; els.photoStatus.textContent = ""; els.photoBtn.hidden = false;
    pushRecord(r);
    showView("saved");
  }
  function pushRecord(r) {
    const i = S.records.findIndex((x) => x.record_id === r.record_id);
    if (i >= 0) S.records[i] = r; else S.records.unshift(r);
    S.records = S.records.slice(0, 10);
    renderToday();
  }
  function renderToday() {
    els.todayList.replaceChildren();
    for (const r of S.records) {
      const e = r.entries[0];
      const li = el(doc, "li", {}, [
        el(doc, "span", { class: "t", text: fmtTimeIst(r.created_at) }),
        el(doc, "span", { class: `chip action ${e?.action || ""}`, text: ACTION_LABEL[e?.action] || "" }),
        el(doc, "span", { text: summary(r) }),
        r.photo_url ? el(doc, "img", { src: httpBase + r.photo_url, alt: "" }) : null,
        el(doc, "span", { class: "v", text: e?.value_inr != null ? fmtInr(e.value_inr) : "" }),
      ]);
      els.todayList.appendChild(li);
    }
    els.idleToday.textContent = S.records.length ? `${S.records.length} entr${S.records.length === 1 ? "y" : "ies"} today · latest: ${summary(S.records[0])}` : "";
  }
  els.photoBtn.addEventListener("click", () => els.photoInput.click());
  els.photoInput.addEventListener("change", async () => {
    const file = els.photoInput.files && els.photoInput.files[0];
    if (!file || !S.lastSaved) return;
    els.photoStatus.textContent = "Uploading…";
    try {
      const blob = await resizeJpeg(file, 1024, 0.8);
      const fd = new FormData(); fd.append("photo", blob, "photo.jpg");
      const res = await fetchImpl(`${httpBase}/api/photo/${S.lastSaved.record_id}`, { method: "POST", body: fd });
      if (!res.ok) throw new Error("upload failed " + res.status);
      const j = await res.json();
      els.photoThumb.src = httpBase + j.photo_url + "?t=" + Date.now(); els.photoThumb.hidden = false; els.photoBtn.hidden = true;
      els.photoStatus.textContent = "Photo attached";
    } catch (err) { els.photoStatus.textContent = "Photo failed (entry is saved)"; console.warn(err); }
  });
  async function resizeJpeg(file, max, q) {
    const bmp = await (win.createImageBitmap ? win.createImageBitmap(file) : loadImage(file));
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = doc.createElement("canvas"); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/jpeg", q));
  }
  function loadImage(file) {
    return new Promise((res, rej) => { const img = new win.Image(); img.onload = () => res(img); img.onerror = rej; img.src = URL.createObjectURL(file); });
  }

  // ── Data ─────────────────────────────────────────────────────────────────
  function setInventory(items) { S.inventory = new Map(items.map((i) => [i.item_id, i])); }
  async function loadOnce() {
    try { const c = await fetchImpl(`${httpBase}/api/catalog`).then((r) => r.json()); S.catalog = c.items || []; S.recipes = c.recipes || {}; } catch {}
    try { const i = await fetchImpl(`${httpBase}/api/inventory`).then((r) => r.json()); setInventory(i.items || []); } catch {}
    try { const r = await fetchImpl(`${httpBase}/api/records?limit=10`).then((r) => r.json()); S.records = (r.records || []).slice(0, 10); renderToday(); } catch {}
  }

  // ── Connect ──────────────────────────────────────────────────────────────
  const conn = connect({
    url: wsUrl, role: "staff", clientId: clientId(storage), WebSocketImpl: opts.WebSocketImpl, pingMs: opts.pingMs ?? 25000,
    onMsg,
    onStatus: (s) => {
      if (s === "open") { setStatus("connecting…", false); }
      else { S.ready = false; setStatus("offline · reconnecting", false); if (S.holding) onUp(); }
    },
  });
  loadOnce();

  return { state: S, conn, player, showView, els, setLive, get view() { return S.view; } };
}

function safeStorage(win) {
  try { win.localStorage.getItem("x"); return win.localStorage; }
  catch { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; }
}
