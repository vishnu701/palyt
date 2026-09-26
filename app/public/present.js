// Projector shell: five pointer steps on a dark rail; steps 3–4 show the live dashboard iframe
// (mounted from load so it is warm), step 5 shows a QR to the phone app. ← → Space, ?step=N.
import { el } from "./common.js";
import { qrMatrix } from "./qr.js";

export const DEMO_URL = "https://demo.palyt.in/";

export const STEPS = [
  { kicker: "The problem", title: "Kitchens lose stock nobody records.",
    lines: ["Wastage, deliveries, usage, temperature checks: it all happens and none of it is written down.",
            "The people who know are untrained, their hands are wet, and they speak Kannada, Hindi or Marathi.",
            "The POS never sees the back of house."],
    rail: ["Stock nobody records", "Staff untrained, hands wet, speak Kannada / Hindi / Marathi", "The POS never sees the back of house"],
    now: "Ask the room who logs wastage in their kitchen. Nobody does." },
  { kicker: "Why voice, why now", title: "Hold a button, say it, done.",
    lines: ["Answered in their own language, out loud, so nobody has to read a screen.",
            "It asks when it is unsure. It never guesses.",
            "Push-to-talk, context first, streamed while speaking: sub-second on stage."],
    rail: ["Hold a button, say it, done", "Answered in their own language, out loud", "Asks when unsure, never guesses"],
    now: "Hand the phone to Ayush. Switch to the live dashboard." },
  { kicker: "Watch it", title: "Live.",
    lines: [], live: true,
    rail: ["Ayush holds the button and speaks Kannada", "Card appears, phone reads it back, one tap", "Log row and inventory move on this screen"],
    now: "Point at the strip: the audience sees the transcript grow while he speaks." },
  { kicker: "What it captured", title: "One log, three languages.",
    lines: [], live: true,
    rail: ["Three languages, one log", "Wastage in ₹, stock dropping live", "“Which rice?” was generated, not scripted"],
    now: "Scroll the log. Show the ‘asked’ marker on the rice entry." },
  { kicker: "Try it · what’s next", title: "Try it on your phone.",
    lines: ["Every confirmed entry teaches it kitchen speech.", "Plugs into any POS instead of replacing it.", "Vishnu × Ayush"],
    qr: true,
    rail: ["Scan, hold, speak. No login.", "Every confirmed entry teaches it kitchen speech", "Plugs into any POS · Vishnu × Ayush"],
    now: "Leave the QR up. Invite the judges to try it now." },
];

export function boot(opts = {}) {
  const doc = opts.document || document;
  const win = opts.window || window;
  const $ = (id) => doc.getElementById(id);
  const els = { stepNo: $("stepNo"), steps: $("steps"), railTitle: $("railTitle"), railPointers: $("railPointers"), railNow: $("railNow"), dash: $("dash"), livebar: $("livebar"), slide: $("slide") };
  let step = clamp(Number(new URL(win.location.href).searchParams.get("step")) || 1);
  function clamp(n) { return Math.min(STEPS.length, Math.max(1, n || 1)); }

  function render() {
    const s = STEPS[step - 1];
    els.stepNo.textContent = `${step} / ${STEPS.length}`;
    Array.from(els.steps.children).forEach((i, idx) => i.classList.toggle("on", idx < step));
    els.railTitle.textContent = s.title;
    els.railPointers.replaceChildren(...s.rail.map((t) => el(doc, "div", {}, [el(doc, "span", { text: "—" }), el(doc, "span", { text: t })])));
    els.railNow.textContent = s.now;
    els.dash.hidden = !s.live; els.livebar.hidden = !s.live; els.slide.hidden = !!s.live;
    els.slide.className = "slide" + (s.qr ? " qr-slide" : "");
    els.slide.replaceChildren();
    if (s.live) return;
    if (s.qr) {
      const canvas = doc.createElement("canvas");
      drawQr(canvas, DEMO_URL);
      els.slide.append(
        el(doc, "div", { class: "qr-box" }, [canvas]),
        el(doc, "div", { class: "qr-text" }, [
          el(doc, "div", { class: "kicker", text: s.kicker }),
          el(doc, "h1", { text: s.title }),
          el(doc, "div", { class: "url", text: DEMO_URL.replace(/\/$/, "") }),
          el(doc, "div", { class: "lines" }, s.lines.map((t, i) => el(doc, "div", {}, [el(doc, "b", { text: String(i + 1) }), el(doc, "span", { text: t })]))),
        ]),
      );
      return;
    }
    els.slide.append(
      el(doc, "div", { class: "kicker", text: s.kicker }),
      el(doc, "div", {}, [
        el(doc, "h1", { text: s.title }),
        el(doc, "div", { class: "lines", style: "margin-top:40px" }, s.lines.map((t, i) => el(doc, "div", {}, [el(doc, "b", { text: String(i + 1) }), el(doc, "span", { text: t })]))),
      ]),
      el(doc, "div", { class: "foot" }, [el(doc, "span", { text: "Palyt · Vishnu × Ayush" }), el(doc, "span", { text: `${step} / ${STEPS.length}` })]),
    );
  }
  function go(n) {
    step = clamp(n);
    try { win.history.replaceState(null, "", `?step=${step}`); } catch {}
    render();
  }
  doc.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown" || e.key === "Enter") { e.preventDefault(); go(step + 1); }
    else if (e.key === "ArrowLeft" || e.key === "PageUp" || e.key === "Backspace") { e.preventDefault(); go(step - 1); }
    else if (/^[1-5]$/.test(e.key)) go(Number(e.key));
  });
  render();
  return { go, get step() { return step; }, els };
}

export function drawQr(canvas, text) {
  const m = qrMatrix(text, "M");
  const quiet = 4, scale = 8, size = (m.length + quiet * 2) * scale;
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext && canvas.getContext("2d");
  if (!ctx) return m;
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#1c1b19";
  for (let y = 0; y < m.length; y++) for (let x = 0; x < m.length; x++) if (m[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
  return m;
}
