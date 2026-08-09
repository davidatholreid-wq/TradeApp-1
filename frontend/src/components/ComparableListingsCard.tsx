// -----------------------------------------------------------------------------
// ComparableListingsCard — deep-links dealers/admins into AutoTrader.co.za
// search results pre-filtered to comparable stock (same make + model,
// full manufacture-year run of that derivative, and matching fuel type).
// We don't scrape or store anything — we simply hand off to the live
// site so users can eyeball the cheapest example on the market for
// context during the valuation.
// -----------------------------------------------------------------------------
import { useMemo } from "react";
import { View, Text, StyleSheet, Linking, Platform, Image } from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";

// Brand logo image bundled with the app. Kept in assets/images/logos
// so it ships with the JS bundle (no network round-trip needed).
const AUTOTRADER_LOGO = require("@/assets/images/logos/autotrader.png");

type Props = {
  make?: string;
  model?: string;
  derivative?: string;
  /** Fuel type from the submission (e.g. "Petrol", "Diesel", "Hybrid",
   *  "Electric"). Applied as an AutoTrader filter when present. */
  fuelType?: string | null;
  /** Transmission from the submission (e.g. "Automatic", "Manual").
   *  Applied as an AutoTrader filter so we don't have to rely on
   *  ambiguous keyword matches like "A/T" vs "Auto". */
  transmission?: string | null;
  /** Fallback single year (year of production) used when no full range
   *  is available. Ignored if `yearFrom` / `yearTo` are set. */
  year?: number | null;
  /** Optional manufacture-year range for the selected derivative — from
   *  the Kredo `variant_manufacture_range`. When present, we search
   *  the full run of the model instead of a single production year. */
  yearFrom?: number | null;
  yearTo?: number | null;
};

// Kredo model / derivative names carry chassis suffixes like "5 SERIES
// (F10)" or "M5 M-DCT (F90)" that don't match AutoTrader's search
// catalogue. Strip anything in parentheses (chassis codes) and any
// trailing punctuation.
function cleanText(s?: string): string {
  return (s || "").replace(/\([^)]*\)/g, "").replace(/\s{2,}/g, " ").trim();
}

// Slugify for AutoTrader path segments: lowercase, hyphenated, URL-safe.
function slugAT(s: string): string {
  return encodeURIComponent(
    s.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
  );
}

// Split the derivative into meaningful search keywords for AutoTrader.
// Strips technical noise that rarely appears in listing descriptions AND
// that we express as proper AutoTrader filters instead:
//   - Engine displacements: "2.0T", "3.0", "1.5", "1.6D", "2.2di"
//   - Drivetrain codes: "4x4", "4WD", "AWD", "RWD", "FWD", "2WD"
//   - Engine tech: "TDI", "TSI", "GDI", "EcoBoost", etc.
//   - Transmission codes: "A/T", "M/T", "AT", "MT", "DCT", "DSG", "CVT",
//     "AMT", "PDK" (already applied via `transmission=` filter)
//   - Fuel-family words: "Petrol", "Diesel", "Hybrid", "Electric", "EV"
//     (already applied via `fueltype=` filter — including them here would
//     cause AutoTrader to require the word in the listing description
//     too, which many franchise dealers omit)
// Everything else (model name, trim tier, sport suffix) is kept so
// AutoTrader's fuzzy match can narrow the listings.
// Example: "Tank 300 2.0T Super Luxury Hybrid 4x4 A/T"
//   -> ["Tank", "300", "Super", "Luxury"]
function derivativeKeywords(derivative?: string, model?: string): string[] {
  const der = cleanText(derivative);
  const base = der || cleanText(model);
  if (!base) return [];
  const stripPatterns: RegExp[] = [
    /^\d+\.\d+[a-z]*$/i,                       // 2.0T, 3.0, 1.5, 1.6D, 2.2di
    /^4x4$|^4wd$|^awd$|^rwd$|^fwd$|^2wd$/i,    // drivetrain
    /^tdi$|^tsi$|^gdi$|^crdi$|^bluetec$|^ecoboost$/i, // engine tech
    /^a\/t$|^m\/t$|^at$|^mt$|^dct$|^dsg$|^cvt$|^amt$|^dctm$|^tiptronic$|^s-?tronic$|^pdk$/i, // transmission
    /^petrol$|^gasoline$|^diesel$|^hybrid$|^electric$|^ev$|^lpg$|^hydrogen$/i, // fuel (already a filter)
  ];
  return base
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t && !stripPatterns.some((re) => re.test(t)));
}

