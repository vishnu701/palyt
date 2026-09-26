// Per-language strings for the paths that never touch the model (tap answers, readback,
// fallbacks). Languages: hi, mr, kn, en; anything else falls back to English.
import { displayName } from "../../contracts/catalog";
import type { Entry, SpokenUnit } from "../../contracts/protocol";

type L = "hi" | "mr" | "kn" | "en";

export function langKey(language: string): L {
  const s = language.slice(0, 2).toLowerCase();
  return s === "hi" || s === "mr" || s === "kn" ? s : "en";
}

const UNIT_LABELS: Record<L, Record<SpokenUnit, string>> = {
  en: { kg: "kg", g: "g", l: "litre", ml: "ml", pcs: "pieces", dozen: "dozen", portion: "portions", packet: "packets", c: "°C", none: "" },
  hi: { kg: "किलो", g: "ग्राम", l: "लीटर", ml: "मिली", pcs: "पीस", dozen: "दर्जन", portion: "पोर्शन", packet: "पैकेट", c: "डिग्री", none: "" },
  mr: { kg: "किलो", g: "ग्रॅम", l: "लिटर", ml: "मिली", pcs: "नग", dozen: "डझन", portion: "पोर्शन", packet: "पॅकेट", c: "डिग्री", none: "" },
  kn: { kg: "ಕಿಲೋ", g: "ಗ್ರಾಂ", l: "ಲೀಟರ್", ml: "ಮಿಲಿ", pcs: "ಪೀಸ್", dozen: "ಡಜನ್", portion: "ಪೋರ್ಷನ್", packet: "ಪ್ಯಾಕೆಟ್", c: "ಡಿಗ್ರಿ", none: "" },
};

export function unitLabel(unit: SpokenUnit, language: string): string {
  return UNIT_LABELS[langKey(language)][unit];
}

const ACTION_PHRASE: Record<L, Record<Entry["action"], string>> = {
  en: { receiving: "received", usage: "used", wastage: "wasted", prep: "prepared", stock_count: "counted", temperature_check: "temperature", cleaning: "cleaned", incident: "incident" },
  hi: { receiving: "आया", usage: "इस्तेमाल हुआ", wastage: "खराब", prep: "बना", stock_count: "गिना", temperature_check: "तापमान", cleaning: "साफ़ हुआ", incident: "घटना" },
  mr: { receiving: "आले", usage: "वापरले", wastage: "खराब", prep: "बनवले", stock_count: "मोजले", temperature_check: "तापमान", cleaning: "स्वच्छ केले", incident: "घटना" },
  kn: { receiving: "ಬಂದಿದೆ", usage: "ಬಳಸಿದೆ", wastage: "ಹಾಳಾಗಿದೆ", prep: "ತಯಾರಾಗಿದೆ", stock_count: "ಎಣಿಸಿದೆ", temperature_check: "ತಾಪಮಾನ", cleaning: "ಸ್ವಚ್ಛಗೊಳಿಸಿದೆ", incident: "ಘಟನೆ" },
};

