// FROZEN CONTRACT — demo inventory. Prices are INR per base unit. `names` are shown to staff
// in their language and used by the model to match what was said. `aliases` are extra
// spellings/transliterations. Two rice items on purpose: "chawal" must trigger a question.
import type { BaseUnit } from "./protocol";

export type Lang = "en" | "hi" | "kn" | "mr" | "ta" | "te";

export interface CatalogItem {
  id: string;
  base: BaseUnit;
  price: number;
  opening: number;
  low_threshold: number;
  names: Record<Lang, string>;
  aliases: string[];
  /** Menu item: no stock of its own; logging it consumes its recipe's ingredients. */
  menu?: boolean;
}

export const CATALOG: CatalogItem[] = [
  { id: "paneer",        base: "kg",      price: 350, opening: 12,  low_threshold: 3,  names: { en: "Paneer",          hi: "पनीर",            kn: "ಪನೀರ್",            mr: "पनीर",           ta: "பனீர்",              te: "పనీర్" },           aliases: ["paneer", "cottage cheese"] },
  { id: "milk",          base: "l",       price: 60,  opening: 40,  low_threshold: 10, names: { en: "Milk",            hi: "दूध",             kn: "ಹಾಲು",             mr: "दूध",            ta: "பால்",               te: "పాలు" },            aliases: ["milk", "doodh", "dudh", "haalu", "halu", "paal"] },
  { id: "curd",          base: "kg",      price: 70,  opening: 8,   low_threshold: 2,  names: { en: "Curd",            hi: "दही",             kn: "ಮೊಸರು",            mr: "दही",            ta: "தயிர்",              te: "పెరుగు" },          aliases: ["curd", "dahi", "mosaru", "yogurt", "thayir"] },
  { id: "butter",        base: "kg",      price: 520, opening: 5,   low_threshold: 1,  names: { en: "Butter",          hi: "मक्खन",           kn: "ಬೆಣ್ಣೆ",            mr: "लोणी",           ta: "வெண்ணெய்",           te: "వెన్న" },           aliases: ["butter", "makhan", "benne", "loni", "amul"] },
  { id: "cream",         base: "l",       price: 220, opening: 8,   low_threshold: 3,  names: { en: "Fresh cream",     hi: "क्रीम",           kn: "ಕ್ರೀಮ್",            mr: "क्रीम",           ta: "க்ரீம்",              te: "క్రీమ్" },           aliases: ["cream", "malai", "fresh cream"] },
  { id: "chicken",       base: "kg",      price: 260, opening: 15,  low_threshold: 4,  names: { en: "Chicken",         hi: "चिकन",            kn: "ಕೋಳಿ",             mr: "चिकन",           ta: "கோழி",               te: "చికెన్" },          aliases: ["chicken", "murgi", "murga", "koli", "kozhi"] },
  { id: "eggs",          base: "pcs",     price: 7,   opening: 120, low_threshold: 30, names: { en: "Eggs",            hi: "अंडे",            kn: "ಮೊಟ್ಟೆ",            mr: "अंडी",           ta: "முட்டை",             te: "గుడ్లు" },          aliases: ["egg", "eggs", "anda", "ande", "motte", "andi", "muttai"] },
  { id: "tomato",        base: "kg",      price: 40,  opening: 20,  low_threshold: 5,  names: { en: "Tomato",          hi: "टमाटर",           kn: "ಟೊಮೆಟೊ",           mr: "टोमॅटो",          ta: "தக்காளி",            te: "టమాటా" },           aliases: ["tomato", "tamatar", "thakkali"] },
  { id: "onion",         base: "kg",      price: 35,  opening: 25,  low_threshold: 5,  names: { en: "Onion",           hi: "प्याज़",           kn: "ಈರುಳ್ಳಿ",           mr: "कांदा",           ta: "வெங்காயம்",           te: "ఉల్లిపాయ" },        aliases: ["onion", "pyaaz", "pyaj", "kanda", "eerulli", "vengayam"] },
  { id: "potato",        base: "kg",      price: 30,  opening: 30,  low_threshold: 5,  names: { en: "Potato",          hi: "आलू",             kn: "ಆಲೂಗಡ್ಡೆ",          mr: "बटाटा",           ta: "உருளைக்கிழங்கு",      te: "బంగాళాదుంప" },      aliases: ["potato", "aloo", "alu", "batata", "alugadde"] },
  { id: "coriander",     base: "kg",      price: 80,  opening: 3,   low_threshold: 1,  names: { en: "Coriander",       hi: "धनिया",           kn: "ಕೊತ್ತಂಬರಿ",         mr: "कोथिंबीर",        ta: "கொத்தமல்லி",          te: "కొత్తిమీర" },        aliases: ["coriander", "dhania", "kothimbir", "kottambari"] },
  { id: "rice",          base: "kg",      price: 45,  opening: 40,  low_threshold: 10, names: { en: "Rice",            hi: "साधारण चावल",      kn: "ಅಕ್ಕಿ",             mr: "साधा तांदूळ",      ta: "அரிசி",              te: "బియ్యం" },          aliases: ["rice", "chawal", "chaval", "akki", "tandul", "arisi", "sona masoori", "saadharan", "sadharan", "normal", "plain", "regular", "ordinary"] },
  { id: "rice_basmati",  base: "kg",      price: 110, opening: 20,  low_threshold: 5,  names: { en: "Basmati rice",    hi: "बासमती चावल",      kn: "ಬಾಸ್ಮತಿ ಅಕ್ಕಿ",       mr: "बासमती तांदूळ",    ta: "பாஸ்மதி அரிசி",       te: "బాస్మతి బియ్యం" },   aliases: ["basmati", "basmati rice", "chawal", "chaval", "akki", "tandul"] },
  { id: "atta",          base: "kg",      price: 45,  opening: 25,  low_threshold: 5,  names: { en: "Wheat flour",     hi: "आटा",             kn: "ಗೋಧಿ ಹಿಟ್ಟು",        mr: "कणिक",            ta: "கோதுமை மாவு",         te: "గోధుమ పిండి" },      aliases: ["atta", "flour", "wheat flour", "kanik", "godhi hittu"] },
  { id: "dal",           base: "kg",      price: 120, opening: 15,  low_threshold: 3,  names: { en: "Toor dal",        hi: "तूर दाल",          kn: "ತೊಗರಿ ಬೇಳೆ",         mr: "तूर डाळ",         ta: "துவரம் பருப்பு",       te: "కంది పప్పు" },       aliases: ["dal", "daal", "toor dal", "tur dal", "bele", "paruppu"] },
  { id: "oil",           base: "l",       price: 150, opening: 20,  low_threshold: 5,  names: { en: "Cooking oil",     hi: "तेल",             kn: "ಎಣ್ಣೆ",             mr: "तेल",            ta: "எண்ணெய்",             te: "నూనె" },            aliases: ["oil", "tel", "enne", "refined oil", "ennai"] },
  { id: "matcha",        base: "kg",      price: 3000, opening: 0.2, low_threshold: 0.05, names: { en: "Matcha",          hi: "माचा",            kn: "ಮ್ಯಾಚಾ",            mr: "माचा",           ta: "மாட்சா",              te: "మాచా" },            aliases: ["matcha", "macha", "green tea powder"] },
  // ── Menu items (no stock; price = recipe cost per portion, computed below) ──
  { id: "dal_makhani",         base: "portion", price: 0, opening: 0, low_threshold: 0, menu: true, names: { en: "Dal makhani",          hi: "दाल मखनी",          kn: "ದಾಲ್ ಮಖನಿ",           mr: "दाल मखनी",         ta: "தால் மக்கனி",           te: "దాల్ మఖని" },         aliases: ["dal makhani", "makhani dal"] },
  { id: "paneer_butter_masala", base: "portion", price: 0, opening: 0, low_threshold: 0, menu: true, names: { en: "Paneer butter masala", hi: "पनीर बटर मसाला",     kn: "ಪನೀರ್ ಬಟರ್ ಮಸಾಲ",      mr: "पनीर बटर मसाला",    ta: "பனீர் பட்டர் மசாலா",      te: "పనీర్ బటర్ మసాలా" },   aliases: ["paneer butter masala", "pbm", "butter paneer"] },
  { id: "chicken_curry",       base: "portion", price: 0, opening: 0, low_threshold: 0, menu: true, names: { en: "Chicken curry",        hi: "चिकन करी",          kn: "ಚಿಕನ್ ಕರಿ",            mr: "चिकन करी",          ta: "சிக்கன் கறி",            te: "చికెన్ కర్రీ" },       aliases: ["chicken curry", "murgh curry", "chicken masala"] },
  { id: "paneer_tikka",        base: "portion", price: 0, opening: 0, low_threshold: 0, menu: true, names: { en: "Paneer tikka",         hi: "पनीर टिक्का",         kn: "ಪನೀರ್ ಟಿಕ್ಕಾ",          mr: "पनीर टिक्का",        ta: "பனீர் டிக்கா",           te: "పనీర్ టిక్కా" },       aliases: ["paneer tikka", "tikka"] },
  { id: "gravy_base",    base: "kg",      price: 150, opening: 6,   low_threshold: 2,  names: { en: "Makhani gravy",   hi: "मखनी ग्रेवी",       kn: "ಮಖನಿ ಗ್ರೇವಿ",         mr: "मखनी ग्रेव्ही",     ta: "மக்கனி கிரேவி",        te: "మఖని గ్రేవీ" },       aliases: ["gravy", "makhani gravy", "gravy base"] },
  { id: "walkin_fridge", base: "c",       price: 0,   opening: 0,   low_threshold: 0,  names: { en: "Walk-in fridge",  hi: "वॉक-इन फ्रिज",      kn: "ವಾಕ್-ಇನ್ ಫ್ರಿಜ್",      mr: "वॉक-इन फ्रिज",     ta: "வாக்-இன் ஃப்ரிட்ஜ்",     te: "వాక్-ఇన్ ఫ్రిజ్" },     aliases: ["fridge", "walk in", "walk-in", "cold room", "chiller"] },
  { id: "freezer",       base: "c",       price: 0,   opening: 0,   low_threshold: 0,  names: { en: "Freezer",         hi: "फ्रीज़र",          kn: "ಫ್ರೀಜರ್",            mr: "फ्रीझर",          ta: "ஃப்ரீசர்",             te: "ఫ్రీజర్" },          aliases: ["freezer", "deep freezer"] },
];

