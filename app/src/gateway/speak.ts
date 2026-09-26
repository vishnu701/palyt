// Fixed spoken lines for cases where no draft exists (SPEC §12, §15). Keyed by 2-letter language.
const LINES: Record<string, { didnt_catch: string; failed: string }> = {
  hi: { didnt_catch: "समझ नहीं आया, फिर से बोलें।", failed: "कुछ गड़बड़ हुई, फिर से बोलें।" },
  mr: { didnt_catch: "समजलं नाही, पुन्हा सांगा.", failed: "काहीतरी चूक झाली, पुन्हा सांगा." },
  kn: { didnt_catch: "ಅರ್ಥವಾಗಲಿಲ್ಲ, ಮತ್ತೆ ಹೇಳಿ.", failed: "ಏನೋ ತಪ್ಪಾಯಿತು, ಮತ್ತೆ ಹೇಳಿ." },
  ta: { didnt_catch: "புரியவில்லை, மீண்டும் சொல்லுங்கள்.", failed: "ஏதோ தவறு, மீண்டும் சொல்லுங்கள்." },
  te: { didnt_catch: "అర్థం కాలేదు, మళ్ళీ చెప్పండి.", failed: "ఏదో తప్పు జరిగింది, మళ్ళీ చెప్పండి." },
  en: { didnt_catch: "Sorry, I didn't catch that. Please say it again.", failed: "Something went wrong. Please say it again." },
};

export function fixedLine(kind: "didnt_catch" | "failed", language: string | null): { text: string; language: string } {
  const short = (language ?? "hi-IN").slice(0, 2);
  const l = LINES[short] ?? LINES.hi!;
  return { text: l[kind], language: LINES[short] ? `${short}-IN` : "hi-IN" };
}
