// -----------------------------------------------------------------------------
// WeBuyCarsListingsCard — deep-links dealers/admins into webuycars.co.za
// search results pre-filtered to comparable stock (same make + model,
// optional derivative keyword and year range).
//
// WeBuyCars uses a JSON-array style query param format:
//   /buy-a-car?Make=["Toyota"]&Model=["Corolla"]&Year=[2020]
//
// We don't scrape or store anything — we simply hand off to the live
// site so users can eyeball how many equivalent cars WeBuyCars is
// currently listing for retail, and at what price. Useful as a
// cross-reference next to the AutoTrader deep-link.
// -----------------------------------------------------------------------------
import { useMemo, useState, useEffect } from "react";
import { View, Text, StyleSheet, Linking, Platform, Image, TextInput, ScrollView } from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import {
  WEBUYCARS_MAKES,
  WEBUYCARS_CATALOGUE,
  resolveWbcMake,
  guessWbcModel,
} from "@/src/data/webuycarsCatalogue";

// Brand logo image bundled with the app. Kept in assets/images/logos
// so it ships with the JS bundle (no network round-trip needed).
const WEBUYCARS_LOGO = require("@/assets/images/logos/webuycars.png");

type Props = {
  make?: string;
  model?: string;
  derivative?: string;
  /** Fuel type from the submission (e.g. "Petrol", "Diesel", "Hybrid",
   *  "Electric"). Applied as a WeBuyCars `FuelType=["…"]` filter when
   *  present so the listing wall only shows matching fuel families. */
  fuelType?: string | null;
  /** Transmission from the submission (e.g. "Automatic", "Manual").
   *  Applied as a WeBuyCars `Transmission=["…"]` filter. */
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
// (F10)" that don't match WeBuyCars' catalogue. Strip anything in
// parentheses and any trailing punctuation.
function cleanText(s?: string): string {
  return (s || "").replace(/\([^)]*\)/g, "").replace(/\s{2,}/g, " ").trim();
}

// WeBuyCars canonicalises makes in Title Case (Toyota, Volkswagen,
// Mercedes-Benz, Land Rover). Kredo often returns them ALL-CAPS. We
// Title-Case the make so the URL filter resolves to the correct brand
// in their catalogue.
function toTitleCase(s: string): string {
  return s
    .split(/(\s|-)/)
    .map((part) =>
      part.length > 1
        ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
        : part
    )
    .join("");
}

// WeBuyCars-specific make normalisation. A few brands are stored with
// non-obvious canonical names on their site (BMW / VW / MINI stay
// uppercase; Land Rover / Mercedes-Benz keep the hyphen; etc.).
function normaliseMake(raw?: string): string | null {
  if (!raw) return null;
  const cleaned = cleanText(raw);
  if (!cleaned) return null;
  const upper = cleaned.toUpperCase();
  // Preserve initialisms that WeBuyCars keeps uppercase.
  const upperSet = new Set([
    "BMW", "VW", "MINI", "GWM", "SEAT", "MG", "JMC", "FAW",
    "DFSK", "GAC", "BAIC", "JAC", "TATA", "UD", "MAN",
  ]);
  if (upperSet.has(upper)) return upper;
  // "VOLKSWAGEN" → "Volkswagen"; "MERCEDES-BENZ" → "Mercedes-Benz".
  return toTitleCase(cleaned);
}

// Model / derivative Title Case. WeBuyCars models are Title-Cased in
// their nav ("Corolla Cross", "Ranger", "3 Series") so match that.
// Kept as a helper for future re-use; the current build path routes
// through `deriveModelKeyword` (which also handles chassis-code /
// grouped-family cleanup) instead.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function normaliseModel(raw?: string): string | null {
  if (!raw) return null;
  const cleaned = cleanText(raw);
  if (!cleaned) return null;
  return toTitleCase(cleaned);
}