// matcha is stocked in kg (0.2 kg = 200 g) so "matcha 20" (grams) converts to 0.02 kg.
export const BY_ID: ReadonlyMap<string, CatalogItem> = new Map(CATALOG.map((i) => [i.id, i]));

/** Bill of materials per ONE portion, quantities in the ingredient's base unit. */
export interface RecipeLine { item_id: string; quantity_base: number }
export const RECIPES: Readonly<Record<string, RecipeLine[]>> = {
  dal_makhani:          [{ item_id: "dal", quantity_base: 0.08 }, { item_id: "butter", quantity_base: 0.02 }, { item_id: "cream", quantity_base: 0.03 }, { item_id: "tomato", quantity_base: 0.05 }, { item_id: "onion", quantity_base: 0.03 }],
  paneer_butter_masala: [{ item_id: "paneer", quantity_base: 0.12 }, { item_id: "gravy_base", quantity_base: 0.15 }, { item_id: "cream", quantity_base: 0.02 }, { item_id: "butter", quantity_base: 0.01 }],
  chicken_curry:        [{ item_id: "chicken", quantity_base: 0.18 }, { item_id: "onion", quantity_base: 0.06 }, { item_id: "tomato", quantity_base: 0.05 }, { item_id: "oil", quantity_base: 0.02 }, { item_id: "curd", quantity_base: 0.02 }],
  paneer_tikka:         [{ item_id: "paneer", quantity_base: 0.15 }, { item_id: "curd", quantity_base: 0.03 }, { item_id: "oil", quantity_base: 0.01 }],
};

/** ₹ cost of one portion from its recipe (ingredient prices). */
export function recipeCost(dish_id: string): number {
  const r = RECIPES[dish_id];
  if (!r) return 0;
  return Math.round(r.reduce((s, l) => s + l.quantity_base * (BY_ID.get(l.item_id)?.price ?? 0), 0) * 100) / 100;
}
// Menu prices are derived, never hand-entered.
for (const item of CATALOG) if (item.menu) item.price = recipeCost(item.id);

export const MENU: readonly CatalogItem[] = CATALOG.filter((i) => i.menu);

export function displayName(id: string, language: string): string {
  const item = BY_ID.get(id);
  if (!item) return id;
  const short = language.slice(0, 2) as Lang;
  return item.names[short] ?? item.names.en;
}

/** Stable text for the system prompt. Must not change between requests (prompt cache). */
export const CATALOG_PROMPT = CATALOG.map(
  (i) => `${i.id} | ${i.base} | ${Object.values(i.names).join(" / ")} | ${i.aliases.join(", ")}`,
).join("\n");

/** Kitchen vocabulary for STT `keyterms`. */
export const KEYTERMS: string[] = [...new Set(CATALOG.flatMap((i) => [i.names.en, ...i.aliases]))];
