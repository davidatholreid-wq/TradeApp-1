// -----------------------------------------------------------------------------
// ComparableListingsCard — deep-links dealers/admins into AutoTrader.co.za
// search results pre-filtered to comparable stock (same make + model,
// full manufacture-year run of that derivative, and matching fuel type).
// We don't scrape or store anything — we simply hand off to the live
// site so users can eyeball the cheapest example on the market for
// context during the valuation.
//
// URL SCHEMES
// -----------
// AutoTrader supports two search entry points:
//   1. Model page:  /cars-for-sale/{make}/{model}?year=&fueltype=&transmission=
//   2. Make page:   /cars-for-sale/{make}?keyword=X&keyword=Y&year=...
// The model page is far more accurate — AT's own catalogue redirect
// picks up variants like "A200", "A45 AMG" under `a-class`. Keyword
// search misses these when the derivative token doesn't happen to
// appear in the listing text (which is why dealers report cars
// "not being picked up just on the keywords").
//
// When the dealer picks a catalogue model from the WBC-style dropdown
// we now hit the /model page directly and use `keyword=` only for
// TRIM-level narrowing (e.g. "AMG Line", "Style Line").
// Falls back to the legacy keyword-only URL when there's no catalogue
// match for the make/model pair.
// -----------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Linking, Platform, Image, TextInput, ScrollView } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import {
  AUTOTRADER_MAKES,
  AUTOTRADER_CATALOGUE,
  resolveAtMake,
  guessAtModel,
  atSlug,
} from "@/src/data/autotraderCatalogue";

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

// Once a MODEL is selected from the picker we don't want the derivative
// keywords to leak into the URL — see the reasoning in
// `buildAutoTraderUrl`. Kept as a helper for callers that still want
// the "trim-only" token list (e.g. a future "narrow further" affordance),
// but the main URL builder no longer uses it.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function trimKeywords(
  derivative: string | undefined,
  model: string | undefined,
  resolvedModel: string | null,
): string[] {
  const all = derivativeKeywords(derivative, model);
  if (!resolvedModel) return all;
  const modelTokens = new Set(
    resolvedModel
      .toLowerCase()
      .split(/[-\s]+/)
      .filter(Boolean),
  );
  return all.filter((t) => {
    const tl = t.toLowerCase();
    if (modelTokens.has(tl)) return false;
    // Also drop pure-numeric tokens that match the model (e.g. "3"
    // when model is "3 Series").
    return true;
  });
}

// Resolve the year range to feed into AutoTrader's `year=X-to-Y` filter.
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

// Legacy free-text slugifier — used when the make isn't in the AT
// catalogue (rare, but possible for niche imports). Falls back to the
// same lowercase-hyphenate transformation the catalogue slugger uses.
function slugFallback(s: string): string {
  return encodeURIComponent(
    s.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
  );
}

// Build the AutoTrader deep link. Two paths:
//
//  A. Catalogue path (preferred) — when the dealer selected a WBC-
//     catalogue model from the dropdown, hit the make/model page
//     directly. AutoTrader's own catalogue redirect handles A-Class
//     variants like A200, A45 AMG, etc. correctly.
//       /cars-for-sale/mercedes-benz/a-class?year=2015-to-2019
//         &fueltype=Petrol&transmission=Automatic&dealerrating=3
//         [&keyword=AMG&keyword=Line]  <-- trim tokens only
//
//  B. Fallback (legacy) — when there's no catalogue match, land on the
//     make page with every derivative token as its own keyword pill.
//       /cars-for-sale/gwm?keyword=Tank&keyword=300&keyword=Super
//         &keyword=Luxury&year=2024-to-2026&fueltype=Hybrid
//         &transmission=Automatic&dealerrating=3
function buildAutoTraderUrl(
  p: Props,
  overrides?: { make?: string | null; model?: string | null },
): string | null {
  const canonicalMake = overrides?.make ?? null;
  const canonicalModel = overrides?.model ?? null;

  const makeRaw = cleanText(p.make);
  if (!makeRaw && !canonicalMake) return null;

  const range = resolveYearRange(p);
  const fuel = normaliseFuel(p.fuelType);
  const trans = normaliseTransmission(p.transmission);

  const qs = new URLSearchParams();
  if (range) qs.set("year", `${range.from}-to-${range.to}`);
  if (fuel) qs.set("fueltype", fuel);
  if (trans) qs.set("transmission", trans);
  qs.set("dealerrating", "3");

  // Path A: catalogue-driven make/model. Model page is precise enough
  // on its own — the year + fuel + transmission chips already narrow
  // things further, and adding derivative tokens as `keyword=` pills
  // was over-filtering (e.g. `keyword=200` cut a `A-Class` search
  // down from ~800 hits to just the handful of listings whose
  // description happens to spell out "200"). If the dealer wants
  // trim-level narrowing they can clear the picker and switch back
  // to keyword search via the "Clear" row below the dropdown.
  if (canonicalMake && canonicalModel) {
    const path = `${atSlug(canonicalMake)}/${atSlug(canonicalModel)}`;
    return `https://www.autotrader.co.za/cars-for-sale/${path}?${qs.toString()}`;
  }

  // Path B: catalogue-make but no model chosen — still an improvement
  // over the legacy path because we can shed the model-name tokens
  // from the keyword pills once we know the make officially.
  const kws = derivativeKeywords(p.derivative, p.model);
  for (const k of kws) qs.append("keyword", k);
  const makeSlug = canonicalMake ? atSlug(canonicalMake) : slugFallback(makeRaw);
  return `https://www.autotrader.co.za/cars-for-sale/${makeSlug}?${qs.toString()}`;
}

