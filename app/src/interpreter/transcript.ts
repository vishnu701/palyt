// Deterministic reads of the transcript itself: numbers, unit words, action verbs, and answers
// to a pending question. The model decides WHICH item and WHAT happened; anything the text
// states literally (how many, which unit) is taken from the text, so a model slip such as
// "dus kilo" → 12 or "matcha 20" → kg cannot reach the card. Pure; unit-tested.
import type { SpokenUnit, Action } from "../../contracts/protocol";
import { CATALOG, BY_ID } from "../../contracts/catalog";
import { ACTIONS } from "../../contracts/protocol";

// ── numbers ──────────────────────────────────────────────────────────────────

const WORD_NUMBERS: Record<string, number> = {
  // Hindi / Hinglish / Marathi (Latin)
  ek: 1, do: 2, don: 2, teen: 3, tin: 3, char: 4, chaar: 4, panch: 5, paanch: 5, pach: 5, chhe: 6, che: 6, saha: 6, saat: 7, sat: 7, aath: 8, ath: 8, nau: 9, nou: 9,
  das: 10, dus: 10, daha: 10, gyarah: 11, barah: 12, terah: 13, chaudah: 14, pandrah: 15, solah: 16, satrah: 17, atharah: 18, unnis: 19,
  bees: 20, bis: 20, vees: 20, vis: 20, pachees: 25, tees: 30, tis: 30, chalis: 40, chaalis: 40, pachas: 50, pachaas: 50, sath: 60, sattar: 70, assi: 80, nabbe: 90, sau: 100, sao: 100,
  aadha: 0.5, adha: 0.5, ardha: 0.5, ardh: 0.5, dedh: 1.5, dhai: 2.5, adich: 2.5, sava: 1.25, sawa: 1.25, paune: 0.75,
  // Kannada (Latin)
  ondu: 1, eradu: 2, mooru: 3, muru: 3, naalku: 4, nalku: 4, aidu: 5, ayidu: 5, aaru: 6, elu: 7, yelu: 7, entu: 8, ombattu: 9, hattu: 10, ippattu: 20, ippatthu: 20, muvattu: 30, nalavattu: 40, aivattu: 50, nooru: 100,
  // Tamil / Telugu (Latin, common)
  onnu: 1, rendu: 2, moonu: 3, naalu: 4, anju: 5, aaru_ta: 6, pathu: 10, irupathu: 20, okati: 1, rendu_te: 2, moodu: 3, nalugu: 4, aidu_te: 5, padi: 10, iravai: 20,
  // English
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, half: 0.5, quarter: 0.25,
  // Devanagari
  "एक": 1, "दो": 2, "दोन": 2, "तीन": 3, "चार": 4, "पाँच": 5, "पांच": 5, "पाच": 5, "छह": 6, "छे": 6, "सहा": 6, "सात": 7, "आठ": 8, "नौ": 9, "नऊ": 9, "दस": 10, "दहा": 10, "ग्यारह": 11, "बारह": 12, "पंद्रह": 15,
  "बीस": 20, "वीस": 20, "पच्चीस": 25, "तीस": 30, "चालीस": 40, "पचास": 50, "साठ": 60, "सत्तर": 70, "अस्सी": 80, "नब्बे": 90, "सौ": 100, "शंभर": 100,
  "आधा": 0.5, "अर्धा": 0.5, "डेढ़": 1.5, "डेढ": 1.5, "दीड": 1.5, "ढाई": 2.5, "अडीच": 2.5, "सवा": 1.25, "पौने": 0.75,
  // Kannada script
  "ಒಂದು": 1, "ಎರಡು": 2, "ಮೂರು": 3, "ನಾಲ್ಕು": 4, "ಐದು": 5, "ಆರು": 6, "ಏಳು": 7, "ಎಂಟು": 8, "ಒಂಬತ್ತು": 9, "ಹತ್ತು": 10, "ಇಪ್ಪತ್ತು": 20, "ಮೂವತ್ತು": 30, "ನಲವತ್ತು": 40, "ಐವತ್ತು": 50, "ನೂರು": 100, "ಅರ್ಧ": 0.5, "ಒಂದೂವರೆ": 1.5,
};

const DIGIT_MAP: Record<string, string> = {
  "०": "0", "१": "1", "२": "2", "३": "3", "४": "4", "५": "5", "६": "6", "७": "7", "८": "8", "९": "9",
  "೦": "0", "೧": "1", "೨": "2", "೩": "3", "೪": "4", "೫": "5", "೬": "6", "೭": "7", "೮": "8", "೯": "9",
};

export function latinDigits(text: string): string {
  return text.replace(/[०-९೦-೯]/g, (d) => DIGIT_MAP[d] ?? d);
}

