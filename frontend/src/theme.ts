// Design tokens for Fourbuy Car Buying Co.
// Monochrome luxury: pure black, white and grey — no colour accents.
// Headings use the same system font as the body, uppercase with wide letter
// spacing for a clean editorial feel.
import { Platform } from "react-native";

export const colors = {
  // Backgrounds — true black base, subtly elevated cards
  bg: "#000000",
  paper: "#0A0A0A",
  card: "#111111",
  cardElev: "#161616",

  // Borders / dividers
  border: "#222222",
  borderLight: "#2C2C2C",

  // Primary/accent — pure white (was fluorescent cyan)
  primary: "#FFFFFF",
  primaryDark: "#D9D9D9",
  neon: "#FFFFFF",   // alias — used for "highlighted" borders (now just white)
  glow: "#FFFFFF",   // alias — for shadowColor (now just white)
  accent: "#FFFFFF",

  // Functional colors — kept greyscale/muted to preserve the mono aesthetic
  warning: "#8E8E93",     // "pending" indicators — now a neutral grey
  success: "#FFFFFF",     // "priced" indicators — now white
  danger: "#FF4D6D",      // destructive actions only — kept as a pale red

  // Text — high contrast on true black
  text: "#F5F5F5",
  textSecondary: "#8E8E93",
  textDisabled: "#48484A",

  // Inputs
  inputBg: "#0E0E0E",
};

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };

export const radius = { sm: 6, md: 10, lg: 16, pill: 999 };

// Luxury white glow (rarely used — kept for compatibility with the shadows prop)
export const shadows = {
  neon: {
    shadowColor: colors.neon,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 4,
  },
  soft: {
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 4,
  },
};

// ONE font throughout the app: system UI (San Francisco on iOS, Roboto on
// Android, native system stack on web). No serif / no distinct heading font.
// Mono kept for data readouts (VIN, reference IDs) where character alignment
// matters — it's a legibility choice, not a heading style.
export const fonts = {
  // All aliases point at the same system font so any existing usages just work.
  serif: "System",
  heading: "System",
  body: "System",
  mono: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) as string,
};

// Typography scale — sizes chosen for legibility, letter-spacing kept tight
// so text feels editorial rather than stretched. Use these across the app
// instead of ad-hoc sizes so headings & body stay consistent.
export const type = {
  // Screen / section titles
  hero: { fontSize: 26, fontWeight: "800" as const, letterSpacing: 0.4 },
  h1: { fontSize: 20, fontWeight: "800" as const, letterSpacing: 0.3 },
  h2: { fontSize: 17, fontWeight: "800" as const, letterSpacing: 0.3 },
  h3: { fontSize: 15, fontWeight: "700" as const, letterSpacing: 0.2 },
  // Body / label / caption
  body: { fontSize: 15, fontWeight: "500" as const, letterSpacing: 0.1 },
  bodyStrong: { fontSize: 15, fontWeight: "700" as const, letterSpacing: 0.1 },
  small: { fontSize: 13, fontWeight: "500" as const, letterSpacing: 0.1 },
  smallStrong: { fontSize: 13, fontWeight: "700" as const, letterSpacing: 0.1 },
  // Uppercase mini-labels (used sparingly for section eyebrows / chips)
  eyebrow: { fontSize: 11, fontWeight: "700" as const, letterSpacing: 1.2, textTransform: "uppercase" as const },
  // Data monospace (VIN, reference numbers)
  mono: { fontSize: 14, fontWeight: "700" as const, letterSpacing: 0.5 },
  monoLarge: { fontSize: 18, fontWeight: "800" as const, letterSpacing: 0.8 },
};

export const BRAND = {
  name: "Fourbuy Car Buying Co.",
  short: "Fourbuy",
  tagline: "Quality Used Cars at Wholesale Prices",
  // Local bundled logo — dark background monochrome (white text + car icon).
  // Use require() so the packager statically resolves the asset.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  logo: require("../assets/images/logo-fourbuy.png"),
  // Legacy remote URL kept for the login background fallback only.
  logoUrl: "https://fourbuy.b-cdn.net/wp-content/uploads/logo.webp",
};
