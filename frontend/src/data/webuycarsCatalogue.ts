// -----------------------------------------------------------------------------
// WeBuyCars canonical make / model catalogue — full SA passenger-vehicle
// coverage.
//
// Source: Live capture of WeBuyCars.co.za `/buy-a-car` Make + Model filter
// facets, scanned 2026-06 across every top passenger brand + adjacent
// commercial / motorbike overlaps that WBC groups under the same make.
// WBC doesn't expose a public API for their catalogue (Cloudflare + PoW
// anti-bot header protected), so this static snapshot is the pragmatic
// fallback until we invest in a backend proxy.
//
// USAGE
// -----
// - Keys are the WBC-canonical Make labels EXACTLY as they appear on the
//   site's filter dropdown (e.g. `BMW`, `KIA`, `Mini`, `Mercedes-Benz`).
//   The site's URL parser is CASE-SENSITIVE on the JSON-array make label
//   (`Make=["KIA"]` returns hits, `Make=["Kia"]` returns none).
// - Each value is a sorted list of WBC-canonical Model labels for that
//   make. WBC's model names are often quirky (`A Class` with a SPACE,
//   `X-Class` with a HYPHEN — inconsistent even inside one brand).
//   Preserve the EXACT casing / spacing / punctuation we see on their
//   filter panel.
// - When a Kredo make/model can't be matched to a canonical entry here,
//   the caller can fall back to the auto-derived keyword logic in
//   `WeBuyCarsListingsCard.tsx` (kept as a safety net).
//
// UPDATING
// --------
// Re-run the scan documented in `/app/backend/scripts/wbc_scan.py`
// (WIP). If a model shows on WBC but not here, add it as the label
// appears on their filter panel (spaces vs hyphens matter). Prefer
// canonical marketing names over chassis-code variants unless there's
// ambiguity in the WBC UI itself.
//
// NOTE ON "A-CLASS" vs "A CLASS"
// ------------------------------
// WBC uses "A Class" (SPACE), NOT "A-Class" (HYPHEN). The whole
// Mercedes-Benz class family is space-separated on their filter panel
// (`B Class`, `C Class`, `E Class`, `G Class`, `M Class`, `S Class`,
// `V Class`, `SL Class`, `SLK Class`, ...), with a single lonely
// exception: `X-Class` (hyphenated). Getting this wrong is the #1
// cause of "no matches" on the compare deep-link.
// -----------------------------------------------------------------------------
export const WEBUYCARS_CATALOGUE: Record<string, string[]> = {
  Toyota: ["Agya", "Auris", "Avanza", "Avensis", "Aygo", "C-HR", "Camry", "Condor", "Conquest", "Corolla", "Corolla Cross", "Corolla Quest", "Cressida", "Dyna", "Etios", "Fortuner", "HI ACE", "Hilux", "Land Cruiser", "Land Cruiser 70 Series", "Prado", "Prius", "Quantam", "Quantum", "RAV 4", "Rumion", "Runx", "Rush", "Stallion", "Starlet", "Tazz", "Urban Cruiser", "Venture", "Verso", "Vitz", "Yaris"],
  Volkswagen: ["Amarok", "Beetle", "CC", "Caddy", "Citi", "Crafter", "FOX", "Golf", "Golf 3", "Golf 4", "Golf 5", "Golf 6", "Golf 7", "Golf 8", "Golf Bakkies", "Golf SV", "Jetta", "Jetta 4", "Jetta 5", "Jetta 6", "Kombi AND Microbus", "Kombi D/cab", "Passat", "Polo", "Polo Classic", "Polo Playa", "Polo Vivo", "Scirocco", "T-Cross", "T-ROC", "T5", "T6", "Taigo", "Tiguan", "Touareg", "Touran", "Transporter", "UP", "Volksbus"],
  Ford: ["4000", "B-MAX", "Bantam", "Courier", "Ecosport", "Escort", "Everest", "Fiesta", "Figo", "Focus", "Fusion", "Ikon", "KA", "Kuga", "Mustang", "Puma", "Ranger", "Territory", "Tourneo", "Tourneo Connect", "Transit"],
  BMW: ["1 Series", "2 Series", "2 Series Active Tour", "2 Series Gran Coupe", "3 Series", "3 Series GT", "4 Series", "4 Series Gran Coupe", "5 Series", "6 Series", "7 Series", "C", "F Series", "G Series", "GT", "K Series", "M3", "M5", "M6", "R Series", "S Series", "X1", "X2", "X3", "X4", "X5", "X6", "X7", "Z4", "i3"],
  "Mercedes-Benz": ["A Class", "A Class Sedan", "B Class", "C Class", "C Class Coupe", "C Class Estate", "C Class Sedan", "CL Class", "CLA", "CLC Coupe", "CLK Class Cabriolet", "CLK Class Coupe", "CLS Class", "CLS Shooting Brake", "E Class", "E Class Cabriolet", "E Class Coupe", "E Class Sedan", "G Class", "GL Class", "GLA", "GLB", "GLC", "GLE", "M Class", "S Class", "SL Class Cabriolet", "SLK", "SLK Class", "Sprinter", "V Class", "V250", "Viano", "Vito", "Vito BUS", "W115 Shape Sedan", "X-Class"],
  Audi: ["A1", "A3", "A3 Sportback", "A4", "A4 Allroad", "A5", "A6", "A7", "A8", "Q2", "Q3", "Q5", "Q7", "Q8", "RS3", "RS4", "S3", "S4", "TT"],
  Nissan: ["Almera", "Cabstar", "Grand Livina", "Hardbody", "Interstar", "Juke", "Livina", "Magnite", "Maxima", "Maxima QX", "Micra", "Murano", "NP200", "Navara", "Nv200", "Pathfinder", "Patrol", "Qashqai", "Sani", "Sentra", "Skyline", "Tiida", "X Trail"],
  Hyundai: ["Accent", "Atos", "Atos/Atoz", "Creta", "EX-8", "Elantra", "Exter", "Getz", "Grand Creta", "H-1", "H1", "H100", "Kona", "Palisade", "Santa-FE", "Sonata", "Staria", "Terracan", "Tucson", "Veloster", "Venue", "i10", "i20", "i30", "iX35"],
  KIA: ["Carnival", "Cerato", "K 2500", "K 2700", "Pegas", "Picanto", "Proceed", "RIO", "Sedona", "Seltos", "Shuma", "Sonet", "Sorento", "Soul", "Sportage", "Stinger"],
  Renault: ["Captur", "Clio", "Clio III", "Clio IV", "Duster", "Kadjar", "Kangoo", "Kiger", "Koleos", "Kwid", "Laguna", "Megane", "Megane II", "Megane III", "Megane IV", "Megane RS", "Sandero", "Scenic", "Scenic III", "Trafic", "Triber", "Twingo"],
  "Land Rover": ["Defender", "Defender 110", "Defender 90", "Discovery", "Discovery Sport", "Evoque", "Freelander", "Range Rover", "Range Rover Sport", "Velar"],
  Jeep: ["Cherokee", "Compass", "Grand Cherokee", "Patriot", "Renegade", "Srt8", "Willys", "Wrangler"],
  Mini: ["Clubman", "Cooper", "Cooper 5DR", "Cooper Clubman", "Cooper Convertible", "Cooper Countryman", "Cooper Paceman", "Cooper Roadster", "Mini ONE"],
  Mahindra: ["Bolero", "Genio", "KUV 100", "PIK UP", "Scorpio", "Scorpio-N", "TUV", "Thar", "XUV", "XUV 700", "Xuv300", "Xuv3xo"],
  Isuzu: ["D-MAX", "FSR", "FTR", "FVM", "KB", "MU-X", "N Series", "NLR", "NMR"],
  Suzuki: ["AN", "Alto", "Baleno", "Boulevard", "Celerio", "Ciaz", "DL", "Eeco", "Ertiga", "Fronx", "GSR", "GSX", "GSX-R", "GSX-S", "Grand Vitara", "Ignis", "Jimny", "RMZ", "S-Presso", "SJ", "SX4", "Super Carry", "Swift", "UR", "VZ", "Vitara", "XL6"],
  Mazda: ["323", "B Series", "BT 50 Series", "BT-50 Series", "CX-3", "CX-30", "CX-5", "CX-60", "CX-7", "Etude", "MX5", "MX6", "Mazda 2", "Mazda 3", "Mazda 5", "Mazda 6", "Rustler"],
  Honda: ["ACE", "Accord", "Africa Twin", "Amaze", "BR-V", "Ballade", "Brio", "CB", "CBF", "CBR", "CR-V", "CRF", "CRV", "Civic", "Elevate", "FIT", "HR-V", "Jazz", "NC", "Nx500", "VFR", "WR-V", "XL", "XR", "XRL"],
  Chevrolet: ["Aveo", "Captiva", "Cruze", "Lumina", "Optra", "Orlando", "Sonic", "Spark", "Trailblazer", "Utility"],
  Opel: ["Adam", "Astra", "Combo", "Corsa", "Corsa Utility", "Crossland", "Crossland X", "Grandland X", "Meriva", "Mokka", "Zafira"],
  Peugeot: ["107", "107 / 108", "2008", "206", "207", "208", "3008", "306", "307", "308", "407", "5008", "508", "Boxer", "Expert", "Landtrek", "Partner", "RCZ"],
  Citroen: ["C1", "C2", "C3", "C4", "C5", "Dispatch", "Relay"],
  Fiat: ["500", "500x", "Doblo", "Ducato", "Fiorino", "Fullback", "Grande Punto", "Palio", "Panda", "Qubo", "Tipo"],
  Volvo: ["850", "C30", "FH", "S40", "S60", "S80", "S90", "V40", "V50", "V60", "V90", "XC 90", "Xc40", "Xc60", "Xc90"],
  Porsche: ["Boxster", "Cayenne", "Cayenne Coupe", "Cayman", "Macan", "Panamera"],
  Jaguar: ["E-Pace", "F-Pace", "F-Type", "S-Type", "X-Type", "XE", "XF", "XJ", "XKR"],
  GWM: ["CB", "Florid", "H5", "H6", "M4", "P-Series", "P500", "Steed", "Steed 5", "Tank 300", "Tank 500"],
  Haval: ["H1", "H2", "H6", "H7", "H9", "Jolion"],
  Chery: ["Omoda", "Tiggo", "Tiggo 4", "Tiggo 7", "Tiggo 8 PRO"],
  Lexus: ["ES", "GS", "IS", "LS", "LX", "NX", "RX", "UX"],
  Subaru: ["Forester", "Impreza", "Legacy", "Outback", "XV"],
  "Alfa Romeo": ["156", "Giulia", "Giulietta", "MiTO", "Tonale"],
  Mitsubishi: ["ASX", "Colt", "Eclipse Cross", "Lancer", "Mirage", "Outlander", "Pajero", "Pajero Sport", "Triton", "Xpander"],
  Abarth: ["500/695"],
  BYD: ["Dolphin", "Shark"],
  Baic: ["B30", "B40", "X25", "X55"],
  Bentley: ["Continental"],
  Chrysler: ["Grand Voyager"],
  Daihatsu: ["Charade", "Copen", "Gran MAX", "Sirion", "Terios"],
  Datsun: ["GO", "GO +"],
  Dodge: ["Caliber", "Journey"],
  FAW: ["V2"],
  Foton: ["Truck Mate", "Tunland"],
  Geely: ["CK", "LC"],
  Hummer: ["H3"],
  Ineos: ["Grenadier"],
  Infiniti: ["EX", "FX/QX70", "M", "Q50"],
  JAC: ["N56", "T6", "T8", "T9", "X200"],
  Jaecoo: ["J7"],
  Jetour: ["Dashing", "T1", "T2", "X70"],
  LDV: ["T60"],
  MG: ["MG6", "MGB", "TF"],
  Maserati: ["Granturismo", "Quattroporte"],
  Omoda: ["C5", "C9", "Omoda"],
  Proton: ["GEN 2", "Saga", "X50", "X70", "X90"],
  Smart: ["Coupe", "Forfour", "Fortwo"],
  Ssangyong: ["Korando"],
  Tata: ["Daewoo Novus", "Indica", "LPT", "Super ACE", "Tiago", "Xenon"],
};

