// South African Motor Vehicle License Disc (PDF417) decoder.
//
// The disc barcode is an unencrypted PDF417 with `%`-delimited fields. eNaTIS
// has issued a few variants over the years so the exact field ORDER isn't
// guaranteed — instead of relying on fixed positions we use robust regex
// anchors (VIN pattern, ISO date, SA number plate, etc.) to identify each
// field, which stays reliable across all known disc formats.
//
// Usage:
//   const parsed = decodeLicenseDisk(rawScanString);
//   parsed.vin, parsed.make, parsed.model, parsed.colour, parsed.expiryDate, ...

export type LicenseDiskInfo = {
  raw: string;
  tokens: string[];
  licenceDiscNo?: string;      // Long unique disc issue number, e.g. "4025013HXOXC"
  licenceNo?: string;          // Number plate, e.g. "KD09MBGP"
  vehicleRegisterNo?: string;  // Register/control number, e.g. "CVL391X"
  vehicleDescription?: string; // e.g. "Hatch back"
  make?: string;               // e.g. "MINI"
  model?: string;              // e.g. "COOPER S"
  colour?: string;             // e.g. "WHITE"
  vin?: string;                // 17-char VIN
  engineNo?: string;           // Engine number
  expiryDate?: string;         // YYYY-MM-DD — licence expiry
  dateOfTest?: string;         // YYYY-MM-DD — last roadworthy/COR test. Blank = 1-owner from new.
};

// SA VIN: 17 alphanumeric chars, excluding I, O, Q.
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;
// ISO date YYYY-MM-DD used on modern discs.
const ISO_DATE_RE = /^(19|20)\d{2}-\d{2}-\d{2}$/;
// SA number plates: e.g. KD09MBGP, CA123456, ND 123-456. Compact form here.
const PLATE_RE = /^[A-Z]{1,3}\s?\d{2,4}\s?[A-Z]{1,3}$/i;
// License disc issue number: mostly digits, sometimes a couple of trailing
// letters (like "4025013HXOXC"). At least 8 chars, mainly numeric.
const DISC_NO_RE = /^\d{6,}[A-Z0-9]{0,6}$/i;
// Descriptions on the disc are words+spaces like "Hatch back", "Motor car (M1)"
const DESCRIPTION_HINTS = [
  "motor",
  "car",
  "hatch",
  "sedan",
  "bakkie",
  "suv",
  "truck",
  "bus",
  "coupe",
  "cabriolet",
  "convertible",
  "station",
  "panel",
  "van",
  "wagon",
  "utility",
];

// Common SA colour vocabulary — helps identify the colour token vs the make/model.
const COLOURS = [
  "white",
  "black",
  "silver",
  "grey",
  "gray",
  "red",
  "blue",
  "green",
  "yellow",
  "orange",
  "brown",
  "beige",
  "gold",
  "bronze",
  "burgundy",
  "maroon",
  "purple",
  "pink",
  "navy",
  "champagne",
  "cream",
  "tan",
];

// Common SA vehicle makes (extend liberally — used only to bias make detection).
const KNOWN_MAKES = [
  "toyota",
  "volkswagen",
  "vw",
  "ford",
  "bmw",
  "mercedes",
  "mercedes-benz",
  "audi",
  "nissan",
  "hyundai",
  "kia",
  "mazda",
  "honda",
  "chevrolet",
  "opel",
  "renault",
  "peugeot",
  "citroen",
  "fiat",
  "suzuki",
  "isuzu",
  "mitsubishi",
  "land rover",
  "range rover",
  "jeep",
  "mini",
  "volvo",
  "porsche",
  "lexus",
  "jaguar",
  "subaru",
  "dodge",
  "gwm",
  "haval",
  "chery",
  "mahindra",
  "tata",
  "iveco",
  "hino",
  "man",
  "scania",
  "daf",
  "renault",
  "smart",
];

const isColour = (t: string) => COLOURS.includes(t.toLowerCase().trim());
const isDescription = (t: string) => {
  const low = t.toLowerCase();
  return DESCRIPTION_HINTS.some((h) => low.includes(h));
};
const isKnownMake = (t: string) => KNOWN_MAKES.includes(t.toLowerCase().trim());