// Derive the best WeBuyCars-friendly model keyword from BOTH the Kredo
// `model_name` and `derivative_name` fields.
//
// Kredo `model_name` sometimes contains junk that breaks WeBuyCars'
// catalogue match — chassis codes after a `/` (`DEFENDER / PUMA 90`),
// generation labels (`5 SERIES (F10)`), or grouped families
// (`DISCOVERY 3 / 4`).
//
// The `derivative_name` on the other hand almost always LEADS with the
// clean marketing name — `DEFENDER 90 D240 SE X-DYNAMIC (177KW)`,
// `DISCOVERY 3.0 TD6 SE`, `M5 M-DCT (F90)`. We grab the first 1–2 name
// tokens off the derivative (skipping engine-displacement / spec
// tokens) and fall back to the raw model when the derivative can't be
// parsed. This gives WeBuyCars a clean, catalogue-matching model
// filter for tricky brands (Land Rover, BMW etc.).
function deriveModelKeyword(model?: string, derivative?: string): string | null {
  const src = cleanText(derivative);
  if (src) {
    const tokens = src.split(/\s+/);
    // Regex catch-alls for tokens we always want to drop:
    //   engine displacement: 3.0, 2.2D, 1.5T, 2.0Tdi
    //   drivetrain: 4x4, 4WD, AWD, RWD, FWD, 2WD
    //   transmission: A/T, M/T, DSG, DCT, CVT, PDK
    //   engine tech: TDI, TSI, GDI, ECOBOOST, BLUETEC, TDCI
    //   trim / spec keywords (kept OUT of the model filter since WBC
    //   uses these on their variant/description search, not model)
    const stripRe = /^(\d+\.\d+[a-z]*|4x4|4wd|awd|rwd|fwd|2wd|tdi|tsi|gdi|tdci|bluetec|ecoboost|crdi|a\/t|m\/t|at|mt|dct|dsg|cvt|amt|pdk|m-dct|s-tronic|tiptronic|steptronic|dsg7|dct7|dct8)$/i;
    const picked: string[] = [];
    for (const raw of tokens) {
      const t = raw.replace(/[,()]/g, "").trim();
      if (!t) continue;
      if (stripRe.test(t)) break; // we've hit the "spec" side of the derivative
      picked.push(t);
      if (picked.length >= 2) break; // two words is enough — "Defender 90", "5 Series", etc.
    }
    if (picked.length > 0) return toTitleCase(picked.join(" "));
  }
  // Fallback — clean the raw model_name (strip after `/`, strip parens).
  const modelClean = cleanText(model || "");
  if (!modelClean) return null;
  const firstHalf = modelClean.split("/")[0].trim();
  return toTitleCase(firstHalf || modelClean);
}

// Resolve the year range to feed into WeBuyCars' Year=[a,b,c] filter.
// Uses the Kredo variant manufacture range when available; otherwise
// falls back to the single production year.
function resolveYearRange(p: Props): { from: number; to: number } | null {
  const from = p.yearFrom != null ? Number(p.yearFrom) : null;
  const to = p.yearTo != null ? Number(p.yearTo) : null;
  if (from && to && from <= to) return { from, to };
  if (from) return { from, to: from };
  if (to) return { from: to, to };
  if (p.year) return { from: Number(p.year), to: Number(p.year) };
  return null;
}

// Same as resolveYearRange but with WeBuyCars' clamps applied — the
// max-span guard AND the "no future years" cap. Used for both the URL
// build and the on-screen chips/help copy so what the dealer sees on
// the card matches what the WBC UI ends up showing.
function resolveEffectiveRange(p: Props): { from: number; to: number } | null {
  const range = resolveYearRange(p);
  if (!range) return null;
  let { from, to } = range;
  if (to - from > MAX_YEAR_SPAN) from = to - MAX_YEAR_SPAN;
  const thisYear = new Date().getFullYear();
  if (to > thisYear) to = thisYear;
  if (from > to) from = to;
  return { from, to };
}

