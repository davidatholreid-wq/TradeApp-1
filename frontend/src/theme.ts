// Design tokens for Fourbuy Car Buying Co.
// Sourced from www.fourbuy.co.za brand palette
import { Platform } from "react-native";

export const colors = {
  bg: "#0a0a0a",
  paper: "#141414",
  card: "#1a1a1a",
  cardElev: "#1e1e1e",
  border: "#2a2a2a",
  borderLight: "#333333",
  primary: "#066fef", // Fourbuy blue
  primaryDark: "#0555c4",
  accent: "#ec1c24", // Fourbuy red
  warning: "#FF9F0A",
  success: "#34C759",
  danger: "#ec1c24", // reuse brand red for destructive
  text: "#F5F5F5",
  textSecondary: "#9b9b9b",
  textDisabled: "#5a5a5a",
  inputBg: "#1a1a1a",
};

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };

export const radius = { sm: 6, md: 10, lg: 16, pill: 999 };

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
