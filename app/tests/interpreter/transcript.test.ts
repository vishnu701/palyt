import { describe, expect, test } from "bun:test";
import { extractNumbers, extractUnits, repairAction, matchItemAnswer, findItemsInText, entriesFromText } from "../../src/interpreter/transcript";

describe("extractNumbers", () => {
  test("hinglish words, digits, indic digits, multi", () => {
    expect(extractNumbers("dus kilo chawal aaya")).toEqual([10]);
    expect(extractNumbers("paanch kilo paneer kharab ho gaya")).toEqual([5]);
    expect(extractNumbers("do litre doodh aur teen kilo tamatar aaya")).toEqual([2, 3]);
    expect(extractNumbers("aadha kilo makhan aur dedh kilo dahi")).toEqual([0.5, 1.5]);
    expect(extractNumbers("matcha 20")).toEqual([20]);
    expect(extractNumbers("पाँच किलो पनीर खराब हो गया")).toEqual([5]);
    expect(extractNumbers("ಇಪ್ಪತ್ತು ಲೀಟರ್ ಹಾಲು ಬಂದಿದೆ")).toEqual([20]);
    expect(extractNumbers("20 liter haalu bandide")).toEqual([20]);
    expect(extractNumbers("२.५ किलो")).toEqual([2.5]);
    expect(extractNumbers("twenty eggs received")).toEqual([20]);
    expect(extractNumbers("do sau gram")).toEqual([200]);
    expect(extractNumbers("pachees kilo")).toEqual([25]);
    expect(extractNumbers("basmati")).toEqual([]);
    expect(extractNumbers("ek plate dal makhani kharab")).toEqual([1]);
  });
});

describe("extractUnits", () => {
  test("unit words in order, none when absent", () => {
    expect(extractUnits("dus kilo chawal aaya")).toEqual(["kg"]);
    expect(extractUnits("do litre doodh aur teen kilo tamatar")).toEqual(["l", "kg"]);
    expect(extractUnits("matcha 20")).toEqual([]);
    expect(extractUnits("twenty eggs received")).toEqual([]);   // no unit word → "none" → assumed pcs later
    expect(extractUnits("ek plate dal makhani")).toEqual(["portion"]);
    expect(extractUnits("ಇಪ್ಪತ್ತು ಲೀಟರ್ ಹಾಲು")).toEqual(["l"]);
    expect(extractUnits("walk-in fridge chaar degree")).toEqual(["c"]);
    expect(extractUnits("do sau gram dhania")).toEqual(["g"]);
  });
});

describe("repairAction", () => {
  test("valid passes through; invalid inferred from verbs", () => {
    expect(repairAction("wastage", "x")).toBe("wastage");
    expect(repairAction("spoiled", "paanch kilo paneer kharab ho gaya")).toBe("wastage");
    expect(repairAction("received", "dus kilo chawal aaya")).toBe("receiving");
    expect(repairAction("count", "paneer saat kilo bacha hai")).toBe("stock_count");
    expect(repairAction("??", "matcha 20")).toBe("usage");
  });
});

describe("matchItemAnswer", () => {
  test("answers to a which-item question", () => {
    expect(matchItemAnswer("बासमती", ["rice", "rice_basmati"])).toBe("rice_basmati");
    expect(matchItemAnswer("basmati wala", ["rice", "rice_basmati"])).toBe("rice_basmati");
    expect(matchItemAnswer("saadharan chawal", ["rice", "rice_basmati"])).toBe("rice");
    expect(matchItemAnswer("chawal", ["rice", "rice_basmati"])).toBeNull();          // still ambiguous
    expect(matchItemAnswer("टमाटर", null)).toBe("tomato");                            // unknown-item question: whole catalog
    expect(matchItemAnswer("नहीं, स्टार फ्रूट ही है", null)).toBeNull();
    expect(matchItemAnswer("haalu", null)).toBe("milk");
  });
});

describe("findItemsInText", () => {
  test("names in any script, ambiguity preserved, dishes not double-counted", () => {
    expect(findItemsInText("मक्खन")).toEqual(["butter"]);
    expect(findItemsInText("chawal")).toEqual(["rice", "rice_basmati"]);
    expect(findItemsInText("आधा किलो मक्खन और डेढ़ किलो दही")).toEqual(["butter", "curd"]);
    expect(findItemsInText("star fruit")).toEqual([]);
    expect(findItemsInText("ek plate paneer tikka kharab")).toEqual(["paneer_tikka"]);
    expect(findItemsInText("haalu bandide")).toEqual(["milk"]);
  });
});

describe("entriesFromText (fallback when the model returns nothing)", () => {
  test("builds entries from item words, numbers, units and verbs", () => {
    expect(entriesFromText("पाँच लीटर दूध आया")).toEqual([{ action: "receiving", candidates: ["milk"], item_heard: "Milk", quantity: 5, unit: "l", reason: null, temperature_c: null }]);
    expect(entriesFromText("dus kilo chawal aaya")[0]).toMatchObject({ action: "receiving", candidates: ["rice", "rice_basmati"], quantity: 10, unit: "kg" });
    expect(entriesFromText("aadha kilo makhan aur dedh kilo dahi kharab")).toMatchObject([{ candidates: ["butter"], quantity: 0.5, unit: "kg", action: "wastage" }, { candidates: ["curd"], quantity: 1.5, unit: "kg" }]);
    expect(entriesFromText("aaj bahut garmi hai")).toEqual([]);
    expect(entriesFromText("ek plate paneer tikka kharab")).toMatchObject([{ candidates: ["paneer_tikka"], quantity: 1, unit: "portion" }]);
  });
});