/**
 * Decode a raw SA license disc PDF417 scan.
 * Returns a structured object with best-effort extraction. Every field is
 * optional — if the barcode is malformed or a segment is missing, the field
 * simply won't be set. The caller can fall back to manual entry.
 */
export function decodeLicenseDisk(raw: string): LicenseDiskInfo {
  const out: LicenseDiskInfo = { raw, tokens: [] };
  if (!raw || typeof raw !== "string") return out;

  // Normalize: SA license disc barcodes use `%` delimiters. Some scanners
  // return them URL-decoded already; if they arrive URL-encoded (`%25`)
  // decode once first.
  let s = raw;
  if (s.includes("%25")) {
    try {
      s = decodeURIComponent(s);
    } catch {
      /* keep original */
    }
  }

  const tokens = s
    .split("%")
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t !== "##");
  out.tokens = tokens;

  // Track which token indices we've already claimed so we don't reuse them.
  const claimed = new Set<number>();
  const claim = (idx: number, value: string, field: keyof LicenseDiskInfo) => {
    claimed.add(idx);
    (out as any)[field] = value;
  };

  // 1) VIN — highest-confidence anchor. Take the first 17-char match.
  for (let i = 0; i < tokens.length; i++) {
    if (claimed.has(i)) continue;
    if (VIN_RE.test(tokens[i])) {
      claim(i, tokens[i].toUpperCase(), "vin");
      break;
    }
  }

  // 2) Dates — SA discs carry BOTH `date of test` (earlier) AND `date
  //    of expiry` (later). Collect every ISO YYYY-MM-DD token then
  //    assign chronologically: earliest → dateOfTest, latest → expiry.
  //    Single-date discs (brand-new vehicles that have never been
  //    tested) leave dateOfTest blank, which downstream renders as
  //    "1-Owner from new".
  const dateIdx: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!claimed.has(i) && ISO_DATE_RE.test(tokens[i])) dateIdx.push(i);
  }
  const uniqDates = Array.from(new Set(dateIdx.map((i) => tokens[i])));
  if (uniqDates.length >= 2) {
    uniqDates.sort();
    // Claim by first occurrence of each value.
    const firstIdxOf = (val: string) => dateIdx.find((i) => tokens[i] === val)!;
    claim(firstIdxOf(uniqDates[0]), uniqDates[0], "dateOfTest");
    claim(firstIdxOf(uniqDates[uniqDates.length - 1]), uniqDates[uniqDates.length - 1], "expiryDate");
  } else if (uniqDates.length === 1) {
    const firstIdxOf = dateIdx[0];
    claim(firstIdxOf, uniqDates[0], "expiryDate");
  }

  // 3) Colour — matches a known colour word (single token).
  for (let i = 0; i < tokens.length; i++) {
    if (claimed.has(i)) continue;
    if (isColour(tokens[i])) {
      claim(i, tokens[i].replace(/\b\w/g, (c) => c.toUpperCase()), "colour");
      break;
    }
  }

  // 4) Vehicle description ("Hatch back", "Motor car (M1)", "Sedan", ...).
  for (let i = 0; i < tokens.length; i++) {
    if (claimed.has(i)) continue;
    if (isDescription(tokens[i]) && tokens[i].length <= 40) {
      claim(i, tokens[i], "vehicleDescription");
      break;
    }
  }

  // 5) Make — try known-make list first.
  for (let i = 0; i < tokens.length; i++) {
    if (claimed.has(i)) continue;
    if (isKnownMake(tokens[i])) {
      claim(i, tokens[i].toUpperCase(), "make");
      break;
    }
  }

  // 6) License disc number — long, mostly numeric. Detect this BEFORE the
  //    plate/register-number regex so we can use it as a positional anchor.
  for (let i = 0; i < tokens.length; i++) {
    if (claimed.has(i)) continue;
    if (DISC_NO_RE.test(tokens[i]) && tokens[i].length >= 8) {
      claim(i, tokens[i].toUpperCase(), "licenceDiscNo");
      break;
    }
  }

  // 7) Licence number (plate) & Vehicle register number.
  //    On SA discs these appear in a fixed order RIGHT AFTER the disc number:
  //       <disc no> % <licence no / plate> % <vehicle register no> % ...
  //    Both are short alphanumeric — hard to distinguish by regex alone
  //    (personalised plates break the standard letter/digit/letter pattern),
  //    so we rely on positional order when we know where the disc no is.
  const discIdx = out.licenceDiscNo
    ? tokens.findIndex((t) => t.toUpperCase() === out.licenceDiscNo)
    : -1;
  if (discIdx !== -1) {
    // Grab the next two unclaimed short alphanumeric tokens.
    const grabbed: number[] = [];
    for (let j = discIdx + 1; j < tokens.length && grabbed.length < 2; j++) {
      if (claimed.has(j)) continue;
      const t = tokens[j];
      if (t.length < 3 || t.length > 12) continue;
      if (!/^[A-Z0-9\s\-]+$/i.test(t)) continue;
      // Skip anything that looks like a date, VIN, or all-digit long number.
      if (ISO_DATE_RE.test(t) || VIN_RE.test(t)) continue;
      // Both plate & register number contain at least one letter.
      if (!/[A-Z]/i.test(t)) continue;
      grabbed.push(j);
    }
    if (grabbed[0] !== undefined) {
      claim(grabbed[0], tokens[grabbed[0]].toUpperCase().replace(/\s+/g, ""), "licenceNo");
    }
    if (grabbed[1] !== undefined) {
      claim(grabbed[1], tokens[grabbed[1]].toUpperCase().replace(/\s+/g, ""), "vehicleRegisterNo");
    }
  } else {
    // Fallback: regex-based detection when disc number isn't found.
    for (let i = 0; i < tokens.length; i++) {
      if (claimed.has(i)) continue;
      if (PLATE_RE.test(tokens[i])) {
        claim(i, tokens[i].toUpperCase().replace(/\s+/g, ""), "licenceNo");
        break;
      }
    }
    for (let i = 0; i < tokens.length; i++) {
      if (claimed.has(i)) continue;
      if (/^[A-Z]{2,4}\d{2,5}[A-Z]?$/i.test(tokens[i]) && tokens[i].length <= 10) {
        claim(i, tokens[i].toUpperCase(), "vehicleRegisterNo");
        break;
      }
    }
  }

  // 9) Model — usually the token IMMEDIATELY AFTER the make.
  if (out.make) {
    const makeIdx = tokens.findIndex((t) => t.toUpperCase() === out.make);
    // Look for the next unclaimed alphanumeric token (skip codes, dates, etc.)
    for (let j = makeIdx + 1; j < tokens.length; j++) {
      if (claimed.has(j)) continue;
      const t = tokens[j];
      if (!/[A-Za-z]/.test(t)) continue; // must contain letters
      if (isColour(t) || isDescription(t) || VIN_RE.test(t) || ISO_DATE_RE.test(t)) continue;
      if (t.length < 2 || t.length > 40) continue;
      claim(j, t.toUpperCase(), "model");
      break;
    }
  }

  // 10) Engine number — heuristic: near the VIN, alphanumeric, NOT the VIN
  //     itself, NOT any of the already-claimed slots, 4-15 chars.
  const vinIdx = out.vin
    ? tokens.findIndex((t) => t.toUpperCase() === out.vin)
    : -1;
  if (vinIdx !== -1) {
    // Look one after, then one before, then further out.
    const candidates = [vinIdx + 1, vinIdx - 1, vinIdx + 2, vinIdx - 2];
    for (const idx of candidates) {
      if (idx < 0 || idx >= tokens.length || claimed.has(idx)) continue;
      const t = tokens[idx];
      if (t.length < 4 || t.length > 15) continue;
      if (!/^[A-Z0-9\-]+$/i.test(t)) continue;
      if (ISO_DATE_RE.test(t)) continue;
      claim(idx, t.toUpperCase(), "engineNo");
      break;
    }
  }

  return out;
}

/**
 * Human-readable one-line summary for compact display.
 */
export function summariseLicenseDisk(info: LicenseDiskInfo): string {
  const bits: string[] = [];
  if (info.make) bits.push(info.make);
  if (info.model) bits.push(info.model);
  if (info.vin) bits.push(`VIN ${info.vin}`);
  if (info.licenceNo) bits.push(info.licenceNo);
  return bits.length ? bits.join(" · ") : "Scanned (raw data captured)";
}
