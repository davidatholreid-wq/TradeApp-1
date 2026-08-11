// -----------------------------------------------------------------------------
// AutoTrader.co.za canonical make / model catalogue.
//
// AutoTrader deep-links follow the pattern:
//   /cars-for-sale/{make-slug}/{model-slug}
// e.g. `/cars-for-sale/mercedes-benz/a-class`, `/cars-for-sale/bmw/3-series`.
//
// AutoTrader is Cloudflare + geo-restricted (only reachable from ZA
// IPs), so we can't live-scrape their taxonomy from the pod. Instead
// this catalogue is a curated snapshot of SA-market passenger models
// using AutoTrader's canonical marketing names (which map 1:1 to their
// URL slugs after lower-casing + hyphenating spaces).
//
// SLUGGING RULES
// --------------
// - Preserve hyphens in model names (`A-Class`, `X-Class`, `E-Pace`,
//   `C-HR`). AutoTrader URL slugs use hyphens for both word breaks
//   AND intra-name hyphens, so `A-Class` becomes `a-class` (single
//   hyphen), `C-HR` becomes `c-hr`.
// - Spaces in model names become hyphens in the slug: `Corolla Cross`
//   → `corolla-cross`, `Range Rover Sport` → `range-rover-sport`,
//   `3 Series` → `3-series`.
// - Preserve alphanumeric mix: `RS4` → `rs4`, `Golf GTI` → `golf-gti`,
//   `Q4 e-tron` → `q4-e-tron`.
//
// NAMING RULES
// ------------
// - Use each manufacturer's canonical MARKETING name as it appears on
//   AutoTrader's model dropdown. For Mercedes that's the hyphenated
//   `A-Class` / `C-Class` etc. (NOT WBC's `A Class` — AT & WBC use
//   different conventions here).
// - Prefer nameplate over chassis-code variants (skip `Corolla (E170)`
//   unless AT actively splits the model that way).
// - When AT splits a family into multiple filter entries (e.g. BMW
//   `2 Series` vs `2 Series Gran Coupe`), list them individually.
//
// UPDATING
// --------
// When a model is missing from the picker or a live AT URL 404s,
// add / correct the entry here so the URL slug matches AT's own
// canonical redirect target. Preserve alphabetical order per make.
// -----------------------------------------------------------------------------
export const AUTOTRADER_CATALOGUE: Record<string, string[]> = {
  Toyota: [
    "86", "Agya", "Auris", "Avanza", "Aygo", "bZ4X", "C-HR", "Camry",
    "Conquest", "Corolla", "Corolla Cross", "Corolla Quest", "Cressida",
    "Etios", "FJ Cruiser", "Fortuner", "GR86", "GR Supra", "GR Yaris",
    "Hiace", "Hilux", "Land Cruiser", "Land Cruiser 70", "Land Cruiser 76",
    "Land Cruiser 78", "Land Cruiser 79", "Land Cruiser 200",
    "Land Cruiser 300", "Prado", "Prius", "Quantum", "RAV4", "Rumion",
    "Runx", "Rush", "Starlet", "Starlet Cross", "Stout", "Supra", "Tazz",
    "Urban Cruiser", "Vellfire", "Venture", "Verso", "Vios", "Yaris",
    "Yaris Cross",
  ],
  Volkswagen: [
    "Amarok", "Beetle", "Caddy", "CC", "CrossFox", "Cross Polo", "Fox",
    "Golf", "Golf GTI", "Golf R", "ID.4", "Jetta", "Kombi", "Multivan",
    "Passat", "Polo", "Polo GTI", "Polo Vivo", "Scirocco", "Sharan",
    "T-Cross", "T-Roc", "Taigo", "Tiguan", "Tiguan Allspace", "Touareg",
    "Touran", "Transporter", "Up!",
  ],
  Ford: [
    "B-Max", "Bantam", "Courier", "EcoSport", "Edge", "Escape", "Everest",
    "Explorer", "F-150 Raptor", "Fiesta", "Fiesta ST", "Figo", "Focus",
    "Focus ST", "Focus RS", "Fusion", "Ikon", "Kuga", "Mustang",
    "Mustang Mach-E", "Puma", "Ranger", "Ranger Raptor", "Territory",
    "Tourneo", "Tourneo Connect", "Transit", "Transit Custom",
  ],
  BMW: [
    "1 Series", "2 Series", "2 Series Active Tourer", "2 Series Gran Coupe",
    "3 Series", "3 Series GT", "4 Series", "4 Series Gran Coupe", "5 Series",
    "6 Series", "6 Series GT", "7 Series", "8 Series", "i3", "i4", "i5",
    "i7", "i8", "iX", "iX1", "iX3", "M2", "M3", "M4", "M5", "M6", "M8",
    "X1", "X2", "X3", "X3 M", "X4", "X4 M", "X5", "X5 M", "X6", "X6 M",
    "X7", "XM", "Z3", "Z4", "Z8",
  ],
  "Mercedes-Benz": [
    "A-Class", "AMG GT", "AMG GT 4-Door", "B-Class", "C-Class", "CL-Class",
    "CLA-Class", "CLE-Class", "CLK-Class", "CLS-Class", "E-Class", "EQA",
    "EQB", "EQC", "EQE", "EQE SUV", "EQS", "EQS SUV", "EQV", "G-Class",
    "GL-Class", "GLA-Class", "GLB-Class", "GLC-Class", "GLC Coupe",
    "GLE-Class", "GLE Coupe", "GLK-Class", "GLS-Class", "M-Class",
    "ML-Class", "R-Class", "S-Class", "SL-Class", "SLC-Class", "SLK-Class",
    "Sprinter", "V-Class", "Viano", "Vito", "X-Class",
  ],
  Audi: [
    "A1", "A3", "A4", "A4 Allroad", "A5", "A6", "A6 Allroad", "A7", "A8",
    "e-tron", "e-tron GT", "Q2", "Q3", "Q4 e-tron", "Q5", "Q7", "Q8",
    "Q8 e-tron", "R8", "RS3", "RS4", "RS5", "RS6", "RS7", "RSQ3", "RSQ5",
    "RSQ7", "RSQ8", "S3", "S4", "S5", "S6", "S7", "S8", "SQ2", "SQ5",
    "SQ7", "SQ8", "TT", "TT RS", "TTS",
  ],
  Nissan: [
    "350Z", "370Z", "Almera", "Ariya", "GT-R", "Hardbody", "Juke",
    "Leaf", "Livina", "Magnite", "Micra", "Micra Active", "Murano",
    "Navara", "NP200", "NP300", "Pathfinder", "Patrol", "Pulsar",
    "Qashqai", "Sentra", "Skyline", "Tiida", "X-Trail",
  ],
  Hyundai: [
    "Accent", "Atos", "Bayon", "Creta", "Elantra", "Getz", "Grand i10",
    "H-1", "H100", "i10", "i20", "i20 N", "i30", "i30 N", "ix35", "Kona",
    "Kona Electric", "Palisade", "Santa Fe", "Sonata", "Staria", "Tucson",
    "Veloster", "Venue",
  ],
  Kia: [
    "Carnival", "Cerato", "EV6", "EV9", "Grand Sedona", "K2500", "K2700",
    "Niro", "Optima", "Picanto", "Pride", "ProCeed", "Rio", "Sedona",
    "Seltos", "Sonet", "Sorento", "Soul", "Sportage", "Stinger", "Stonic",
  ],
  Renault: [
    "Captur", "Clio", "Clio RS", "Duster", "Fluence", "Kadjar", "Kangoo",
    "Kiger", "Koleos", "Kwid", "Megane", "Megane RS", "Modus", "Sandero",
    "Sandero Stepway", "Scenic", "Trafic", "Triber",
  ],
  "Land Rover": [
    "Defender", "Defender 90", "Defender 110", "Defender 130",
    "Discovery", "Discovery Sport", "Freelander", "Range Rover",
    "Range Rover Evoque", "Range Rover Sport", "Range Rover Velar",
  ],
  Jeep: [
    "Cherokee", "Commander", "Compass", "Gladiator", "Grand Cherokee",
    "Renegade", "Wagoneer", "Wrangler", "Wrangler Unlimited",
  ],
  Mini: [
    "3-Door", "5-Door", "Clubman", "Convertible", "Cooper", "Cooper S",
    "Cooper SE", "Countryman", "Coupe", "JCW", "One", "Paceman",
    "Roadster",
  ],
  Mahindra: [
    "Bolero", "KUV100", "Pik-Up", "Scorpio", "Scorpio-N", "Thar",
    "Thar Roxx", "TUV300", "XUV300", "XUV3XO", "XUV500", "XUV700",
    "XUV.e9", "Xylo",
  ],
  Isuzu: ["D-Max", "KB", "mu-X"],
  Suzuki: [
    "Alto", "Baleno", "Celerio", "Ciaz", "Dzire", "Ertiga", "eVX",
    "Fronx", "Grand Vitara", "Ignis", "Jimny", "Jimny 5-Door", "Kizashi",
    "S-Presso", "Splash", "Swift", "Swift Sport", "SX4", "Vitara", "XL6",
  ],
  Mazda: [
    "2", "3", "5", "6", "BT-50", "CX-3", "CX-30", "CX-5", "CX-60", "CX-9",
    "MX-30", "MX-5", "RX-8", "Tribute",
  ],
  Honda: [
    "Accord", "Amaze", "BR-V", "Brio", "Civic", "Civic Type R", "City",
    "CR-V", "Elevate", "Fit", "HR-V", "Jazz", "Odyssey", "Pilot", "S2000",
    "WR-V",
  ],
  Chevrolet: [
    "Aveo", "Captiva", "Corsa", "Corsa Utility", "Cruze", "Lumina",
    "Optra", "Orlando", "Sonic", "Spark", "Trailblazer", "TrailBlazer SS",
    "Utility",
  ],
  Opel: [
    "Adam", "Astra", "Combo", "Corsa", "Corsa Utility", "Crossland",
    "Crossland X", "Grandland", "Grandland X", "Insignia", "Kadett",
    "Meriva", "Mokka", "Mokka-e", "Vectra", "Zafira",
  ],
  Peugeot: [
    "108", "2008", "206", "207", "208", "3008", "306", "307", "308",
    "308 SW", "407", "5008", "508", "607", "Boxer", "Expert", "Landtrek",
    "Partner", "RCZ", "Rifter", "Traveller",
  ],
  Citroen: [
    "Aircross", "Berlingo", "C-Elysee", "C1", "C2", "C3", "C3 Aircross",
    "C3 Picasso", "C4", "C4 Cactus", "C4 Picasso", "C5", "C5 Aircross",
    "DS3", "DS4", "DS5", "Grand C4 Picasso", "Xsara",
  ],
  Fiat: [
    "500", "500L", "500X", "Bravo", "Doblo", "Ducato", "Fiorino",
    "Fullback", "Grande Punto", "Idea", "Linea", "Palio", "Panda",
    "Punto", "Qubo", "Siena", "Strada", "Tipo", "Uno",
  ],
  Volvo: [
    "C40", "EX30", "EX90", "S40", "S60", "S80", "S90", "V40", "V50",
    "V60", "V90", "XC40", "XC60", "XC70", "XC90",
  ],
  Porsche: [
    "718 Boxster", "718 Cayman", "911", "928", "944", "968", "Boxster",
    "Cayenne", "Cayenne Coupe", "Cayman", "Macan", "Macan Electric",
    "Panamera", "Taycan",
  ],
  Jaguar: [
    "E-Pace", "F-Pace", "F-Type", "I-Pace", "S-Type", "X-Type", "XE", "XF",
    "XJ", "XJ6", "XJS", "XK",
  ],
  GWM: [
    "C10", "Cannon", "Cannon Alpha", "H1", "H2", "H5", "H6", "Haval",
    "M4", "Ora", "P-Series", "P500", "Steed", "Steed 5", "Steed 6",
    "Tank 300", "Tank 500", "Wingle",
  ],
  Haval: ["H1", "H2", "H6", "H6 GT", "H9", "H7", "Jolion"],
  Chery: [
    "Face", "J1", "J2", "J3", "QQ", "Tiggo", "Tiggo 2", "Tiggo 4",
    "Tiggo 4 Pro", "Tiggo 7", "Tiggo 7 Pro", "Tiggo 8", "Tiggo 8 Pro",
    "Tiggo Cross",
  ],
  Lexus: [
    "CT", "ES", "GS", "IS", "LC", "LM", "LS", "LX", "NX", "RC", "RX",
    "RX 500h", "UX", "UX 300e",
  ],
  Subaru: [
    "BRZ", "Crosstrek", "Forester", "Impreza", "Legacy", "Outback",
    "Solterra", "Tribeca", "WRX", "XV",
  ],
  "Alfa Romeo": [
    "147", "156", "159", "Brera", "Giulia", "Giulietta", "GT",
    "Junior", "MiTo", "Spider", "Stelvio", "Tonale",
  ],
  Mitsubishi: [
    "ASX", "Colt", "Eclipse Cross", "Lancer", "Mirage", "Outlander",
    "Outlander PHEV", "Pajero", "Pajero Sport", "Triton", "Xpander",
    "Xpander Cross",
  ],
  Abarth: ["500", "500X", "595", "695", "124 Spider"],
  Baic: ["B30", "B40", "D20", "X25", "X55", "Beijing X55"],
  BAIC: ["B30", "B40", "D20", "X25", "X55", "Beijing X55"],
  Bentley: ["Bentayga", "Continental", "Continental GT", "Flying Spur"],
  BYD: ["Atto 3", "Dolphin", "Han", "Seal", "Shark", "Sealion 6", "Song Plus"],
  Chrysler: ["300C", "Grand Voyager", "PT Cruiser", "Sebring", "Voyager"],
  Daihatsu: ["Charade", "Copen", "Gran Max", "Materia", "Sirion", "Terios"],
  Datsun: ["GO", "GO+", "Redi-GO"],
  Dodge: [
    "Avenger", "Caliber", "Challenger", "Charger", "Journey", "Nitro",
    "Ram", "Viper",
  ],
  FAW: ["V2", "V5", "Bestune T77"],
  Foton: ["Tunland", "View", "Sauvana"],
  Geely: [
    "Coolray", "Emgrand", "GC5", "GC6", "GC7", "Geometry C", "GX3", "LC",
    "Panda Mini",
  ],
  Hummer: ["H1", "H2", "H3"],
  Ineos: ["Grenadier", "Quartermaster"],
  Infiniti: ["EX", "FX", "G", "M", "Q30", "Q50", "Q60", "Q70", "QX30", "QX50", "QX70", "QX80"],
  JAC: ["J5", "J6", "N56", "T6", "T8", "T9", "X200"],
  Jaecoo: ["J5", "J7", "J8"],
  Jetour: ["Dashing", "X70", "X90 Plus", "T1", "T2"],
  LDV: ["G10", "T60", "T60 Max", "T60 Plus", "V80"],
  Maserati: [
    "Ghibli", "GranCabrio", "GranTurismo", "Grecale", "Levante", "MC20",
    "Quattroporte",
  ],
  MG: ["3", "5", "4", "6", "HS", "MG3", "MG5", "MGB", "One", "ZS", "ZS EV"],
  Omoda: ["C5", "C7", "C9"],
  Proton: ["Gen-2", "Saga", "X50", "X70", "X90"],
  Smart: ["#1", "#3", "ForFour", "ForTwo"],
  Ssangyong: [
    "Actyon", "Actyon Sports", "Korando", "Kyron", "Musso", "Rexton",
    "Rodius", "Stavic", "Tivoli",
  ],
  Tata: ["Bolt", "Indica", "Indigo", "Nano", "Safari", "Super Ace", "Telcoline", "Tiago", "Xenon"],
};