function searchLabel(p: Props, model: string | null): string {
  const make = cleanText(p.make);
  const kw = model
    ? model
    : derivativeKeywords(p.derivative, p.model).join(" ");
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

  // Auto-derive the initial AT make/model from Kredo data, then let the
  // dealer pin the model via a dropdown. AT's catalogue naming can differ
  // from Kredo (e.g. Kredo `A-CLASS` vs AT `A-Class`), and the dropdown
  // ensures we send the exact string the AT URL router expects.
  const atMakeResolved = useMemo(
    () => resolveAtMake(props.make),
    [props.make],
  );
  const catalogueModels = useMemo(
    () => (atMakeResolved ? AUTOTRADER_CATALOGUE[atMakeResolved] : null),
    [atMakeResolved],
  );
  const initialGuess = useMemo(() => {
    if (!atMakeResolved) return "";
    // Try both the raw model AND the first-derivative token as guess
    // sources. Whichever yields a catalogue match wins.
    const modelClean = cleanText(props.model);
    const der = cleanText(props.derivative);
    const guesses = [modelClean, der].filter(Boolean);
    for (const g of guesses) {
      const hit = guessAtModel(atMakeResolved, g);
      if (hit) return hit;
      // Try just the first 1-2 tokens (e.g. "3 SERIES 320i" -> "3 SERIES")
      const tokens = g.split(/\s+/);
      for (let n = Math.min(3, tokens.length); n >= 1; n--) {
        const slice = tokens.slice(0, n).join(" ");
        const hit2 = guessAtModel(atMakeResolved, slice);
        if (hit2) return hit2;
      }
    }
    return "";
  }, [atMakeResolved, props.model, props.derivative]);

  const [selectedModel, setSelectedModel] = useState<string>(initialGuess);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");

  // Refresh the selection if the underlying vehicle changes.
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

  const effectiveMake = atMakeResolved || cleanText(props.make) || "";
  const effectiveModel = atMakeResolved ? selectedModel : "";

  const autoTrader = useMemo(
    () =>
      buildAutoTraderUrl(props, {
        make: atMakeResolved,
        model: effectiveModel || null,
      }),
    [props, atMakeResolved, effectiveModel],
  );
  if (!autoTrader) return null;

  const range = resolveYearRange(props);
  const yearStr = range
    ? range.from === range.to
      ? String(range.from)
      : `${range.from} – ${range.to}`
    : "any year";
  const searchLbl = searchLabel(props, effectiveModel || null);
  const fuel = normaliseFuel(props.fuelType);
  const trans = normaliseTransmission(props.transmission);

  // Compact chips describing what's pre-applied. When a catalogue
  // model is selected the URL relies purely on the make/model path +
  // year/fuel/transmission chips (no keyword pills — see
  // `buildAutoTraderUrl` for the reasoning), so we also hide the
  // derivative tokens from the chip row to match what AT actually
  // sees. Falling back to keyword search? Show the tokens.
  const kwTokens = effectiveModel
    ? []
    : derivativeKeywords(props.derivative, props.model);
  const chips: string[] = [];
  if (effectiveMake) chips.push(effectiveMake);
  if (effectiveModel) chips.push(effectiveModel);
  chips.push(...kwTokens);
  if (range) chips.push(range.from === range.to ? `${range.from}` : `${range.from}–${range.to}`);
  if (fuel) chips.push(fuel);
  if (trans) chips.push(trans);
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

      {/* AT-catalogue model picker — visible only when the make is in
          our curated brand list. Otherwise we fall back silently to
          the keyword-only URL (kept invisible to avoid clutter). */}
      {catalogueModels ? (
        <View style={styles.pickerBlock}>
          <View style={styles.pickerHeader}>
            <Text style={styles.pickerLabel}>AutoTrader Model</Text>
            <Text style={styles.pickerHint}>
              {AUTOTRADER_MAKES.includes(effectiveMake) ? effectiveMake : "—"}
            </Text>
          </View>
          <TouchableOpacity
            testID="at-model-picker"
            style={styles.pickerButton}
            onPress={() => setPickerOpen((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel="Change AutoTrader model"
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
                  testID="at-model-search"
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
              {selectedModel ? (
                <TouchableOpacity
                  style={styles.pickerClearRow}
                  onPress={() => {
                    setSelectedModel("");
                    setPickerOpen(false);
                    setSearch("");
                  }}
                  accessibilityRole="button"
                >
                  <Ionicons name="refresh" size={14} color={colors.textSecondary} />
                  <Text style={styles.pickerClearText}>
                    Clear — search by keywords only
                  </Text>
                </TouchableOpacity>
              ) : null}
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
        testID="open-autotrader"
        onPress={() => open(autoTrader)}
        accessibilityRole="link"
        accessibilityLabel="Open comparable listings on AutoTrader.co.za"
        activeOpacity={0.85}
        style={styles.actionBtnPress}
      >
        {/* AutoTrader SA brand — the marque is a red-over-blue
            parallelogram on white. We echo that by using a diagonal
            red → blue gradient with white text and a white brand chip
            + arrow pip. Reads as unmistakably AutoTrader without the
            white split cutting through the CTA text. */}
        <LinearGradient
          colors={["#E4002B", "#B10021", "#0072CE", "#0092D5"]}
          locations={[0, 0.5, 0.5, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.actionBtn}
        >
          <View style={styles.brandChipAT}>
            <Text style={styles.brandChipTxtAT}>AT</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.btnTitleBright}>Open AutoTrader.co.za</Text>
            <Text style={styles.btnSubBright} numberOfLines={2}>
              {[
                [effectiveMake, effectiveModel].filter(Boolean).join(" ") ||
                  (kwTokens.length ? kwTokens.join(" · ") : null),
                range ? (range.from === range.to ? `Year ${range.from}` : `Years ${range.from}–${range.to}`) : null,
                fuel,
                trans,
              ].filter(Boolean).join(" · ") || "Model listing"}
            </Text>
          </View>
          <View style={styles.arrowPipAT}>
            <Ionicons name="arrow-forward" size={16} color="#FFFFFF" />
          </View>
        </LinearGradient>
      </TouchableOpacity>

      <View style={styles.disclaimerWrap}>
        <Text style={styles.disclaimer}>
          Tip: AutoTrader listings on this deep link come from reputable
          franchise and dealer partners rated 3★ or higher — vehicles are
          typically reconditioned and warrantied. Cheapest example gives
          you a solid retail benchmark.
        </Text>
      </View>
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
      // Contains the italic disclaimer / children strictly inside the
      // rounded border on web. Matches the sibling WeBuyCars card.
      overflow: "hidden",
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

    // AT model picker (dropdown + search) — mirrors the WBC card so
    // the two comparison cards feel like matching destinations.
    pickerBlock: {
      marginTop: 4,
      gap: 6,
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
    pickerClearRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 9,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.paper,
    },
    pickerClearText: {
      color: colors.textSecondary,
      fontSize: 11,
      fontStyle: "italic",
    },

    actionBtnPress: {
      marginTop: 4,
      borderRadius: radius.md,
      // Blue-tinted shadow — matches the lower half of the AutoTrader
      // gradient so the CTA "lifts" in-brand.
      ...Platform.select({
        ios: {
          shadowColor: "#0072CE",
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: 0.4,
          shadowRadius: 12,
        },
        android: { elevation: 4 },
        web: {
          // @ts-ignore — RN-Web only property
          boxShadow: "0 6px 18px rgba(0,114,206,0.32)",
        },
      }),
    },
    actionBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: spacing.md,
      paddingVertical: 14,
      borderRadius: radius.md,
    },
    // White rounded chips (left brand + right arrow) contrast cleanly
    // against the red/blue AutoTrader gradient behind them. Icon
    // colour flips to the closer brand red on the arrow pip.
    arrowPipAT: {
      width: 30,
      height: 30,
      borderRadius: 15,
      backgroundColor: "rgba(255,255,255,0.22)",
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.6)",
      alignItems: "center",
      justifyContent: "center",
    },
    brandChipAT: {
      minWidth: 42,
      height: 30,
      paddingHorizontal: 10,
      borderRadius: 15,
      backgroundColor: "#FFFFFF",
      alignItems: "center",
      justifyContent: "center",
    },
    brandChipTxtAT: {
      color: "#0072CE",
      fontSize: 12,
      fontWeight: "900",
      letterSpacing: 1.4,
    },
    btnTitleBright: {
      color: "#FFFFFF",
      fontSize: 15,
      fontWeight: "800",
      letterSpacing: 0.2,
      // Slight text-shadow so the title stays legible across the
      // red-to-blue gradient handoff on both AT and WBC buttons.
      ...Platform.select({
        web: { /* @ts-ignore */ textShadow: "0 1px 2px rgba(0,0,0,0.35)" as any },
        default: {
          textShadowColor: "rgba(0,0,0,0.35)",
          textShadowOffset: { width: 0, height: 1 },
          textShadowRadius: 2,
        },
      }),
    },
    btnSubBright: {
      color: "rgba(255,255,255,0.94)",
      fontSize: 11,
      marginTop: 2,
      fontWeight: "600",
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

    disclaimerWrap: {
      alignSelf: "stretch",
      marginTop: 8,
      paddingTop: 8,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    disclaimer: {
      color: colors.textSecondary,
      fontSize: 11,
      fontStyle: "italic",
      lineHeight: 15,
      flexShrink: 1,
    },
  });
}
