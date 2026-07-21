// Design tokens for Fourbuy Car Buying Co.
// Monochrome luxury: pure black, white and grey — no colour accents.
// Headings use the same system font as the body, uppercase with wide letter
// spacing for a clean editorial feel.
//
// Runtime theming (dark ↔ light) lives in `./theme/ThemeContext`. Screens/
// components that support the toggle should call `useThemeColors()` and
// recompute their `StyleSheet` inside a `useMemo`. The static `colors`
// export below is the DARK palette and remains available as a fallback for
// modules that haven't been migrated yet.
import { Platform } from "react-native";
import { darkPalette } from "./theme/ThemeContext";

export {
  ThemeProvider,
  useTheme,
  useThemeColors,
  useThemeMode,
  darkPalette,
  lightPalette,
} from "./theme/ThemeContext";
export type { Palette, ThemeMode } from "./theme/ThemeContext";

// Backwards-compatible static export — points at the dark palette (the
// original design). New/refactored code should prefer `useThemeColors()`.
export const colors = darkPalette;

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 };

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
  // Data font for prices / large figures. Same system stack as body text so
  // the numbers feel native, not typewriter-y. Use with the `numberStyle`
  // helper below (or apply fontVariant: ["tabular-nums"] inline) to keep the
  // digits column-aligned without picking up the mono look.
  number: "System",
  mono: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) as string,
};

// Style helper for numeric readouts (prices, mileage, ratings). Pairs the
// system font with tabular-nums so ranges line up under each other while
// staying easy on the eye.
export const numberStyle = {
  fontFamily: "System",
  fontVariant: ["tabular-nums"] as any,
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