/** Sorted list of AutoTrader-canonical make labels. */
export const AUTOTRADER_MAKES: string[] = Object.keys(AUTOTRADER_CATALOGUE).sort();

// Normalise a string for loose comparison: lowercase, replace hyphens/
// underscores with spaces, collapse whitespace. Used to make our
// lookups tolerant of Kredo/dealer-typed variants (`A-CLASS` vs
// `A-Class`, `MERCEDES BENZ` vs `Mercedes-Benz`, `RAV4` vs `Rav4`).
function normKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Case-insensitive lookup for a make. Handles common Kredo/dealer
 * aliases (`"LAND ROVER"` → `"Land Rover"`, `"VW"` → `"Volkswagen"`,
 * `"MINI"` → `"Mini"`, etc.).
 */
export function resolveAtMake(raw?: string | null): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // 1. Direct hit (respect the canonical casing).
  for (const key of AUTOTRADER_MAKES) {
    if (key.toLowerCase() === s.toLowerCase()) return key;
  }

  // 2. Common aliases.
  const aliases: Record<string, string> = {
    vw: "Volkswagen",
    volkswagon: "Volkswagen",
    "mercedes benz": "Mercedes-Benz",
    "mercedes-benz": "Mercedes-Benz",
    mercedes: "Mercedes-Benz",
    landrover: "Land Rover",
    "land-rover": "Land Rover",
    "range rover": "Land Rover",
    "great wall motors": "GWM",
    "great wall": "GWM",
    greatwall: "GWM",
    mini: "Mini",
    "mini cooper": "Mini",
    kia: "Kia",
    KIA: "Kia",
    "alfa romeo": "Alfa Romeo",
    alfaromeo: "Alfa Romeo",
  };
  const alias = aliases[s.toLowerCase()] || aliases[s.toUpperCase()];
  if (alias) return alias;

  // 3. Loose match — strip punctuation / whitespace and compare.
  const target = normKey(s);
  for (const key of AUTOTRADER_MAKES) {
    if (normKey(key) === target) return key;
  }
  return null;
}