// Build the AutoTrader `keyword=` query value — a space-separated list
// of the filtered derivative tokens.
function searchKeyword(model?: string, derivative?: string): string {
  return derivativeKeywords(derivative, model).join(" ");
}

// Resolve the year range to feed into AutoTrader's `year=X-to-Y` filter.
// Uses the Kredo variant manufacture range when available (so the search
// covers the whole production run of that derivative, matching the
// verification we already do on year-registered vs year-manufactured),
// otherwise falls back to the single `year` prop.
function resolveYearRange(p: Props): { from: number; to: number } | null {
  const from = p.yearFrom != null ? Number(p.yearFrom) : null;
  const to = p.yearTo != null ? Number(p.yearTo) : null;
  if (from && to && from <= to) return { from, to };
  if (from) return { from, to: from };
  if (to) return { from: to, to };
  if (p.year) return { from: Number(p.year), to: Number(p.year) };
  return null;
}

// Normalise fuel type to the exact value AutoTrader expects on their
// URL filter. Known values: Petrol, Diesel, Hybrid, Electric, LPG,
// Hydrogen. Anything unrecognised is passed through Title-Cased.
function normaliseFuel(raw?: string | null): string | null {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  const map: Record<string, string> = {
    petrol: "Petrol",
    gasoline: "Petrol",
    diesel: "Diesel",
    hybrid: "Hybrid",
    "petrol hybrid": "Hybrid",
    "diesel hybrid": "Hybrid",
    "plug-in hybrid": "Hybrid",
    "plug in hybrid": "Hybrid",
    electric: "Electric",
    ev: "Electric",
    lpg: "LPG",
    hydrogen: "Hydrogen",
  };
  return map[s] ?? (s.charAt(0).toUpperCase() + s.slice(1));
}

// Normalise transmission to AutoTrader's exact filter value. Everything
// non-manual maps to "Automatic" (Kredo returns "Automatic" for every
// auto-family box — DCT, DSG, CVT, AMT etc. — so this mostly passes
// through, but we defensively bucket common synonyms).
function normaliseTransmission(raw?: string | null): string | null {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (s === "manual" || s === "m/t" || s === "mt") return "Manual";
  return "Automatic";
}

// AutoTrader.co.za deep link: land on the make page (which is guaranteed
// to exist on their catalogue for every brand) with year + fuel +
// transmission filters applied, and each derivative token as its own
// `keyword=` pill so AutoTrader AND-matches them individually (as seen
// in their Filter Search UI where each pill narrows results further).
// We also pre-apply `dealerrating=3` so buyers only see listings from
// dealers with an AutoTrader star rating of 3 or more — protects the
// dealer from time-wasters and low-quality sellers when comparing
// against a valuation.
//   /cars-for-sale/gwm?keyword=Tank&keyword=300&keyword=Super
//     &keyword=Luxury&year=2024-to-2026&fueltype=Hybrid
//     &transmission=Automatic&dealerrating=3
function buildAutoTraderUrl(p: Props): string | null {
  const make = cleanText(p.make);
  if (!make) return null;
  const kws = derivativeKeywords(p.derivative, p.model);
  const range = resolveYearRange(p);
  const fuel = normaliseFuel(p.fuelType);
  const trans = normaliseTransmission(p.transmission);
  const qs = new URLSearchParams();
  // One separate `keyword=` entry per token — AutoTrader treats each as
  // an individual filter pill rather than one long phrase.
  for (const k of kws) qs.append("keyword", k);
  if (range) qs.set("year", `${range.from}-to-${range.to}`);
  if (fuel) qs.set("fueltype", fuel);
  if (trans) qs.set("transmission", trans);
  // Dealer Rating filter — AutoTrader exposes this as the lowercase
  // `dealerrating` query key (values 1..4). We always pin it to 3+ so
  // dealers using Fourbuy never end up comparing their guaranteed
  // Cover Price against listings from low-rated sellers.
  qs.set("dealerrating", "3");
  const suffix = qs.toString();
  return `https://www.autotrader.co.za/cars-for-sale/${slugAT(make)}${suffix ? `?${suffix}` : ""}`;
}

