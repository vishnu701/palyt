// Minimal QR encoder: byte mode, versions 1–6, error-correction L/M. Enough for a short URL.
// qrMatrix(text, "M") → boolean[size][size] (true = dark). No dependencies.

const EC_TABLE = { // version → ecl → [ecCodewordsPerBlock, [[blockCount, dataCodewordsPerBlock], …]]
  1: { L: [7, [[1, 19]]], M: [10, [[1, 16]]] },
  2: { L: [10, [[1, 34]]], M: [16, [[1, 28]]] },
  3: { L: [15, [[1, 55]]], M: [26, [[1, 44]]] },
  4: { L: [20, [[1, 80]]], M: [18, [[2, 32]]] },
  5: { L: [26, [[1, 108]]], M: [24, [[2, 43]]] },
  6: { L: [18, [[2, 68]]], M: [16, [[4, 27]]] },
};
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };
const ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };

// GF(256) with the QR polynomial 0x11d.
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const ng = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= mul(g[j], EXP[i]); }
    g = ng;
  }
  return g;
}
function rsEncode(data, n) {
  const g = rsGenerator(n), res = new Array(n).fill(0);
  for (const d of data) {
    const f = d ^ res[0];
    res.shift(); res.push(0);
    if (f) for (let j = 0; j < n; j++) res[j] ^= mul(g[j + 1], f);
  }
  return res;
}

function chooseVersion(len, ecl) {
  for (let v = 1; v <= 6; v++) {
    const [, groups] = EC_TABLE[v][ecl];
    const cap = groups.reduce((s, [b, d]) => s + b * d, 0) - 2; // mode + 8-bit count
    if (len <= cap) return v;
  }
  throw new Error("qr: text too long (max ~130 bytes at M)");
}

function encodeCodewords(bytes, version, ecl) {
  const [ecPer, groups] = EC_TABLE[version][ecl];
  const totalData = groups.reduce((s, [b, d]) => s + b * d, 0);
  const bits = [];
  const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  push(0b0100, 4); push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  for (let i = 0; i < 4 && bits.length < totalData * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; data.push(v); }
  for (let p = 0; data.length < totalData; p++) data.push(p % 2 ? 0x11 : 0xec);
  const blocks = [], ecs = [];
  let off = 0;
  for (const [count, len] of groups) for (let b = 0; b < count; b++) { const d = data.slice(off, off + len); off += len; blocks.push(d); ecs.push(rsEncode(d, ecPer)); }
  const out = [];
  const maxLen = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecPer; i++) for (const e of ecs) out.push(e[i]);
  return out;
}

export function qrMatrix(text, ecl = "M") {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length, ecl);
  const codewords = encodeCodewords(bytes, version, ecl);
  const size = version * 4 + 17;
  const grid = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, v) => { grid[y][x] = !!v; fn[y][x] = true; };

  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  for (let i = 8; i < size - 8; i++) { set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0); }
  const al = ALIGN[version];
  for (const cy of al) for (const cx of al) {
    if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // reserve format areas
  for (let i = 0; i < 9; i++) { fn[8][i] = true; fn[i][8] = true; }
  for (let i = 0; i < 8; i++) { fn[8][size - 1 - i] = true; fn[size - 1 - i][8] = true; }
  set(8, size - 8, true);

  // place data
  const total = codewords.length * 8;
  let idx = 0;
  const bit = (i) => (codewords[i >> 3] >> (7 - (i & 7))) & 1;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j;
      const upward = ((right + 1) & 2) === 0;
      const y = upward ? size - 1 - vert : vert;
      if (!fn[y][x]) { grid[y][x] = idx < total ? bit(idx) === 1 : false; idx++; }
    }
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  function applyMask(m, g) { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[m](x, y)) g[y][x] = !g[y][x]; }
  function drawFormat(m, g) {
    const data = (ECL_BITS[ecl] << 3) | m;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const b = (i) => ((bits >>> i) & 1) === 1;
    const s = (x, y, v) => { g[y][x] = v; };
    for (let i = 0; i <= 5; i++) s(8, i, b(i));
    s(8, 7, b(6)); s(8, 8, b(7)); s(7, 8, b(8));
    for (let i = 9; i < 15; i++) s(14 - i, 8, b(i));
    for (let i = 0; i < 8; i++) s(size - 1 - i, 8, b(i));
    for (let i = 8; i < 15; i++) s(8, size - 15 + i, b(i));
    s(8, size - 8, true);
  }
  function penalty(g) {
    let p = 0;
    const runs = (get) => { for (let a = 0; a < size; a++) { let run = 1; for (let b = 1; b < size; b++) { if (get(a, b) === get(a, b - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p += 1; } else run = 1; } } };
    runs((a, b) => g[a][b]); runs((a, b) => g[b][a]);
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = g[y][x]; if (c === g[y][x + 1] && c === g[y + 1][x] && c === g[y + 1][x + 1]) p += 3; }
    const PAT = [[1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]];
    const finderLike = (get) => { for (let a = 0; a < size; a++) for (let b = 0; b <= size - 11; b++) for (const pat of PAT) { let ok = true; for (let k = 0; k < 11 && ok; k++) if ((get(a, b + k) ? 1 : 0) !== pat[k]) ok = false; if (ok) p += 40; } };
    finderLike((a, b) => g[a][b]); finderLike((a, b) => g[b][a]);
    let dark = 0; for (const row of g) for (const v of row) if (v) dark++;
    const k = Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1;
    p += Math.max(0, k) * 10;
    return p;
  }
  let best = null, bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    const g = grid.map((r) => r.slice());
    applyMask(m, g); drawFormat(m, g);
    const sc = penalty(g);
    if (sc < bestScore) { bestScore = sc; best = g; }
  }
  return best;
}
