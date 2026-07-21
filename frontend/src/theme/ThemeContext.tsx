import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

export type ThemeMode = "dark" | "light";

export interface Palette {
  // Backgrounds
  bg: string;
  paper: string;
  card: string;
  cardElev: string;

  // Borders / dividers
  border: string;
  borderLight: string;

  // Primary/accent
  primary: string;
  primaryDark: string;
  neon: string;
  glow: string;
  accent: string;

  // Functional colors
  warning: string;
  success: string;
  danger: string;

  // Text
  text: string;
  textSecondary: string;
  textDisabled: string;

  // Inputs
  inputBg: string;

  // Semantic helpers (used for buttons/icons where content sits on top of
  // primary — e.g. a white pill in dark mode should have BLACK text, and a
  // black pill in light mode should have WHITE text).
  onPrimary: string;
  onDanger: string;

  // Modal / scrim overlay
  overlay: string;
}

// ---------- Palettes ----------

export const darkPalette: Palette = {
  bg: "#000000",
  paper: "#0A0A0A",
  card: "#111111",
  cardElev: "#161616",

  border: "#222222",
  borderLight: "#2C2C2C",

  primary: "#FFFFFF",
  primaryDark: "#D9D9D9",
  neon: "#FFFFFF",
  glow: "#FFFFFF",
  accent: "#FFFFFF",

  warning: "#8E8E93",
  success: "#FFFFFF",
  danger: "#FF4D6D",

  text: "#F5F5F5",
  textSecondary: "#8E8E93",
  textDisabled: "#48484A",

  inputBg: "#0E0E0E",

  onPrimary: "#000000",
  onDanger: "#FFFFFF",

  overlay: "rgba(0,0,0,0.7)",
};

export const lightPalette: Palette = {
  bg: "#FFFFFF",
  paper: "#F5F5F5",
  card: "#FFFFFF",
  cardElev: "#FAFAFA",

  border: "#E2E2E2",
  borderLight: "#D0D0D0",

  primary: "#000000",
  primaryDark: "#262626",
  neon: "#000000",
  glow: "#000000",
  accent: "#000000",

  warning: "#6E6E73",
  success: "#000000",
  danger: "#D32F2F",

  text: "#0A0A0A",
  textSecondary: "#5A5A5F",
  textDisabled: "#B0B0B5",

  inputBg: "#F2F2F2",

  onPrimary: "#FFFFFF",
  onDanger: "#FFFFFF",

  overlay: "rgba(0,0,0,0.45)",
};

// ---------- Context ----------

const STORAGE_KEY = "fourbuy.themeMode";

interface ThemeContextValue {
  mode: ThemeMode;
  colors: Palette;
  setMode: (m: ThemeMode) => void;
  toggle: () => void;
  ready: boolean;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: "dark",
  colors: darkPalette,
  setMode: () => {},
  toggle: () => {},
  ready: true,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Default to dark on first launch (per product decision).
  const [mode, setModeState] = useState<ThemeMode>("dark");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(STORAGE_KEY);
        if (!cancelled && (stored === "dark" || stored === "light")) {
          setModeState(stored);
        }
      } catch {
        // Ignore — dark stays as default.
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    AsyncStorage.setItem(STORAGE_KEY, m).catch(() => {});
  }, []);

  const toggle = useCallback(() => {
    setModeState((prev) => {
      const next: ThemeMode = prev === "dark" ? "light" : "dark";
      AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
      return next;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      colors: mode === "dark" ? darkPalette : lightPalette,
      setMode,
      toggle,
      ready,
    }),
    [mode, setMode, toggle, ready],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export function useThemeColors(): Palette {
  return useContext(ThemeContext).colors;
}

export function useThemeMode(): ThemeMode {
  return useContext(ThemeContext).mode;
}
