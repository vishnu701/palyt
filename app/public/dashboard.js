// Owner dashboard: tiles, live log grouped by day, inventory (Ingredients | Recipes).
// Connects as role "dashboard". Design: white ground, thin borders, status colour only on pills.
import { connect, wsUrlFor, clientId, el, fmtNum, fmtInr, ACTION_LABEL, langTag, unitWord } from "./common.js";

const IST = "Asia/Kolkata";
const fmtTime = (iso) => new Date(iso).toLocaleTimeString("en-IN", { timeZone: IST, hour: "numeric", minute: "2-digit", hour12: true }).toUpperCase();
const dayKey = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: IST });
const dayLabel = (key) => {
  const today = dayKey(new Date().toISOString());
  const yest = dayKey(new Date(Date.now() - 86400000).toISOString());
  if (key === today) return "Today";
  if (key === yest) return "Yesterday";
  return new Date(key + "T12:00:00Z").toLocaleDateString("en-IN", { timeZone: IST, day: "numeric", month: "short" });
};
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function boot(opts = {}) {
  const doc = opts.document || document;
  const win = opts.window || window;
  const fetchImpl = opts.fetchImpl || ((u, o) => fetch(u, o));
  const httpBase = opts.httpBase ?? "";
  const wsUrl = opts.wsUrl || wsUrlFor(win.location);
  const $ = (id) => doc.getElementById(id);
  const els = {
    conn: $("conn"), tEntries: $("tEntries"), tEntriesSub: $("tEntriesSub"), tWastage: $("tWastage"), tReceived: $("tReceived"), tSpeed: $("tSpeed"), tSpeedSub: $("tSpeedSub"),
    strip: $("strip"), stripK: $("stripK"), stripDot: $("stripDot"), stripText: $("stripText"),
    log: $("log"), inv: $("inv"), menu: $("menu"), dish: $("dish"), tabInv: $("tabInv"), tabMenu: $("tabMenu"),
  };
  const S = { records: [], inventory: [], catalog: [], menu: [], tab: "inventory", dishId: null };

  // ── Tiles ────────────────────────────────────────────────────────────────
  function renderStats(st) {
    if (!st || !st.today) return;
    const t = st.today;
    els.tEntries.textContent = String(t.entries);
    els.tEntriesSub.textContent = t.clarified ? `${t.clarified} asked` : "";
    els.tWastage.textContent = fmtInr(t.wastage_inr);
    els.tReceived.textContent = fmtInr(t.receiving_inr);
    renderSpeed();
  }
  // Big number = the most recent turn's release → card time; small line = today's average.
  function renderSpeed() {
    const today = dayKey(new Date().toISOString());
    const timed = S.records.filter((r) => r.timings && dayKey(r.created_at) === today).map((r) => r.timings.total_ms);
    const latest = S.records.find((r) => r.timings)?.timings.total_ms;
    els.tSpeed.textContent = latest != null ? `${Math.round(latest)} ms` : "–";
    const avg = timed.length ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : null;
    els.tSpeedSub.textContent = avg != null ? `Today's average ${avg} ms · release → card` : "Release → card";
  }
  async function refetchStats() {
    try { renderStats(await fetchImpl(`${httpBase}/api/stats`).then((r) => r.json())); } catch {}
  }

  // ── Activity (what is happening on the phone right now) ──────────────────
  function renderActivity(a) {
    els.strip.setAttribute("data-state", a.state);
    els.stripDot.hidden = a.state !== "listening";
    els.stripK.textContent = { listening: "Listening", thinking: "Thinking", asking: "Asked", reviewing: "Reviewing", idle: "" }[a.state] || "";
    els.stripText.textContent = a.state === "thinking" ? (a.text ? a.text + " …" : "…") : a.text;
  }

  // ── Log ──────────────────────────────────────────────────────────────────
  const nameOf = (e) => S.catalog.find((i) => i.id === e.item_id)?.names?.en || e.item_label;
  function qtyText(e) {
    if (e.action === "temperature_check") return `${fmtNum(e.temperature_c)} °C`;
    if (e.quantity_base != null) return `${fmtNum(e.quantity_base)} ${unitWord(e.base_unit, "en")}`;
    if (e.quantity != null) return `${fmtNum(e.quantity)} ${e.unit === "none" ? "" : e.unit}`.trim();
    return "";
  }
  function fmtQty(q, base) {
    if (base === "kg" && q < 1) return `${fmtNum(Math.round(q * 1000))} g`;
    if (base === "l" && q < 1) return `${fmtNum(Math.round(q * 1000))} ml`;
    return `${fmtNum(q)} ${unitWord(base, "en")}`;
  }
  function entryLines(r) {
    const lines = [];
    for (const e of r.entries) {
      const right = [qtyText(e), e.reason ? cap(e.reason) : (e.action === "wastage" ? "" : ACTION_LABEL[e.action])].filter(Boolean).join(" · ");
      lines.push(el(doc, "li", { class: "line" }, [el(doc, "span", { class: "n", text: nameOf(e) }), el(doc, "span", { class: "q", text: right })]));
      for (const g of e.ingredients || []) lines.push(el(doc, "li", { class: "line sub" }, [el(doc, "span", { class: "n", text: g.label }), el(doc, "span", { class: "q", text: fmtQty(g.quantity_base, g.base_unit) })]));
    }
    return lines;
  }
  function waveIcon() {
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "16"); svg.setAttribute("height", "16");
    svg.innerHTML = '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
    return svg;
  }
  function rowFor(r, flash) {
    const e = r.entries[0];
    const value = r.entries.reduce((s, x) => s + (x.value_inr || 0), 0);
    const sum = el(doc, "span", { class: "sum", text: r.entries.map((x) => `${qtyText(x)} ${nameOf(x)}`).join(" · ") });
    sum.hidden = true;
    return el(doc, "li", { "data-id": r.record_id, "data-day": dayKey(r.created_at), class: flash ? "flash" : "" }, [
      el(doc, "span", { class: "t", text: fmtTime(r.created_at) }),
      el(doc, "div", { class: "body" }, [
        el(doc, "div", { class: "tx" }, [
          el(doc, "span", { class: "wave", "aria-hidden": "true" }, [waveIcon()]),
          el(doc, "span", { class: "quote", text: `“${r.transcript}”` }),
          el(doc, "span", { class: "tag", text: langTag(r.language) }),
          r.clarified ? el(doc, "span", { class: "asked", text: "asked" }) : null,
          r.edited ? el(doc, "span", { class: "asked", text: "edited" }) : null,
        ]),
        el(doc, "ul", { class: "lines" }, entryLines(r)),
        sum,
      ]),
      el(doc, "span", {}, [el(doc, "span", { class: `chip action ${e?.action || ""}`, text: ACTION_LABEL[e?.action] || (e?.action ?? "") })]),
      el(doc, "span", { class: "val" }, [
        doc.createTextNode(value ? fmtInr(value) : ""),
        r.photo_url ? el(doc, "img", { src: httpBase + r.photo_url, alt: "photo" }) : null,
      ]),
    ]);
  }
  function dayHeader(key) { return el(doc, "li", { class: "day", "data-day-head": key, text: dayLabel(key) }); }
  function renderLog() {
    els.log.replaceChildren();
    if (!S.records.length) { els.log.appendChild(el(doc, "li", { class: "empty", text: "Nothing logged yet. Hold the button on the phone." })); return; }
    let cur = null;
    for (const r of S.records) {
      const k = dayKey(r.created_at);
      if (k !== cur) { els.log.appendChild(dayHeader(k)); cur = k; }
      els.log.appendChild(rowFor(r, false));
    }
  }
  function addRecord(r) {
    S.records.unshift(r); S.records = S.records.slice(0, 50);
    const empty = els.log.querySelector(".empty"); if (empty) empty.remove();
    const k = dayKey(r.created_at);
    let head = els.log.querySelector(`li[data-day-head="${k}"]`);
    if (!head) { head = dayHeader(k); els.log.insertBefore(head, els.log.firstChild); }
    const li = rowFor(r, true);
    head.after(li);
    setTimeout(() => li.classList.remove("flash"), 2000);
  }
  function updateRecord(r) {
    const i = S.records.findIndex((x) => x.record_id === r.record_id);
    if (i >= 0) S.records[i] = r; else S.records.unshift(r);
    const old = els.log.querySelector(`li[data-id="${r.record_id}"]`);
    if (old) old.replaceWith(rowFor(r, false)); else addRecord(r);
  }

  // ── Inventory ────────────────────────────────────────────────────────────
  function renderInventory(items) {
    S.inventory = items;
    els.inv.replaceChildren();
    for (const it of items) {
      const u = unitWord(it.base_unit, "en");
      els.inv.appendChild(el(doc, "li", { "data-id": it.item_id, class: it.low ? "low" : "" }, [
        el(doc, "span", { class: "n", text: it.label }),
        el(doc, "span", { class: "q" }, [el(doc, "b", { text: `${fmtNum(it.current)} ${u}` }), doc.createTextNode(` / ${fmtNum(it.opening)} ${u}`)]),
        el(doc, "span", { class: "v", text: fmtInr(it.value_inr) }),
      ]));
    }
    if (S.dishId) renderDish();
  }

  // ── Recipes ──────────────────────────────────────────────────────────────
  function showTab(tab) {
    S.tab = tab;
    const inv = tab === "inventory";
    els.tabInv.classList.toggle("on", inv); els.tabInv.setAttribute("aria-selected", String(inv));
    els.tabMenu.classList.toggle("on", !inv); els.tabMenu.setAttribute("aria-selected", String(!inv));
    els.inv.hidden = !inv;
    els.menu.hidden = inv || !!S.dishId;
    els.dish.hidden = inv || !S.dishId;
  }
  function openDish(id) { S.dishId = id; renderMenu(S.menu); showTab("menu"); }
  function closeDish() { S.dishId = null; renderMenu(S.menu); showTab("menu"); }
  els.tabInv.addEventListener("click", () => showTab("inventory"));
  els.tabMenu.addEventListener("click", () => showTab("menu"));

  function renderMenu(items) {
    S.menu = items;
    els.menu.replaceChildren();
    for (const m of items) {
      els.menu.appendChild(el(doc, "li", { "data-id": m.item_id }, [
        el(doc, "button", { class: "dish-btn", type: "button", onclick: () => openDish(m.item_id) }, [
          el(doc, "span", { class: "n", text: m.label }),
          el(doc, "span", { class: "q", text: `${m.ingredients.length} ingredients` }),
          el(doc, "span", { class: "v", text: `${fmtInr(m.cost_inr)} / portion` }),
        ]),
      ]));
    }
    renderDish();
  }
  function renderDish() {
    const m = S.menu.find((x) => x.item_id === S.dishId);
    els.dish.replaceChildren();
    if (!m) { if (S.dishId) { S.dishId = null; if (S.tab === "menu") showTab("menu"); } return; }
    els.dish.append(
      el(doc, "div", { class: "dish-head" }, [
        el(doc, "button", { class: "back", type: "button", onclick: closeDish, "aria-label": "Back to recipes", text: "← Recipes" }),
        el(doc, "span", { class: "cost", text: `${fmtInr(m.cost_inr)} / portion` }),
      ]),
      el(doc, "h3", { text: m.label }),
      el(doc, "ul", { class: "dish-ing" }, [
        el(doc, "li", { class: "head" }, [el(doc, "span", { text: "Ingredient" }), el(doc, "span", { text: "Per portion" }), el(doc, "span", { text: "In stock" })]),
        ...m.ingredients.map((g) => {
          const inv = S.inventory.find((x) => x.item_id === g.item_id);
          return el(doc, "li", { class: inv?.low ? "low" : "" }, [
            el(doc, "span", { class: "n", text: g.label }),
            el(doc, "span", { class: "q", text: fmtQty(g.quantity_base, g.base_unit) }),
            el(doc, "span", { class: "q" }, [el(doc, "b", { text: `${fmtNum(g.stock)} ${unitWord(g.base_unit, "en")}` })]),
          ]);
        }),
      ]),
    );
  }
  async function refetchMenu() {
    try { renderMenu((await fetchImpl(`${httpBase}/api/menu`).then((r) => r.json())).items || []); } catch {}
  }

  // ── Messages ─────────────────────────────────────────────────────────────
  function onMsg(m) {
    switch (m.type) {
      case "ready": els.conn.textContent = ""; els.conn.classList.add("on"); break;
      case "activity": renderActivity(m.activity); break;
      case "record.new": addRecord(m.record); renderSpeed(); refetchStats(); break;
      case "record.updated": updateRecord(m.record); break;
      case "inventory.update": renderInventory(m.items); refetchMenu(); break;
      default: break;
    }
  }
  const conn = connect({
    url: wsUrl, role: "dashboard", clientId: clientId(safeStorage(win)), WebSocketImpl: opts.WebSocketImpl, pingMs: opts.pingMs ?? 25000, onMsg,
    onStatus: (s) => { if (s !== "open") { els.conn.classList.remove("on"); els.conn.textContent = "Reconnecting…"; } },
  });

  async function load() {
    try { const c = await fetchImpl(`${httpBase}/api/catalog`).then((r) => r.json()); S.catalog = c.items || []; } catch {}
    await refetchStats();
    try { const r = await fetchImpl(`${httpBase}/api/records?limit=50`).then((r) => r.json()); S.records = r.records || []; renderLog(); renderSpeed(); } catch {}
    try { const i = await fetchImpl(`${httpBase}/api/inventory`).then((r) => r.json()); renderInventory(i.items || []); } catch {}
    await refetchMenu();
  }
  const loaded = load();
  return { state: S, conn, els, loaded };
}
function safeStorage(win) {
  try { win.localStorage.getItem("x"); return win.localStorage; }
  catch { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; }
}
