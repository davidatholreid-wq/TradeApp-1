// Design tokens for Fourbuy Car Buying Co.
// Luxury monochrome theme: true black + white + grey with fluorescent cyan
// accents for high-value borders and CTAs.
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

  // Fluorescent electric cyan — signature luxury accent
  primary: "#00E5FF",
  primaryDark: "#00B8D4",
  neon: "#00E5FF",   // alias for glow borders
  glow: "#00E5FF",   // alias for shadowColor

  // Secondary accent kept monochrome (white)
  accent: "#FFFFFF",

  // Functional colors — kept subtly desaturated to preserve the luxury feel
  warning: "#F5A623",
  success: "#00E5FF", // priced / positive → fluorescent cyan for palette consistency
  danger: "#FF4D6D",

  // Text — high contrast on true black
  text: "#F5F5F5",
  textSecondary: "#8E8E93", // iOS-style secondary grey
  textDisabled: "#48484A",

  // Inputs
  inputBg: "#0E0E0E",
};

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };

export const radius = { sm: 6, md: 10, lg: 16, pill: 999 };

// Reusable luxury glow shadow (use as `style={[..., shadows.neon]}` on RN)
export const shadows = {
  neon: {
    shadowColor: colors.neon,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 8,
    elevation: 6,
  },
  soft: {
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 4,
  },
};

// Serif for wordmark/headings to match Fourbuy's classic wordmark feel
export const fonts = {
  serif: Platform.select({ ios: "Georgia", android: "serif", default: "serif" }) as string,
  heading: "System",
  body: "System",
  mono: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) as string,
};

export const BRAND = {
  name: "Fourbuy Car Buying Co.",
  short: "Fourbuy",
  tagline: "Quality Used Cars at Wholesale Prices",
  logoUrl: "https://fourbuy.b-cdn.net/wp-content/uploads/logo.webp",
};