/**
 * Best-effort fuzzy match of a Kredo model / derivative keyword to an
 * AutoTrader-canonical model name in the given make's catalogue.
 *
 *  1. Exact case-insensitive match wins.
 *  2. Hyphen/space-normalised equality (`"A CLASS"` matches
 *     `"A-Class"`, `"RAV 4"` matches `"RAV4"`, `"3-SERIES"` matches
 *     `"3 Series"`).
 *  3. Compact match (all whitespace stripped).
 *  4. Longest-prefix-shared wins (`"Defender 90"` beats `"Defender"`).
 *  5. First-word overlap on the normalised strings.
 */
export function guessAtModel(make: string, keyword?: string | null): string | null {
  const catalogue = AUTOTRADER_CATALOGUE[make];
  if (!catalogue || !keyword) return null;
  const raw = keyword.trim();
  if (!raw) return null;
  const kw = raw.toLowerCase();
  const kwNorm = normKey(raw);

  // 1. Exact case-insensitive.
  for (const m of catalogue) if (m.toLowerCase() === kw) return m;

  // 2. Hyphen/space-normalised equality.
  for (const m of catalogue) if (normKey(m) === kwNorm) return m;

  // 3. Compact match — strip all whitespace.
  const kwCompact = kwNorm.replace(/\s+/g, "");
  for (const m of catalogue) {
    if (normKey(m).replace(/\s+/g, "") === kwCompact) return m;
  }

  // 4. Longest prefix.
  const byLen = [...catalogue].sort((a, b) => b.length - a.length);
  for (const m of byLen) {
    const mNorm = normKey(m);
    if (kwNorm.startsWith(mNorm)) return m;
    if (mNorm.startsWith(kwNorm) && kwNorm.length >= 2) return m;
  }

  // 5. First-word overlap.
  const firstNorm = kwNorm.split(" ")[0];
  for (const m of catalogue) {
    const mFirst = normKey(m).split(" ")[0];
    if (mFirst === firstNorm) return m;
  }
  return null;
}

/**
 * Convert a make/model label to an AutoTrader-canonical URL slug —
 * lowercase, hyphenated, URL-safe. Preserves numbers and
 * intra-name hyphens.
 *
 * Examples:
 *   "Mercedes-Benz" -> "mercedes-benz"
 *   "A-Class"       -> "a-class"
 *   "3 Series"      -> "3-series"
 *   "Corolla Cross" -> "corolla-cross"
 *   "C-HR"          -> "c-hr"
 *   "RAV4"          -> "rav4"
 *   "Range Rover Sport" -> "range-rover-sport"
 */
export function atSlug(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[/\\]+/g, "-")   // slashes → hyphens
    .replace(/\s+/g, "-")       // spaces → hyphens
    .replace(/[^a-z0-9-]/g, "") // strip anything not [a-z0-9-]
    .replace(/-{2,}/g, "-")     // collapse runs of hyphens
    .replace(/^-+|-+$/g, "");   // trim leading / trailing hyphens
}
