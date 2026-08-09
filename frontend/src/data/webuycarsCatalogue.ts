// -----------------------------------------------------------------------------
// WeBuyCars canonical make / model catalogue — curated top-30 SA brands.
//
// Source: WeBuyCars.co.za `/buy-a-car` filter panel (Make + Model
// facets), captured on 2026-08. WBC doesn't expose a public API for
// their catalogue (it's Cloudflare + app-version-header protected), so
// this static snapshot is the pragmatic fallback until we invest in a
// backend proxy.
//
// USAGE
// -----
// - Keys are the WBC-canonical Make labels (already Title-Cased in
//   their catalogue, with initialisms like `BMW` / `MINI` / `GWM`
//   preserved).
// - Each value is a sorted list of WBC-canonical Model labels for
//   that make.
// - When a Kredo make/model isn't found here we fall back to the
//   auto-derived keyword logic in `WeBuyCarsListingsCard.tsx`.
//
// UPDATING
// --------
// When WeBuyCars adds a new model, add the label EXACTLY as it appears
// on their filter panel (case + spacing matter — their URL parser
// treats `Corolla Cross` as a different value from `Corolla_Cross`).
// Prefer canonical marketing names over chassis-code variants (skip
// entries like `Corolla (E170)` unless there's ambiguity).
// -----------------------------------------------------------------------------
export const WEBUYCARS_CATALOGUE: Record<string, string[]> = {
  Toyota: [
    "4Runner", "86", "Agya", "Aygo", "Auris", "Avanza", "bZ4X", "C-HR", "Camry",
    "Conquest", "Corolla", "Corolla Cross", "Corolla Hatch", "Corolla Quest",
    "Cressida", "Etios", "FJ Cruiser", "Fortuner", "GR86", "GR Supra", "GR Yaris",
    "Hiace", "Hilux", "Land Cruiser", "Prado", "Prius", "Quantum", "Rav4", "Rush",
    "RunX", "Starlet", "Supra", "Tazz", "Urban Cruiser", "Vellfire", "Verso",
    "Vios", "Yaris", "Yaris Cross",
  ],
  Volkswagen: [
    "Amarok", "Beetle", "Caddy", "CrossFox", "Cross Polo", "Fox", "Golf",
    "Golf GTI", "Jetta", "Kombi", "Polo", "Polo Cross", "Polo Vivo",
    "Scirocco", "Sharan", "T-Cross", "T-Roc", "Tiguan", "Tiguan Allspace",
    "Touareg", "Touran", "Transporter", "Up!",
  ],
  Ford: [
    "B-Max", "Bantam", "Courier", "EcoSport", "Edge", "Escape", "Everest",
    "Explorer", "F-150 Raptor", "Fiesta", "Figo", "Focus", "Fusion", "Kuga",
    "Mustang", "Puma", "Ranger", "Ranger Raptor", "Territory", "Tourneo", "Transit",
  ],
  BMW: [
    "1 Series", "2 Series", "3 Series", "4 Series", "5 Series", "6 Series",
    "7 Series", "8 Series", "i3", "i4", "i7", "i8", "iX", "iX1", "iX3",
    "M2", "M3", "M4", "M5", "M6", "M8", "X1", "X2", "X3", "X4", "X5", "X6",
    "X7", "XM", "Z3", "Z4", "Z8",
  ],
  "Mercedes-Benz": [
    "A-Class", "AMG GT", "B-Class", "C-Class", "CL-Class", "CLA-Class",
    "CLK-Class", "CLS-Class", "E-Class", "EQC", "EQE", "EQS", "EQV",
    "G-Class", "GL-Class", "GLA-Class", "GLB-Class", "GLC-Class", "GLE-Class",
    "GLK-Class", "GLS-Class", "M-Class", "ML-Class", "R-Class", "S-Class",
    "SL-Class", "SLC-Class", "SLK-Class", "Sprinter", "V-Class", "Viano",
    "Vito", "X-Class",
  ],
  Audi: [
    "A1", "A3", "A4", "A5", "A6", "A7", "A8", "e-tron", "e-tron GT",
    "Q2", "Q3", "Q4 e-tron", "Q5", "Q7", "Q8", "R8", "RS3", "RS4", "RS5",
    "RS6", "RS7", "RSQ3", "RSQ5", "RSQ7", "RSQ8", "S1", "S3", "S4", "S5",
    "S6", "S7", "S8", "SQ2", "SQ5", "SQ7", "SQ8", "TT", "TT RS", "TTS",
  ],
  Nissan: [
    "350Z", "370Z", "Almera", "Ariya", "GT-R", "Hardbody", "Juke", "Leaf",
    "Livina", "Magnite", "Micra", "Micra Active", "Murano", "Navara", "NP200",
    "NP300", "Pathfinder", "Patrol", "Pulsar", "Qashqai", "Sylphy", "Tiida",
    "X-Trail",
  ],
  Hyundai: [
    "Accent", "Atos", "Bayon", "Creta", "Elantra", "Getz", "Grand i10", "H-1",
    "H100", "i10", "i20", "i30", "ix35", "Kona", "Palisade", "Santa Fe",
    "Sonata", "Staria", "Tucson", "Veloster", "Venue",
  ],
  Kia: [
    "Cerato", "EV6", "Grand Sedona", "K2500", "K2700", "Niro", "Optima",
    "Picanto", "Pride", "Rio", "Sedona", "Seltos", "Sonet", "Sorento",
    "Soul", "Sportage", "Stinger", "Stonic",
  ],
  Renault: [
    "Captur", "Clio", "Duster", "Fluence", "Kadjar", "Kangoo", "Kiger",
    "Koleos", "Kwid", "Megane", "Modus", "Sandero", "Sandero Stepway",
    "Scenic", "Trafic", "Triber",
  ],
  "Land Rover": [
    "Defender", "Defender 90", "Defender 110", "Discovery", "Discovery Sport",
    "Freelander", "Range Rover", "Range Rover Evoque", "Range Rover Sport",
    "Range Rover Velar",
  ],
  Jeep: [
    "Cherokee", "Commander", "Compass", "Gladiator", "Grand Cherokee",
    "Renegade", "Wrangler", "Wrangler Unlimited",
  ],
  MINI: [
    "3-Door", "5-Door", "Clubman", "Convertible", "Cooper", "Cooper S",
    "Countryman", "Coupe", "JCW", "One", "Paceman", "Roadster",
  ],
  Mahindra: [
    "Bolero", "KUV100", "Pik-Up", "Scorpio", "Scorpio-N", "Thar", "TUV300",
    "XUV300", "XUV500", "XUV700", "Xylo",
  ],
  Isuzu: ["D-Max", "KB", "mu-X"],
  Suzuki: [
    "Alto", "Baleno", "Celerio", "Ciaz", "Dzire", "Ertiga", "Fronx",
    "Grand Vitara", "Ignis", "Jimny", "Kizashi", "S-Presso", "Splash",
    "Swift", "SX4", "Vitara",
  ],
  Mazda: [
    "2", "3", "5", "6", "BT-50", "CX-3", "CX-30", "CX-5", "CX-60", "CX-9",
    "MX-30", "MX-5", "RX-8", "Tribute",
  ],
  Honda: [
    "Accord", "Amaze", "BR-V", "Brio", "Civic", "City", "CR-V", "Elevate",
    "Fit", "HR-V", "Jazz", "Odyssey", "S2000", "WR-V",
  ],
  Chevrolet: [
    "Aveo", "Captiva", "Corsa", "Cruze", "Lumina", "Optra", "Orlando", "Sonic",
    "Spark", "Trailblazer", "Utility",
  ],
  Opel: [
    "Adam", "Astra", "Combo", "Corsa", "Corsa Utility", "Grandland", "Insignia",
    "Kadett", "Meriva", "Mokka", "Vectra", "Zafira",
  ],
  Peugeot: [
    "108", "2008", "206", "207", "208", "3008", "306", "307", "308", "407",
    "5008", "508", "607", "Boxer", "Expert", "Landtrek", "Partner", "RCZ",
    "Rifter", "Traveller",
  ],
  Citroen: [
    "Aircross", "Berlingo", "C-Elysee", "C1", "C2", "C3", "C3 Aircross",
    "C3 Picasso", "C4", "C4 Cactus", "C4 Picasso", "C5", "C5 Aircross",
    "DS3", "DS4", "DS5", "Grand C4 Picasso", "Xsara",
  ],
  Fiat: [
    "500", "500L", "500X", "Bravo", "Doblo", "Ducato", "Fiorino", "Fullback",
    "Idea", "Linea", "Palio", "Panda", "Punto", "Qubo", "Siena", "Strada",
    "Tipo", "Uno",
  ],
  Volvo: [
    "C40", "EX30", "EX90", "S40", "S60", "S80", "S90", "V40", "V50", "V60",
    "V90", "XC40", "XC60", "XC70", "XC90",
  ],
  Porsche: [
    "718 Boxster", "718 Cayman", "911", "928", "944", "968", "Boxster",
    "Cayenne", "Cayman", "Macan", "Panamera", "Taycan",
  ],
  Jaguar: [
    "E-Pace", "F-Pace", "F-Type", "I-Pace", "S-Type", "X-Type", "XE", "XF",
    "XJ", "XJ6", "XJS", "XK",
  ],
  GWM: [
    "C10", "Florid", "H1", "H2", "H3", "H5", "H6", "Ora", "P-Series", "Steed",
    "Steed 5", "Steed 6", "Tank 300", "Wingle", "X200", "X240",
  ],
  Haval: ["H1", "H2", "H2s", "H6", "H9", "Jolion"],
  Chery: [
    "Face", "J1", "J2", "J3", "Q22", "QQ", "QQ3", "Tiggo", "Tiggo 2",
    "Tiggo 4", "Tiggo 4 Pro", "Tiggo 7", "Tiggo 7 Pro", "Tiggo 8", "Tiggo 8 Pro",
  ],
};

