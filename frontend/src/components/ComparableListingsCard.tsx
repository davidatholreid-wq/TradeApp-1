// -----------------------------------------------------------------------------
// ComparableListingsCard — deep-links dealers/admins into AutoTrader.co.za
// and cars.co.za search results pre-filtered to comparable stock (same
// make / model / year and a sensible mileage band around this car). We
// don't scrape or store anything — we simply hand off to the live sites
// so users can eyeball the cheapest example on the market for context
// during the valuation.
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
// (F10)" or "M5 M-DCT (F90)" that don't match AutoTrader / cars.co.za
// search catalogues. Strip anything in parentheses (chassis codes) and
// any trailing punctuation.
function cleanText(s?: string): string {
  return (s || "").replace(/\([^)]*\)/g, "").replace(/\s{2,}/g, " ").trim();
}

// Extract the most specific "model designator" for AutoTrader / cars.co.za
// URL paths. AutoTrader indexes M-cars, AMG cars, RS cars etc. as their
// own model (`/cars-for-sale/bmw/m5`, `/mercedes-benz/c63`, `/audi/rs3`),
// so using the first word of the Kredo derivative works well for those.
// BUT for cars where the derivative starts with an engine size (e.g.
// "2.8 GD-6 Legend RS 4x4" for a Toyota Hilux) that first word is
// meaningless as a URL segment. Only use the derivative firstword when
// it starts with a letter — otherwise fall back to the cleaned Kredo
// model name.
function bestModelDesignator(model?: string, derivative?: string): string {
  const der = cleanText(derivative);
  if (der) {
    const first = der.split(/\s+/)[0];
    if (first && /^[A-Za-z]/.test(first)) {
      return first;
    }
  }
  return cleanText(model);
}

// Slugify for AutoTrader path segments: lowercase, hyphenated, URL-safe.
function slugAT(s: string): string {
  return encodeURIComponent(
    s.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
  );
}

// PascalCase-ish for cars.co.za path segments (they keep the site's case).
function slugCarsCoZa(s: string): string {
  return encodeURIComponent(s.trim().replace(/\s+/g, "-"));
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

// AutoTrader.co.za: path + `-to-` year filter format.
//   /cars-for-sale/bmw/m5?year=2018-to-2020
function buildAutoTraderUrl(p: Props): string | null {
  const make = cleanText(p.make);
  const modelToken = bestModelDesignator(p.model, p.derivative);
  if (!make || !modelToken) return null;
  const range = resolveYearRange(p);
  const qs = new URLSearchParams();
  if (range) qs.set("year", `${range.from}-to-${range.to}`);
  const suffix = qs.toString();
  return `https://www.autotrader.co.za/cars-for-sale/${slugAT(make)}/${slugAT(modelToken)}${suffix ? `?${suffix}` : ""}`;
}

// cars.co.za: path-based search under /usedcars/{Make}/{Model}/. Their
// year query-string params aren't publicly documented, so we only
// pre-fill make + model and the user tunes year on-site.
//   /usedcars/BMW/M5/
function buildCarsCoZaUrl(p: Props): string | null {
  const make = cleanText(p.make);
  const modelToken = bestModelDesignator(p.model, p.derivative);
  if (!make || !modelToken) return null;
  return `https://www.cars.co.za/usedcars/${slugCarsCoZa(make)}/${slugCarsCoZa(modelToken)}/`;
}

function searchLabel(p: Props): string {
  const make = cleanText(p.make);
  const modelToken = bestModelDesignator(p.model, p.derivative);
  return [make, modelToken].filter(Boolean).join(" ");
}

async function open(url: string) {
  try {
    // On web, open in a new tab so we don't lose the valuation context.
    // On native, expo-linking / Linking.openURL launches the system browser.
    if (Platform.OS === "web") {
      // Some environments (e.g. embedded webviews) block window.open, so
      // fall back to Linking which the RN Web polyfill implements safely.
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
  const carsCoZa = useMemo(() => buildCarsCoZaUrl(props), [props]);

  if (!autoTrader && !carsCoZa) return null;

  const range = resolveYearRange(props);
  const yearStr = range
    ? range.from === range.to
      ? String(range.from)
      : `${range.from} – ${range.to}`
    : "any year";
  const searchLbl = searchLabel(props);

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
        , so you can eyeball the cheapest live example on the market.
      </Text>

      <View style={styles.actionsRow}>
        {autoTrader ? (
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
                {range && range.from !== range.to
                  ? `Year range ${range.from}–${range.to} applied`
                  : range
                    ? `Year ${range.from} applied`
                    : "Model listing"}
              </Text>
            </View>
            <Ionicons name="open-outline" size={18} color={colors.text} />
          </TouchableOpacity>
        ) : null}

        {carsCoZa ? (
          <TouchableOpacity
            testID="open-cars-co-za"
            style={styles.actionBtn}
            onPress={() => open(carsCoZa)}
            accessibilityRole="link"
            accessibilityLabel="Open comparable listings on cars.co.za"
          >
            <View style={[styles.badge, { backgroundColor: "#1D3FA5" }]}>
              <Text style={styles.badgeText}>C</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.btnTitle}>cars.co.za</Text>
              <Text style={styles.btnSub}>Model listing (filter year on-site)</Text>
            </View>
            <Ionicons name="open-outline" size={18} color={colors.text} />
          </TouchableOpacity>
        ) : null}
      </View>

      <Text style={styles.disclaimer}>
        Tip: on both sites, filter by &ldquo;Franchise&rdquo; / &ldquo;Dealer&rdquo; and sort by price
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

    actionsRow: { gap: 8, marginTop: 4 },
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