/** Every quantity the text states, in order. "dus kilo chawal aur do litre doodh" → [10, 2]. */
export function extractNumbers(text: string): number[] {
  const t = latinDigits(text).toLowerCase();
  const out: number[] = [];
  // tokens: digit groups (with optional decimal) or words
  const re = /\d+(?:[.,]\d+)?|[\p{L}\p{M}]+/gu;
  let m: RegExpExecArray | null;
  const tokens: string[] = [];
  while ((m = re.exec(t))) tokens.push(m[0]);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (/^\d/.test(tok)) { out.push(Number(tok.replace(",", "."))); continue; }
    const n = WORD_NUMBERS[tok];
    if (n === undefined) continue;
    // "do sau" / "two hundred" / "dedh sau" → multiply; "sau bees" → add
    const prev = out[out.length - 1];
    const prevTok = tokens[i - 1];
    if (n === 100 && prev !== undefined && prevTok && WORD_NUMBERS[prevTok] !== undefined && prev < 100) { out[out.length - 1] = prev * 100; continue; }
    if (prev !== undefined && prevTok && (WORD_NUMBERS[prevTok] === 100 || (prev >= 20 && prev % 10 === 0 && n < 10 && WORD_NUMBERS[prevTok] !== undefined))) { out[out.length - 1] = prev + n; continue; }
    out.push(n);
  }
  return out;
}

// ── units ────────────────────────────────────────────────────────────────────

const W = (alts: string): RegExp => new RegExp(`(?<![\\p{L}\\p{M}])(?:${alts})(?![\\p{L}\\p{M}])`, "iu");
const UNIT_WORDS: [RegExp, SpokenUnit][] = [
  [W("kgs?|kilo(?:s|gram|grams)?|किलो|ಕಿಲೋ|கிலோ|కిలో"), "kg"],
  [W("grams?|gm|gms|ग्राम|ग्रॅम|ಗ್ರಾಂ|கிராம்|గ్రాము"), "g"],
  [W("litres?|liters?|ltr|ltrs|लीटर|लिटर|ಲೀಟರ್|லிட்டர்|లీటర్"), "l"],
  [W("ml|millilitres?|milliliters?|मिली|ಮಿಲಿ"), "ml"],
  [W("plates?|portions?|प्लेट|पोर्शन|ಪ್ಲೇಟ್|ಪೋರ್ಷನ್|தட்டு|ప్లేట్"), "portion"],
  [W("packets?|pkt|dabba|dabbe|पैकेट|पॅकेट|डिब्बा|ಪ್ಯಾಕೆಟ್"), "packet"],
  [W("dozens?|darjan|दर्जन|डझन|ಡಜನ್"), "dozen"],
  [W("pieces?|pcs|piece|nag|नग|पीस|ಪೀಸ್|ande|anda|अंडे|अंडा"), "pcs"],
  [W("degrees?|deg|डिग्री|ಡಿಗ್ರಿ|°c"), "c"],
];

/** Unit words in the text, in order of appearance. */
export function extractUnits(text: string): SpokenUnit[] {
  const t = text.toLowerCase();
  const hits: { i: number; u: SpokenUnit }[] = [];
  for (const [re, u] of UNIT_WORDS) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = g.exec(t))) hits.push({ i: m.index, u });
  }
  hits.sort((a, b) => a.i - b.i);
  return hits.map((h) => h.u);
}

// ── action ───────────────────────────────────────────────────────────────────

const ACTION_HINTS: [RegExp, Action][] = [
  [/kharab|खराब|kedide|ಕೆಟ್ಟ|ಹಾಳ|phenk|फेंक|spoil|wast|rotten|expired|gir gaya|गिर|dropped|burnt|jal gaya|जल/iu, "wastage"],
  [/aaya|aayi|aaye|आया|आयी|आए|bandide|ಬಂದಿದೆ|banthu|aala|आला|आले|received|receive|delivery|deliver|arrived|pahunch/iu, "receiving"],
  [/bana|बना|banaya|banayi|tayyar|तैयार|prepared|prepped|made|ready|ಮಾಡಿದ|ತಯಾರ/iu, "prep"],
  [/bacha|बचा|baaki|बाकी|left|remaining|gina|गिना|count|ide|ಇದೆ|hai\b|है|aahe|आहे|shillak|शिल्लक|उरल/iu, "stock_count"],
  [/degree|डिग्री|ಡಿಗ್ರಿ|temperature|तापमान/iu, "temperature_check"],
  [/saaf|साफ|clean|ಸ್ವಚ್ಛ|dhoya|धो/iu, "cleaning"],
  [/use|istemal|इस्तेमाल|lagaya|लगाया|liya|लिया|nikala|निकाला|ಬಳಸ/iu, "usage"],
];

/** A valid action: the model's if it is one, else inferred from verbs in the text, else usage. */
export function repairAction(action: string, text: string): Action {
  if ((ACTIONS as readonly string[]).includes(action)) return action as Action;
  for (const [re, a] of ACTION_HINTS) if (re.test(text)) return a;
  return "usage";
}