const STRINGS: Record<L, {
  confirm: string; saved: string; left: string; unclear: string; cancelled: string;
  askItem: string; askQuantity: string; askUnit: string; askUnknown: string;
}> = {
  en: { confirm: "Is this correct?", saved: "saved.", left: "Left", unclear: "Sorry, I didn't catch that.", cancelled: "Cancelled.", askItem: "Which one: {opts}?", askQuantity: "How much {item}?", askUnit: "{item} in which unit: {opts}?", askUnknown: "{item} isn't in the inventory list — which item do you mean?" },
  hi: { confirm: "सही है?", saved: "दर्ज हो गया।", left: "बचा", unclear: "माफ़ कीजिए, समझ नहीं आया।", cancelled: "रद्द कर दिया।", askItem: "कौन सा: {opts}?", askQuantity: "{item} कितना?", askUnit: "{item} किस यूनिट में: {opts}?", askUnknown: "{item} हमारे स्टॉक में नहीं है — किस चीज़ की बात है?" },
  mr: { confirm: "बरोबर आहे?", saved: "नोंद झाली.", left: "उरले", unclear: "माफ करा, समजले नाही.", cancelled: "रद्द केले.", askItem: "कोणते: {opts}?", askQuantity: "{item} किती?", askUnit: "{item} कोणत्या युनिटमध्ये: {opts}?", askUnknown: "{item} आपल्या स्टॉकमध्ये नाही — कोणती वस्तू म्हणताय?" },
  kn: { confirm: "ಸರಿಯೇ?", saved: "ದಾಖಲಾಗಿದೆ.", left: "ಉಳಿದಿದೆ", unclear: "ಕ್ಷಮಿಸಿ, ಅರ್ಥವಾಗಲಿಲ್ಲ.", cancelled: "ರದ್ದು ಮಾಡಲಾಗಿದೆ.", askItem: "ಯಾವುದು: {opts}?", askQuantity: "{item} ಎಷ್ಟು?", askUnit: "{item} ಯಾವ ಯುನಿಟ್‌ನಲ್ಲಿ: {opts}?", askUnknown: "{item} ನಮ್ಮ ಸ್ಟಾಕ್‌ನಲ್ಲಿ ಇಲ್ಲ — ಯಾವ ಸಾಮಾನು ಹೇಳುತ್ತಿದ್ದೀರಿ?" },
};

export function fmtNum(n: number | null): string {
  if (n === null) return "";
  return String(Math.round(n * 1000) / 1000);
}

/** "5 किलो पनीर खराब" — one entry, no punctuation. */
export function describeEntry(e: Entry, language: string): string {
  const l = langKey(language);
  const item = e.item_id === "unknown" ? e.item_heard : displayName(e.item_id, language);
  if (e.action === "temperature_check") {
    const t = e.temperature_c === null ? "" : `${fmtNum(e.temperature_c)} ${UNIT_LABELS[l].c}`;
    return [item, t].filter(Boolean).join(" ");
  }
  if (e.action === "cleaning" || e.action === "incident") return `${item} ${ACTION_PHRASE[l][e.action]}`;
  const qty = e.quantity === null ? "" : `${fmtNum(e.quantity)} ${unitLabel(e.unit, language)}`.trim();
  return [qty, item, ACTION_PHRASE[l][e.action]].filter(Boolean).join(" ");
}

function fullStop(l: L): string {
  return l === "en" || l === "kn" ? "." : "।";
}

export function confirmText(entries: Entry[], language: string): string {
  const l = langKey(language);
  const body = entries.map((e) => describeEntry(e, language)).join(", ");
  return `${body}${fullStop(l)} ${STRINGS[l].confirm}`;
}

export function readbackText(entries: Entry[], language: string): string {
  const l = langKey(language);
  const end = fullStop(l);
  const body = entries.map((e) => describeEntry(e, language)).join(", ");
  const parts = [`${body}, ${STRINGS[l].saved}`];
  for (const e of entries) {
    if (e.stock_after !== null && e.base_unit && e.base_unit !== "c") {
      parts.push(`${STRINGS[l].left} ${fmtNum(e.stock_after)} ${unitLabel(e.base_unit, language)}${end}`);
    }
  }
  return parts.join(" ");
}

export function unclearText(language: string): string { return STRINGS[langKey(language)].unclear; }
export function cancelledText(language: string): string { return STRINGS[langKey(language)].cancelled; }

export function fallbackQuestion(
  field: "item_id" | "quantity" | "unit",
  entry: Entry,
  options: { label: string }[],
  language: string,
): string {
  const s = STRINGS[langKey(language)];
  const item = entry.item_id === "unknown" ? entry.item_heard : displayName(entry.item_id, language);
  const opts = options.map((o) => o.label).join(" / ");
  const t = field === "item_id" ? (options.length ? s.askItem : s.askUnknown) : field === "quantity" ? s.askQuantity : s.askUnit;
  return t.replace("{item}", item).replace("{opts}", opts);
}
