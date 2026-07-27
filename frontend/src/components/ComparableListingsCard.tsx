// -----------------------------------------------------------------------------
// ComparableListingsCard — deep-links dealers/admins into AutoTrader.co.za
// search results pre-filtered to comparable stock (same make + model,
// full manufacture-year run of that derivative, and matching fuel type).
// We don't scrape or store anything — we simply hand off to the live
// site so users can eyeball the cheapest example on the market for
// context during the valuation.
// -----------------------------------------------------------------------------
import { useMemo } from "react";
import { View, Text, StyleSheet, Linking, Platform } from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";

type Props = {
  make?: string;
  model?: string;
  derivative?: string;
  /** Fuel type from the submission (e.g. "Petrol", "Diesel", "Hybrid",
   *  "Electric"). Applied as an AutoTrader filter when present. */
  fuelType?: string | null;
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

// Build the free-text keyword to place into AutoTrader's search box.
// Uses the derivative (which is already specific enough — e.g. "M5
// M-DCT", "Tank 300 2.0T", "C63 AMG"). Falls back to model when there
// is no derivative on file. We deliberately keep this short so
// AutoTrader's fuzzy match still finds listings.
function searchKeyword(model?: string, derivative?: string): string {
  const der = cleanText(derivative);
  if (der) return der;
  return cleanText(model);
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

// AutoTrader.co.za deep link: land on the make page (which is guaranteed
// to exist on their catalogue for every brand) with year + fuel filters
// applied, and put the model/derivative into a `keyword` search param so
// AutoTrader's own free-text search narrows to the specific submodel
// (e.g. GWM Tank 300 vs Tank 500). If `keyword` is ignored the user is
// still on the correctly-filtered make landing page.
//   /cars-for-sale/gwm?keyword=Tank+300&year=2023-to-2024&fueltype=Petrol
function buildAutoTraderUrl(p: Props): string | null {
  const make = cleanText(p.make);
  if (!make) return null;
  const keyword = searchKeyword(p.model, p.derivative);
  const range = resolveYearRange(p);
  const fuel = normaliseFuel(p.fuelType);
  const qs = new URLSearchParams();
  if (keyword) qs.set("keyword", keyword);
  if (range) qs.set("year", `${range.from}-to-${range.to}`);
  if (fuel) qs.set("fueltype", fuel);
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

  // Compact "chips" that describe what filters we've pre-applied.
  const chips: string[] = [];
  const kw = searchKeyword(props.model, props.derivative);
  if (kw) chips.push(`"${kw}"`);
  if (range) chips.push(range.from === range.to ? `Year ${range.from}` : `Years ${range.from}–${range.to}`);
  if (fuel) chips.push(fuel);

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Ionicons name="pricetags" size={16} color={colors.primary} />
        <Text style={styles.title}>Compare Live Listings</Text>
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
        <View style={[styles.badge, { backgroundColor: "#E31C24" }]}>
          <Text style={styles.badgeText}>AT</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.btnTitle}>AutoTrader.co.za</Text>
          <Text style={styles.btnSub}>
            {chips.length ? chips.join(" · ") + " applied" : "Model listing"}
          </Text>
        </View>
        <Ionicons name="open-outline" size={18} color={colors.text} />
      </TouchableOpacity>

      <Text style={styles.disclaimer}>
        Tip: on AutoTrader, filter by &ldquo;Franchise&rdquo; / &ldquo;Dealer&rdquo; and sort by price
        (low → high) to find the cheapest comparable example.
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
    },
    headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    title: { ...fonts.h1, color: colors.text, fontSize: 16 },
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