function searchLabel(p: Props): string {
  const make = cleanText(p.make);
  const kw = searchKeyword(p.model, p.derivative);
  return [make, kw].filter(Boolean).join(" ");
}

async function open(url: string) {
  try {
    // On web, open in a new tab so we don't lose the valuation context.
    // On native, expo-linking / Linking.openURL launches the system browser.
    if (Platform.OS === "web") {
      const w = (globalThis as unknown as { window?: Window }).window;
      if (w && typeof w.open === "function") {
        w.open(url, "_blank", "noopener,noreferrer");
        return;
      }
    }
    await Linking.openURL(url);
  } catch {
    // no-op — surface via a toast in a future iteration if needed
  }
}

export default function ComparableListingsCard(props: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const autoTrader = useMemo(() => buildAutoTraderUrl(props), [props]);
  if (!autoTrader) return null;

  const range = resolveYearRange(props);
  const yearStr = range
    ? range.from === range.to
      ? String(range.from)
      : `${range.from} – ${range.to}`
    : "any year";
  const searchLbl = searchLabel(props);
  const fuel = normaliseFuel(props.fuelType);
  const trans = normaliseTransmission(props.transmission);

  // Compact "chips" that describe what's pre-applied. Each derivative
  // keyword becomes its own chip so dealers can see exactly which words
  // are being searched — e.g. Tank · 300 · Super · Luxury.
  const kwTokens = derivativeKeywords(props.derivative, props.model);
  const chips: string[] = [...kwTokens];
  if (range) chips.push(range.from === range.to ? `${range.from}` : `${range.from}–${range.to}`);
  if (fuel) chips.push(fuel);
  if (trans) chips.push(trans);
  // Every generated URL pins `dealerrating=3` so buyers only see listings
  // from AutoTrader-rated 3-star-plus dealers — surface it as a chip so
  // dealers know why some listings won't appear.
  chips.push("3★+ dealers");

  return (
    <View style={styles.card}>
      {/* Header now leads with the actual AutoTrader logo (chipped in a
          white rounded badge for contrast on the dark card) and the
          brand-specific title so the two comparison cards read as
          equal, brand-native destinations. */}
      <View style={styles.headerRow}>
        <View style={styles.headerLogoBadge}>
          <Image source={AUTOTRADER_LOGO} style={styles.headerLogoImg} resizeMode="contain" />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title}>Compare on AutoTrader</Text>
          <Text style={styles.subtitle}>autotrader.co.za · reputable 3★+ dealers</Text>
        </View>
      </View>
      <Text style={styles.help}>
        Opens live listings for{" "}
        <Text style={{ fontWeight: "700", color: colors.text }}>{searchLbl}</Text>
        {range ? (
          <>
            {" "}across the full model run{" "}
            <Text style={{ fontWeight: "700", color: colors.text }}>({yearStr})</Text>
          </>
        ) : null}
        {fuel ? (
          <>
            {" "}running on <Text style={{ fontWeight: "700", color: colors.text }}>{fuel}</Text>
          </>
        ) : null}
        {trans ? (
          <>
            {" "}with <Text style={{ fontWeight: "700", color: colors.text }}>{trans}</Text> transmission
          </>
        ) : null}
        , so you can eyeball the cheapest live example on the market.
      </Text>

      {chips.length ? (
        <View style={styles.chipRow}>
          {chips.map((c) => (
            <View key={c} style={styles.chip}>
              <Text style={styles.chipTxt}>{c}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <TouchableOpacity
        testID="open-autotrader"
        style={styles.actionBtn}
        onPress={() => open(autoTrader)}
        accessibilityRole="link"
        accessibilityLabel="Open comparable listings on AutoTrader.co.za"
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.btnTitle}>Open AutoTrader.co.za</Text>
          <Text style={styles.btnSub} numberOfLines={2}>
            {[
              kwTokens.length ? kwTokens.join(" · ") : null,
              range ? (range.from === range.to ? `Year ${range.from}` : `Years ${range.from}–${range.to}`) : null,
              fuel,
              trans,
            ].filter(Boolean).join(" · ") || "Model listing"}
          </Text>
        </View>
        <Ionicons name="open-outline" size={18} color={colors.primary} />
      </TouchableOpacity>

      <Text style={styles.disclaimer}>
        Tip: AutoTrader listings on this deep link come from reputable
        franchise and dealer partners rated 3★ or higher — vehicles are
        typically reconditioned and warrantied. Cheapest example gives
        you a solid retail benchmark.
      </Text>
    </View>
  );
}

function makeStyles(colors: Palette) {
  return StyleSheet.create({
    card: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.lg,
      backgroundColor: colors.paper,
      padding: spacing.md,
      gap: 8,
      marginTop: spacing.sm,
      // Full-height so a sibling card in a 2-column row lines up
      // exactly regardless of internal content length. `minWidth`
      // large enough that on phones the wrapper's flexWrap kicks in
      // and the two cards stack vertically instead of squeezing.
      flex: 1,
      minWidth: 300,
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      marginBottom: 2,
    },
    // White rounded badge that frames the AutoTrader logo so the mark
    // reads at any surface colour. Same pattern used on the sibling
    // WeBuyCars card so both cards feel visually equal.
    headerLogoBadge: {
      width: 40,
      height: 40,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "#fff",
      padding: 4,
      overflow: "hidden",
    },
    headerLogoImg: { width: "100%", height: "100%" },
    title: { ...fonts.h1, color: colors.text, fontSize: 15, fontWeight: "800" as any },
    subtitle: {
      color: colors.textSecondary,
      fontSize: 11,
      fontWeight: "600",
      marginTop: 1,
    },
    help: { color: colors.textSecondary, fontSize: 12, lineHeight: 17 },

    chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
    chip: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
    },
    chipTxt: { color: colors.text, fontSize: 11, fontWeight: "700", letterSpacing: 0.4 },

    actionBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: spacing.md,
      paddingVertical: 12,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      marginTop: 4,
    },
    badge: {
      width: 32, height: 32,
      borderRadius: 6,
      alignItems: "center", justifyContent: "center",
    },
    badgeText: { color: "#fff", fontSize: 13, fontWeight: "800", letterSpacing: 1 },
    logoBadge: {
      width: 40, height: 40,
      borderRadius: 8,
      alignItems: "center", justifyContent: "center",
      backgroundColor: "#fff",
      padding: 4,
      overflow: "hidden",
    },
    logoImg: { width: "100%", height: "100%" },
    btnTitle: { color: colors.text, fontSize: 14, fontWeight: "700" },
    btnSub: { color: colors.textSecondary, fontSize: 11, marginTop: 2 },

    disclaimer: {
      color: colors.textSecondary,
      fontSize: 11,
      fontStyle: "italic",
      marginTop: 4,
    },
  });
}