/** Sorted list of WBC-canonical make labels (used by the dropdown). */
export const WEBUYCARS_MAKES: string[] = Object.keys(WEBUYCARS_CATALOGUE).sort();

// Normalise a string for loose comparison: lowercase, replace hyphens
// with spaces, collapse repeated whitespace. Used to make our lookups
// tolerant of Kredo/dealer-typed variants like "A-CLASS" vs "A Class",
// "MERCEDES BENZ" vs "Mercedes-Benz", "SANTA FE" vs "Santa-FE".
function normKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Case-insensitive lookup for a make. Handles common aliases used by
 * Kredo (`"LAND ROVER"` → `"Land Rover"`, `"VOLKSWAGEN"` →
 * `"Volkswagen"`, `"VW"` → `"Volkswagen"`, `"KIA"` → `"KIA"`,
 * `"MINI"` → `"Mini"`, etc.).
 *
 * Returns the WBC-canonical make label so the URL filter resolves to
 * the correct brand in their catalogue.
 */
export function resolveWbcMake(raw?: string | null): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // 1. Direct hit (respect the canonical casing).
  for (const key of WEBUYCARS_MAKES) {
    if (key.toLowerCase() === s.toLowerCase()) return key;
  }

  // 2. Common aliases — cover Kredo's ALL-CAPS habits plus common typos
  //    dealers enter free-text.
  const aliases: Record<string, string> = {
    // Volkswagen family
    vw: "Volkswagen",
    volkswagon: "Volkswagen",
    vokswagen: "Volkswagen",
    // Mercedes family — Kredo uses both "MERCEDES-BENZ" and
    // "MERCEDES BENZ", plus dealers often just type "Mercedes".
    "mercedes benz": "Mercedes-Benz",
    "mercedes-benz": "Mercedes-Benz",
    mercedes: "Mercedes-Benz",
    // Land Rover / Range Rover (Kredo splits these; WBC groups both
    // under "Land Rover").
    landrover: "Land Rover",
    "land-rover": "Land Rover",
    "range rover": "Land Rover",
    "range-rover": "Land Rover",
    // GWM / Great Wall Motors
    "great wall motors": "GWM",
    "great wall": "GWM",
    greatwall: "GWM",
    // Case variants for makes where WBC's canonical differs from
    // TitleCase — MINI → Mini, KIA stays uppercase, Mercedes stays
    // hyphenated. Map lower-case forms explicitly so free-text hits
    // resolve.
    mini: "Mini",
    "mini cooper": "Mini",
    kia: "KIA",
    // Nissan alias
    nissan: "Nissan",
    // Emerging Chinese brands often appear in various casings
    baic: "Baic",
    "jac motors": "JAC",
    jaecoo: "Jaecoo",
    jetour: "Jetour",
    omoda: "Omoda",
    "alfa romeo": "Alfa Romeo",
    alfaromeo: "Alfa Romeo",
  };
  const alias = aliases[s.toLowerCase()];
  if (alias) return alias;

  // 3. Loose match — strip punctuation / whitespace and compare.
  const target = normKey(s);
  for (const key of WEBUYCARS_MAKES) {
    if (normKey(key) === target) return key;
  }
  return null;
}