// Cap the number of years we send to WeBuyCars — we now send a min/max
// tuple (Year=[min, max]) so this only ever guards against pathological
// Kredo ranges. Anything wider than this gets clipped down to keep the
// search focused on the derivative's actual production window.
const MAX_YEAR_SPAN = 15;

// Normalise transmission to WeBuyCars' canonical vocabulary. Their
// filter pill labels use Title Case: "Automatic", "Manual". Kredo
// returns any auto-family box (DCT / DSG / CVT / AMT / PDK / Tiptronic
// etc.) as "Automatic" so most inputs pass through untouched — we
// still defensively bucket the common synonyms.
function normaliseTransmission(raw?: string | null): string | null {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (s === "manual" || s === "m/t" || s === "mt") return "Manual";
  return "Automatic";
}

// Normalise fuel type to WeBuyCars' canonical vocabulary. Their filter
// pill labels use Title Case: "Petrol", "Diesel", "Hybrid", "Electric".
// Kredo returns e.g. "PETROL" / "PETROL/HYBRID" so we bucket variants
// down to the parent family they display on the site.
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
    "petrol/hybrid": "Hybrid",
    "diesel hybrid": "Hybrid",
    "diesel/hybrid": "Hybrid",
    "plug-in hybrid": "Hybrid",
    "plug in hybrid": "Hybrid",
    "phev": "Hybrid",
    electric: "Electric",
    ev: "Electric",
    bev: "Electric",
    lpg: "LPG",
    hydrogen: "Hydrogen",
  };
  return map[s] ?? (s.charAt(0).toUpperCase() + s.slice(1));
}

// WeBuyCars encodes list-value query params as a bracketed JSON-style
// array (e.g. `Make=["Toyota"]`). We build that string manually since
// URLSearchParams would percent-encode the outer brackets.
function jsonArrayParam(values: (string | number)[]): string {
  const items = values.map((v) =>
    typeof v === "number" ? String(v) : `"${String(v).replace(/"/g, '\\"')}"`
  );
  return `[${items.join(",")}]`;
}

// Build the WeBuyCars.co.za deep link. Filters applied when available:
//   Make         — JSON-array with the Title-Cased brand name
//   Model        — JSON-array with the Title-Cased model
//   Year         — Emitted twice for maximum compatibility:
//                    Year=[min,max]          — populates the chip bar
//                    Year_Gte=X & Year_Lte=Y — populates the sidebar
//                                              min/max slider state
//                  Also clamps the max to the current calendar year
//                  because WeBuyCars only stocks in-market cars, so
//                  asking for e.g. 2025 while it's still 2024 leaves
//                  the sidebar badge showing "null - 2024" and the
//                  dealer wondering what happened.
//   FuelType     — JSON-array with the canonical fuel family
//   Gearbox      — JSON-array with "Automatic" or "Manual"
//                  (WeBuyCars labels their transmission filter panel
//                  "Gearbox" — sending it as `Transmission=[…]` is a
//                  silent no-op).
//   SortBy/Order — Price_Amount ASC (cheapest first)
//
// Example (Toyota Corolla Cross 2022–2026 Hybrid Automatic, today=2024):
//   /buy-a-car?Make=["Toyota"]&Model=["Corolla Cross"]
//     &Year=[2022,2024]&Year_Gte=2022&Year_Lte=2024
//     &FuelType=["Hybrid"]&Gearbox=["Automatic"]
//     &SortBy=Price_Amount&SortOrder=ASC
function buildWeBuyCarsUrl(
  p: Props,
  overrides?: { make?: string | null; model?: string | null },
): string | null {
  const make = overrides?.make || normaliseMake(p.make);
  if (!make) return null;
  const model =
    overrides?.model !== undefined
      ? overrides.model
      : deriveModelKeyword(p.model, p.derivative);
  const range = resolveEffectiveRange(p);
  const fuel = normaliseFuel(p.fuelType);
  const trans = normaliseTransmission(p.transmission);

  const parts: string[] = [];
  parts.push(`Make=${encodeURIComponent(jsonArrayParam([make]))}`);
  if (model) {
    parts.push(`Model=${encodeURIComponent(jsonArrayParam([model]))}`);
  }
  if (range) {
    const { from, to } = range;
    // Emit BOTH the array (drives the chip bar) AND the Gte/Lte pair
    // (drives the sidebar slider state) so both UIs agree.
    parts.push(`Year=${encodeURIComponent(jsonArrayParam([from, to]))}`);
    parts.push(`Year_Gte=${from}`);
    parts.push(`Year_Lte=${to}`);
  }
  if (fuel) {
    parts.push(`FuelType=${encodeURIComponent(jsonArrayParam([fuel]))}`);
  }
  if (trans) {
    // WeBuyCars calls their transmission filter "Gearbox" on both the
    // sidebar panel AND the query-string key. Using `Transmission` is
    // a silent no-op.
    parts.push(`Gearbox=${encodeURIComponent(jsonArrayParam([trans]))}`);
  }
  // Sort by price ascending — cheapest first, matching what the dealer
  // wants to spot when comparing against a cover offer.
  parts.push("SortBy=Price_Amount");
  parts.push("SortOrder=ASC");

  return `https://www.webuycars.co.za/buy-a-car?${parts.join("&")}`;
}

