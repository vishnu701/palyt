// Presenter shell: five steps, keyboard navigation, ?step=N, dashboard iframe hidden until step 3,
// QR on step 5. Plus the QR encoder decodes back to the demo URL (jsQR) and the JS size budget.
import { describe, test, expect } from "bun:test";
import jsQR from "jsqr";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPage, text, PUBLIC } from "./helpers";
import { qrMatrix } from "../../public/qr.js";

describe("presenter", () => {
  test("steps, keys, deep link, iframe visibility", async () => {
    const { win, doc } = loadPage("present.html", "http://localhost/present?step=2");
    const { boot, STEPS } = await import("../../public/present.js");
    const p = boot({ document: doc, window: win });
    expect(STEPS.length).toBe(5);
    expect(p.step).toBe(2);
    expect(text(doc.getElementById("stepNo"))).toBe("2 / 5");
    expect(text(doc.querySelector("#slide h1"))).toBe("Hold a button, say it, done.");
    expect(doc.getElementById("dash").hidden).toBe(true);
    expect(doc.getElementById("dash").getAttribute("src")).toBe("/dashboard"); // mounted from load
    expect(doc.querySelectorAll("#railPointers div").length).toBe(3);

    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(p.step).toBe(3);
    expect(doc.getElementById("dash").hidden).toBe(false);
    expect(doc.getElementById("slide").hidden).toBe(true);
    expect(text(doc.getElementById("livebar"))).toContain("asia-south1");
    expect(text(doc.getElementById("livebar"))).toContain("~640 ms");

    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(p.step).toBe(4);
    expect(doc.getElementById("dash").hidden).toBe(false);
    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(p.step).toBe(5);
    expect(doc.getElementById("dash").hidden).toBe(true);
    expect(doc.querySelector("#slide canvas")).not.toBeNull();
    expect(text(doc.querySelector("#slide .url"))).toBe("https://demo.palyt.in");
    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(p.step).toBe(5); // clamps
    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(p.step).toBe(4);
    p.go(1);
    expect(text(doc.querySelector("#slide h1"))).toBe("Kitchens lose stock nobody records.");
  });
});

function rasterize(m: boolean[][], scale = 4, quiet = 4) {
  const size = (m.length + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < m.length; y++) for (let x = 0; x < m.length; x++) if (m[y][x]) {
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
    }
  }
  return { data, size };
}

describe("qr", () => {
  test.each([
    ["https://demo.palyt.in/", 25],
    ["HELLO", 21],
    ["https://demo.palyt.in/?utm_source=judges&utm_medium=qr&step=5&long=" + "x".repeat(30), 41],
  ])("encodes %s and jsQR decodes it back (size %i)", (txt, size) => {
    const m = qrMatrix(txt, "M");
    expect(m.length).toBe(size);
    const { data, size: px } = rasterize(m);
    const res = jsQR(data, px, px);
    expect(res?.data).toBe(txt);
  });
});

describe("budget", () => {
  test("all public JS ≤ 60 KB gzipped", () => {
    let total = 0;
    for (const f of readdirSync(PUBLIC).filter((f) => f.endsWith(".js"))) total += Bun.gzipSync(readFileSync(join(PUBLIC, f))).byteLength;
    console.log(`public JS gzipped: ${(total / 1024).toFixed(1)} KB`);
    expect(total).toBeLessThanOrEqual(60 * 1024);
  });
});