/** Sorted list of WBC-canonical make labels (used by the dropdown). */
export const WEBUYCARS_MAKES: string[] = Object.keys(WEBUYCARS_CATALOGUE).sort();

/**
 * Case-insensitive lookup for a make. Handles the common aliases used
 * by Kredo (`"LAND ROVER"` → `"Land Rover"`, `"VOLKSWAGEN"` →
 * `"Volkswagen"`, `"VW"` → `"Volkswagen"`, etc.).
 */
export function resolveWbcMake(raw?: string | null): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // Direct hit (respect the canonical casing).
  for (const key of WEBUYCARS_MAKES) {
    if (key.toLowerCase() === s.toLowerCase()) return key;
  }
  // Common aliases.
  const aliases: Record<string, string> = {
    vw: "Volkswagen",
    "vokswagen": "Volkswagen",
    "mercedes benz": "Mercedes-Benz",
    "mercedes": "Mercedes-Benz",
    "landrover": "Land Rover",
    "range rover": "Land Rover",
    "great wall motors": "GWM",
    "greatwall": "GWM",
    "mini cooper": "MINI",
  };
  const alias = aliases[s.toLowerCase()];
  if (alias) return alias;
  return null;
}

/**
 * Best-effort fuzzy match of a Kredo model / derivative keyword to a
 * WBC-canonical model name in the given make's catalogue.
 *
 *  1. Exact case-insensitive match wins.
 *  2. Then longest-prefix-shared wins ("Defender 90" beats "Defender"
 *     when the derivative starts with "Defender 90 D240 SE").
 *  3. Then any WBC model where the first-word matches the first
 *     meaningful token of the derivative.
 *
 * Returns `null` if nothing plausibly matches — the caller should
 * fall back to a text-input override.
 */
export function guessWbcModel(make: string, keyword?: string | null): string | null {
  const catalogue = WEBUYCARS_CATALOGUE[make];
  if (!catalogue || !keyword) return null;
  const kw = keyword.trim().toLowerCase();
  if (!kw) return null;

  // 1. Exact.
  for (const m of catalogue) if (m.toLowerCase() === kw) return m;

  // 2. Longest prefix — sort catalogue by length desc so the more
  //    specific model wins ("Defender 90" > "Defender").
  const byLen = [...catalogue].sort((a, b) => b.length - a.length);
  for (const m of byLen) {
    const ml = m.toLowerCase();
    if (kw.startsWith(ml)) return m;
    if (ml.startsWith(kw)) return m;
  }

  // 3. First-word overlap.
  const first = kw.split(/\s+/)[0];
  for (const m of catalogue) {
    if (m.toLowerCase().split(/\s+/)[0] === first) return m;
  }
  return null;
}
