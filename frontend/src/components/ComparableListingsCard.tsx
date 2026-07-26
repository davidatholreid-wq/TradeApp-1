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
  year?: number | null;
  mileage?: number | null;
};

// Kredo model names carry chassis suffixes like "5 SERIES (F10)" that
// don't match AutoTrader / cars.co.za search catalogues. Strip anything
// in parentheses (chassis code) and any trailing punctuation.
function cleanModel(model?: string): string {
  const s = (model || "").replace(/\([^)]*\)/g, "").replace(/\s{2,}/g, " ").trim();
  return s;
}

// Mileage search band = ±20% around this car (rounded to nearest 5 000 km).
// Falls back to a sensible open-ended band if mileage is missing.
function mileageBand(mileageKm?: number | null): { low: number; high: number } {
  const m = Number(mileageKm || 0);
  if (!m || m <= 0) return { low: 0, high: 300000 };
  const round5 = (n: number) => Math.max(0, Math.round(n / 5000) * 5000);
  return { low: round5(m * 0.8), high: round5(m * 1.2) };
}

// AutoTrader.co.za uses SEO-friendly path segments for make/model + query
// params for year / mileage bands.
//   /cars-for-sale/BMW/5-SERIES?year=2019-2019&mileage=100000-160000
function buildAutoTraderUrl(p: Props): string | null {
  const model = cleanModel(p.model);
  if (!p.make || !model) return null;
  const slug = (s: string) => encodeURIComponent(s.trim().replace(/\s+/g, "-"));
  const { low, high } = mileageBand(p.mileage);
  const year = p.year;
  const qs = new URLSearchParams();
  if (year) qs.set("year", `${year}-${year}`);
  qs.set("mileage", `${low}-${high}`);
  return `https://www.autotrader.co.za/cars-for-sale/${slug(p.make)}/${slug(model)}?${qs.toString()}`;
}

// cars.co.za uses PascalCase query params on /carsforsale/.
//   /carsforsale/?Manufacturer=BMW&Model=5+SERIES
//     &YearRange.From=2019&YearRange.To=2019
//     &KilometreRange.From=100000&KilometreRange.To=160000
function buildCarsCoZaUrl(p: Props): string | null {
  const model = cleanModel(p.model);
  if (!p.make || !model) return null;
  const { low, high } = mileageBand(p.mileage);
  const qs = new URLSearchParams();
  qs.set("Manufacturer", p.make);
  qs.set("Model", model);
  if (p.year) {
    qs.set("YearRange.From", String(p.year));
    qs.set("YearRange.To", String(p.year));
  }
  qs.set("KilometreRange.From", String(low));
  qs.set("KilometreRange.To", String(high));
  return `https://www.cars.co.za/carsforsale/?${qs.toString()}`;
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

  const { low, high } = mileageBand(props.mileage);
  const yearStr = props.year ? String(props.year) : "Any year";
  const mileageStr = `${low.toLocaleString()} – ${high.toLocaleString()} km`;
  const modelLabel = cleanModel(props.model) || props.model || "";

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Ionicons name="pricetags" size={16} color={colors.primary} />
        <Text style={styles.title}>Compare Live Listings</Text>
      </View>
      <Text style={styles.help}>
        Opens {props.make} {modelLabel} listings pre-filtered to {yearStr} and
        similar mileage ({mileageStr}) so you can eyeball the cheapest live
        example on the market.
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
              <Text style={styles.btnSub}>See live matching listings</Text>
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
              <Text style={styles.btnSub}>See live matching listings</Text>
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