/**
 * Best-effort fuzzy match of a Kredo model / derivative keyword to a
 * WBC-canonical model name in the given make's catalogue.
 *
 *  1. Exact case-insensitive match wins.
 *  2. Then hyphen/space-normalised equality (`"A-CLASS"` matches
 *     `"A Class"` — the primary reported bug).
 *  3. Then longest-prefix-shared wins ("Defender 90" beats "Defender"
 *     when the derivative starts with "Defender 90 D240 SE").
 *  4. Then any WBC model where the first-word matches the first
 *     meaningful token of the derivative.
 *
 * Returns `null` if nothing plausibly matches — the caller should
 * fall back to a text-input override.
 */
export function guessWbcModel(make: string, keyword?: string | null): string | null {
  const catalogue = WEBUYCARS_CATALOGUE[make];
  if (!catalogue || !keyword) return null;
  const raw = keyword.trim();
  if (!raw) return null;
  const kw = raw.toLowerCase();
  const kwNorm = normKey(raw);

  // 1. Exact case-insensitive.
  for (const m of catalogue) if (m.toLowerCase() === kw) return m;

  // 2. Hyphen/space-normalised equality. This is the fix for
  //    Mercedes "A-CLASS" → "A Class", Hyundai "SANTA-FE" → "Santa-FE"
  //    (idempotent), Toyota "RAV4" → "RAV 4" (space vs no-space).
  for (const m of catalogue) if (normKey(m) === kwNorm) return m;

  // 2b. Compact match — strip ALL whitespace + punctuation so "RAV4"
  //     matches "RAV 4", "XC60" matches "XC 60", "iX35" matches
  //     "iX35" (idempotent), etc.
  const kwCompact = kwNorm.replace(/\s+/g, "");
  for (const m of catalogue) {
    if (normKey(m).replace(/\s+/g, "") === kwCompact) return m;
  }

  // 3. Longest prefix — sort catalogue by length desc so the more
  //    specific model wins ("Defender 90" > "Defender").
  const byLen = [...catalogue].sort((a, b) => b.length - a.length);
  for (const m of byLen) {
    const mNorm = normKey(m);
    if (kwNorm.startsWith(mNorm)) return m;
    if (mNorm.startsWith(kwNorm) && kwNorm.length >= 2) return m;
  }

  // 4. First-word overlap on the normalised strings.
  const firstNorm = kwNorm.split(" ")[0];
  for (const m of catalogue) {
    const mFirst = normKey(m).split(" ")[0];
    if (mFirst === firstNorm) return m;
  }
  return null;
}