async function open(url: string) {
  try {
    if (Platform.OS === "web") {
      const w = (globalThis as unknown as { window?: Window }).window;
      if (w && typeof w.open === "function") {
        w.open(url, "_blank", "noopener,noreferrer");
        return;
      }
    }
    await Linking.openURL(url);
  } catch {
    /* no-op */
  }
}

export default function WeBuyCarsListingsCard(props: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  // Auto-derive the initial WBC make/model from Kredo data, then let
  // the dealer pin the model via a dropdown. WBC's catalogue naming
  // often differs from Kredo (e.g. Kredo `DEFENDER / PUMA 90` vs
  // WBC `Defender 90`), and the dropdown ensures we send the exact
  // string WBC expects. If the make isn't in our curated list we
  // silently fall back to the auto-derived keyword (no dropdown).
  const wbcMakeResolved = useMemo(
    () => resolveWbcMake(props.make),
    [props.make],
  );
  const catalogueModels = useMemo(
    () => (wbcMakeResolved ? WEBUYCARS_CATALOGUE[wbcMakeResolved] : null),
    [wbcMakeResolved],
  );
  const initialGuess = useMemo(() => {
    if (!wbcMakeResolved) return "";
    const kw = deriveModelKeyword(props.model, props.derivative);
    return guessWbcModel(wbcMakeResolved, kw) ?? "";
  }, [wbcMakeResolved, props.model, props.derivative]);

  // Selected WBC model (either the auto-guess or a dealer pick).
  const [selectedModel, setSelectedModel] = useState<string>(initialGuess);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");

  // Refresh the selection if the underlying vehicle changes (e.g. the
  // parent screen navigates between subs without unmounting this card).
  useEffect(() => {
    setSelectedModel(initialGuess);
    setSearch("");
  }, [initialGuess]);

  const filteredModels = useMemo(() => {
    if (!catalogueModels) return [];
    if (!search.trim()) return catalogueModels;
    const q = search.trim().toLowerCase();
    return catalogueModels.filter((m) => m.toLowerCase().includes(q));
  }, [catalogueModels, search]);

  const effectiveMake =
    wbcMakeResolved || normaliseMake(props.make) || "";
  const effectiveModel = wbcMakeResolved
    ? selectedModel
    : deriveModelKeyword(props.model, props.derivative) || "";

  const url = useMemo(
    () =>
      buildWeBuyCarsUrl(props, {
        make: effectiveMake,
        model: effectiveModel || null,
      }),
    [props, effectiveMake, effectiveModel],
  );
  if (!url) return null;

  const range = resolveEffectiveRange(props);
  const yearStr = range
    ? range.from === range.to
      ? String(range.from)
      : `${range.from} – ${range.to}`
    : null;
  const fuel = normaliseFuel(props.fuelType);
  const trans = normaliseTransmission(props.transmission);

  const chips: string[] = [];
  if (effectiveMake) chips.push(effectiveMake);
  if (effectiveModel) chips.push(effectiveModel);
  if (yearStr) chips.push(yearStr);
  if (fuel) chips.push(fuel);
  if (trans) chips.push(trans);
  chips.push("Cheapest first");

  return (
    <View style={styles.card}>
      {/* Same header treatment as the AutoTrader card — logo chip on the
          left, brand-specific title + hostname subtitle so the two
          comparison sections feel like matching destinations. */}
      <View style={styles.headerRow}>
        <View style={styles.headerLogoBadge}>
          <Image source={WEBUYCARS_LOGO} style={styles.headerLogoImg} resizeMode="contain" />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title}>Compare on WeBuyCars</Text>
          <Text style={styles.subtitle}>webuycars.co.za · wholesale / trade reference</Text>
        </View>
      </View>
      <Text style={styles.help}>
        Opens the live listing wall on{" "}
        <Text style={{ fontWeight: "700", color: colors.text }}>WeBuyCars.co.za</Text>
        {" "}for{" "}
        <Text style={{ fontWeight: "700", color: colors.text }}>
          {[effectiveMake, effectiveModel].filter(Boolean).join(" ") || "matching stock"}
        </Text>
        {yearStr ? (
          <>
            {" "}across the model run{" "}
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
        , sorted cheapest first so you can benchmark the retail floor.
      </Text>

      {/* WBC-catalogue model picker — visible only when the make is in
          our curated top-30 SA brand list. Otherwise we fall back
          silently to the auto-derived keyword (kept invisible to
          avoid clutter). */}
      {catalogueModels ? (
        <View style={styles.pickerBlock}>
          <View style={styles.pickerHeader}>
            <Text style={styles.pickerLabel}>WBC Model</Text>
            <Text style={styles.pickerHint}>
              {WEBUYCARS_MAKES.includes(effectiveMake) ? effectiveMake : "—"}
            </Text>
          </View>
          <TouchableOpacity
            testID="wbc-model-picker"
            style={styles.pickerButton}
            onPress={() => setPickerOpen((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel="Change WeBuyCars model"
          >
            <Text style={styles.pickerButtonText} numberOfLines={1}>
              {selectedModel || "Pick a model…"}
            </Text>
            <Ionicons
              name={pickerOpen ? "chevron-up" : "chevron-down"}
              size={16}
              color={colors.textSecondary}
            />
          </TouchableOpacity>
          {pickerOpen ? (
            <View style={styles.pickerDropdown}>
              <View style={styles.pickerSearchRow}>
                <Ionicons name="search" size={14} color={colors.textSecondary} />
                <TextInput
                  testID="wbc-model-search"
                  style={styles.pickerSearchInput}
                  value={search}
                  onChangeText={setSearch}
                  placeholder={`Search ${catalogueModels.length} ${effectiveMake} models…`}
                  placeholderTextColor={colors.textDisabled}
                  autoCorrect={false}
                  autoCapitalize="none"
                />
                {search ? (
                  <TouchableOpacity onPress={() => setSearch("")} accessibilityRole="button">
                    <Ionicons name="close-circle" size={16} color={colors.textSecondary} />
                  </TouchableOpacity>
                ) : null}
              </View>
              <ScrollView
                style={styles.pickerList}
                nestedScrollEnabled
                keyboardShouldPersistTaps="handled"
              >
                {filteredModels.length === 0 ? (
                  <Text style={styles.pickerEmpty}>
                    No matches. Try a broader keyword or clear the search.
                  </Text>
                ) : (
                  filteredModels.map((m) => {
                    const isActive = m === selectedModel;
                    return (
                      <TouchableOpacity
                        key={m}
                        style={[styles.pickerRow, isActive && styles.pickerRowActive]}
                        onPress={() => {
                          setSelectedModel(m);
                          setPickerOpen(false);
                          setSearch("");
                        }}
                        accessibilityRole="button"
                      >
                        <Text
                          style={[
                            styles.pickerRowText,
                            isActive && styles.pickerRowTextActive,
                          ]}
                        >
                          {m}
                        </Text>
                        {isActive ? (
                          <Ionicons name="checkmark" size={16} color={colors.primary} />
                        ) : null}
                      </TouchableOpacity>
                    );
                  })
                )}
              </ScrollView>
            </View>
          ) : null}
        </View>
      ) : null}

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
        testID="open-webuycars"
        style={styles.actionBtn}
        onPress={() => open(url)}
        accessibilityRole="link"
        accessibilityLabel="Open comparable listings on WeBuyCars.co.za"
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.btnTitle}>Open WeBuyCars.co.za</Text>
          <Text style={styles.btnSub} numberOfLines={2}>
            {[
              [effectiveMake, effectiveModel].filter(Boolean).join(" ") || null,
              yearStr,
              fuel,
              trans,
              "Sorted cheapest first",
            ].filter(Boolean).join(" · ")}
          </Text>
        </View>
        <Ionicons name="open-outline" size={18} color={colors.primary} />
      </TouchableOpacity>

      <Text style={styles.disclaimer}>
        Tip: WeBuyCars stock is NOT reconditioned — condition varies from
        one listing to the next. Use it as a wholesale/trade reference,
        and go through each listing carefully before drawing conclusions.
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
      // triggers flex-wrap → stacking on phones.
      flex: 1,
      minWidth: 300,
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      marginBottom: 2,
    },
    // Match the AutoTrader card exactly so the two headers read as
    // equal sibling destinations.
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

    // WBC model picker (dropdown + search).
    pickerBlock: {
      marginTop: 4,
      gap: 6,
      // Web-only: raise the picker's stacking context above the sibling
      // chip row + Open-link card so the dropdown, when opened, cleanly
      // covers anything below it. Without this, RN Web sometimes paints
      // the chip row on top of the dropdown, which manifested as the
      // "compare block overlapping" reported by admin.
      zIndex: 5,
      ...(Platform.OS === "web" ? { position: "relative" as const } : {}),
    },
    pickerHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    pickerLabel: { color: colors.textSecondary, fontSize: 11, letterSpacing: 0.4, fontWeight: "700" },
    pickerHint: { color: colors.textSecondary, fontSize: 11, fontStyle: "italic" },
    pickerButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
    },
    pickerButtonText: { color: colors.text, fontSize: 13, fontWeight: "600", flex: 1, marginRight: 8 },
    pickerDropdown: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      backgroundColor: colors.card,
      overflow: "hidden",
      // Keep the dropdown above sibling content in the same card so
      // long lists never appear behind the chip row / Open-link card.
      zIndex: 6,
      elevation: 4,
    },
    pickerSearchRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    pickerSearchInput: {
      flex: 1,
      color: colors.text,
      fontSize: 12,
      paddingVertical: 2,
      outlineStyle: "none" as any,
    },
    pickerList: { maxHeight: 220 },
    pickerRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 12,
      paddingVertical: 9,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    pickerRowActive: { backgroundColor: colors.primary + "18" },
    pickerRowText: { color: colors.text, fontSize: 12 },
    pickerRowTextActive: { color: colors.primary, fontWeight: "700" },
    pickerEmpty: {
      color: colors.textSecondary,
      fontSize: 11,
      textAlign: "center",
      paddingVertical: 12,
      fontStyle: "italic",
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
    badgeText: { color: "#fff", fontSize: 11, fontWeight: "800", letterSpacing: 1 },
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