// ── answers ──────────────────────────────────────────────────────────────────

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/** Which catalog item does a short answer name? Exactly one match among `allowed` (or the whole catalog) → its id. */
export function matchItemAnswer(text: string, allowed: string[] | null): string | null {
  const t = ` ${norm(text)} `;
  const pool = (allowed && allowed.length ? allowed.map((id) => BY_ID.get(id)) : CATALOG).filter((x): x is NonNullable<typeof x> => !!x);
  // words that name each item (full names, aliases, and their individual words ≥ 3 chars)
  const wordsOf = new Map<string, Set<string>>();
  for (const item of pool) {
    const ws = new Set<string>();
    for (const phrase of [item.id.replace(/_/g, " "), ...Object.values(item.names), ...item.aliases].map(norm)) {
      if (phrase.length >= 2) ws.add(phrase);
      for (const w of phrase.split(" ")) if (w.length >= 3) ws.add(w);
    }
    wordsOf.set(item.id, ws);
  }
  const shared = new Set<string>();
  for (const [id, ws] of wordsOf) for (const [id2, ws2] of wordsOf) if (id !== id2) for (const w of ws) if (ws2.has(w)) shared.add(w);
  const hits = new Map<string, number>(); // id → longest distinctive word matched
  for (const [id, ws] of wordsOf) {
    for (const w of ws) if (!shared.has(w) && t.includes(` ${w} `)) hits.set(id, Math.max(hits.get(id) ?? 0, w.length));
  }
  if (hits.size === 1) return [...hits.keys()][0]!;
  if (hits.size > 1) {
    const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked[0]![1] > ranked[1]![1]) return ranked[0]![0];
  }
  return null;
}

/** Every catalog item the text names (any script, any alias). "chawal" → both rices; "मक्खन" → butter. */
export function findItemsInText(text: string): string[] {
  const t = ` ${norm(text)} `;
  const hits: { id: string; pos: number }[] = [];
  for (const item of CATALOG) {
    let best = -1;
    for (const phrase of [item.id.replace(/_/g, " "), ...Object.values(item.names), ...item.aliases].map(norm)) {
      if (phrase.length < 2) continue;
      const i = t.indexOf(` ${phrase} `);
      if (i >= 0 && (best < 0 || i < best)) best = i;
    }
    if (best >= 0) hits.push({ id: item.id, pos: best });
  }
  // a dish name that contains an ingredient's name ("paneer tikka") should not also yield the ingredient
  const ids = hits.sort((a, b) => a.pos - b.pos).map((h) => h.id);
  return ids.filter((id) => !ids.some((other) => other !== id && BY_ID.get(other)?.menu && Object.values(BY_ID.get(other)!.names).map(norm).some((n) => n.includes(` ${norm(BY_ID.get(id)!.names.en)} `) || n.startsWith(`${norm(BY_ID.get(id)!.names.en)} `))));
}

/** Catalog items named in the text, grouped by the word that named them (so "chawal" is ONE
 *  group with two candidates), in order of appearance. */
export function itemGroupsInText(text: string): string[][] {
  const t = ` ${norm(text)} `;
  const byPos = new Map<number, Map<string, number>>(); // pos → id → longest phrase length matched there
  for (const item of CATALOG) {
    for (const phrase of [item.id.replace(/_/g, " "), ...Object.values(item.names), ...item.aliases].map(norm)) {
      if (phrase.length < 2) continue;
      const i = t.indexOf(` ${phrase} `);
      if (i < 0) continue;
      if (!byPos.has(i)) byPos.set(i, new Map());
      const m = byPos.get(i)!;
      m.set(item.id, Math.max(m.get(item.id) ?? 0, phrase.length));
    }
  }
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const pos of [...byPos.keys()].sort((a, b) => a - b)) {
    const m = byPos.get(pos)!;
    const longest = Math.max(...m.values());
    // at one position the longest phrase wins: "paneer tikka" beats "paneer"; "chawal" ties → both rices
    const ids = [...m.entries()].filter(([id, len]) => len === longest && !seen.has(id)).map(([id]) => id);
    if (!ids.length) continue;
    ids.forEach((id) => seen.add(id));
    groups.push(ids);
  }
  return groups;
}

/** Last-resort entries built from the text alone (used when the model returned none). */
export function entriesFromText(text: string): { action: Action; candidates: string[]; item_heard: string; quantity: number | null; unit: SpokenUnit; reason: null; temperature_c: null }[] {
  const groups = itemGroupsInText(text);
  if (!groups.length) return [];
  const nums = extractNumbers(text);
  const units = extractUnits(text);
  const action = repairAction("", text);
  return groups.map((g, i) => ({
    action,
    candidates: g,
    item_heard: BY_ID.get(g[0]!)!.names.en,
    quantity: nums.length === groups.length ? nums[i]! : (groups.length === 1 && nums.length === 1 ? nums[0]! : null),
    unit: units.length === groups.length ? units[i]! : (groups.length === 1 && units.length === 1 ? units[0]! : "none"),
    reason: null,
    temperature_c: null,
  }));
}
