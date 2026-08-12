// -----------------------------------------------------------------------------
// MileageIndicator — visual gauge showing whether the vehicle's mileage
// is very-low / low / average / high / very-high relative to typical
// SA mileage-per-year expectations.
//
// How age is computed:
//   Age (in years, decimal) = (submission_date − Jan 1 of model year) / 365.25
//   This lets a 2024 model submitted in June 2026 show as ~2.42 years old,
//   correctly accounting for where we are in the current year.
//
// Bands (per year):
//   Very Low:    0 – 10,000 km/y
//   Low:         10,001 – 15,000 km/y
//   Average:     15,001 – 20,000 km/y
//   High:        20,001 – 30,000 km/y
//   Very High:   30,001 – 40,000+ km/y
//
// Rendered as a horizontal 5-segment gauge with a caret marker showing
// where the actual mileage sits. Also shows the "expected typical" band
// (15–20k × age) and the effective km/year figure below.
// -----------------------------------------------------------------------------
import React, { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { spacing, radius, fonts } from "@/src/theme";
import type { Palette } from "@/src/theme/ThemeContext";

export type MileageBand = "very_low" | "low" | "average" | "high" | "very_high";

export type MileageAssessment = {
  band: MileageBand;
  label: string;
  color: string;
  ageYears: number;
  kmPerYear: number;
  // Position of the caret on the 0..1 gauge scale (0 = far left, 1 = far right).
  gaugePosition: number;
};

const BAND_STOPS_PER_YEAR = [10000, 15000, 20000, 30000, 40000]; // upper bounds
const BAND_META: {
  key: MileageBand;
  label: string;
  gaugeStart: number;
  gaugeEnd: number;
}[] = [
  { key: "very_low",  label: "Very Low",  gaugeStart: 0.0,  gaugeEnd: 0.20 },
  { key: "low",       label: "Low",       gaugeStart: 0.20, gaugeEnd: 0.40 },
  { key: "average",   label: "Average",   gaugeStart: 0.40, gaugeEnd: 0.60 },
  { key: "high",      label: "High",      gaugeStart: 0.60, gaugeEnd: 0.80 },
  { key: "very_high", label: "Very High", gaugeStart: 0.80, gaugeEnd: 1.00 },
];

function bandColor(band: MileageBand, colors: Palette): string {
  switch (band) {
    case "very_low":  return "#0EA5E9";       // sky-500
    case "low":       return colors.success;  // green
    case "average":   return "#F59E0B";       // amber-500
    case "high":      return "#F97316";       // orange-500
    case "very_high": return colors.danger;   // red
  }
}

/**
 * Given a model year, actual odometer reading in km, and the date the
 * submission was captured, return the mileage assessment.
 *
 * If the vehicle is less than ~1 month old we clamp the age to a
 * fractional floor to avoid a divide-by-zero on brand-new demo cars.
 */
export function assessMileage(
  year: number,
  mileageKm: number,
  submittedAt: Date = new Date(),
  colors: Palette,
): MileageAssessment {
  const start = new Date(Date.UTC(year, 0, 1)); // Jan 1 of model year, UTC
  const msDiff = submittedAt.getTime() - start.getTime();
  const rawAgeYears = msDiff / (365.25 * 24 * 60 * 60 * 1000);
  const ageYears = Math.max(rawAgeYears, 1 / 12); // floor at 1 month
  const kmPerYear = mileageKm / ageYears;

  // Determine band
  let band: MileageBand = "very_high";
  for (let i = 0; i < BAND_STOPS_PER_YEAR.length; i++) {
    if (kmPerYear <= BAND_STOPS_PER_YEAR[i]) {
      band = BAND_META[i].key;
      break;
    }
  }

  // Gauge position — map kmPerYear onto the 0..1 axis by interpolating
  // linearly within the band the value lands in. Above 40k = clamped to 1.
  let gaugePosition = 1;
  let lowerBound = 0;
  for (let i = 0; i < BAND_STOPS_PER_YEAR.length; i++) {
    const upper = BAND_STOPS_PER_YEAR[i];
    if (kmPerYear <= upper) {
      const frac = (kmPerYear - lowerBound) / (upper - lowerBound);
      const meta = BAND_META[i];
      gaugePosition = meta.gaugeStart + frac * (meta.gaugeEnd - meta.gaugeStart);
      break;
    }
    lowerBound = upper;
  }
  gaugePosition = Math.max(0, Math.min(1, gaugePosition));

  return {
    band,
    label: BAND_META.find((m) => m.key === band)!.label,
    color: bandColor(band, colors),
    ageYears,
    kmPerYear,
    gaugePosition,
  };
}

export type MileageIndicatorProps = {
  year: number;
  mileageKm: number;
  submittedAt?: string | null; // ISO — falls back to now
  colors: Palette;
};

export default function MileageIndicator({
  year,
  mileageKm,
  submittedAt,
  colors,
}: MileageIndicatorProps) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const submittedDate = useMemo(() => {
    if (submittedAt) {
      try {
        return new Date(submittedAt);
      } catch {
        return new Date();
      }
    }
    return new Date();
  }, [submittedAt]);

  const assessment = useMemo(
    () => assessMileage(year, mileageKm, submittedDate, colors),
    [year, mileageKm, submittedDate, colors],
  );

  // Expected "typical" (average) range in km for THIS car's age
  const typicalLow = Math.round(15000 * assessment.ageYears);
  const typicalHigh = Math.round(20000 * assessment.ageYears);

  return (
    <View style={styles.container} testID="mileage-indicator">
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Mileage Indicator</Text>
          <Text style={styles.subtitle}>
            {mileageKm.toLocaleString()} km on a {year} model
            {" · "}
            {assessment.kmPerYear >= 1000
              ? `${Math.round(assessment.kmPerYear).toLocaleString()} km/yr`
              : `${Math.round(assessment.kmPerYear)} km/yr`}
          </Text>
        </View>
        <View style={[styles.badge, { backgroundColor: assessment.color }]} testID="mileage-band-badge">
          <Ionicons name="speedometer-outline" size={12} color="#fff" />
          <Text style={styles.badgeText}>{assessment.label}</Text>
        </View>
      </View>

      {/* 5-segment gauge — taller so the marker has more room to breathe */}
      <View style={styles.gaugeWrap}>
        <View style={styles.gaugeRow} accessibilityLabel={`Mileage band: ${assessment.label}`}>
          {BAND_META.map((m) => {
            const isActive = m.key === assessment.band;
            return (
              <View
                key={m.key}
                style={[
                  styles.gaugeSegment,
                  {
                    backgroundColor: isActive
                      ? bandColor(m.key, colors)
                      : bandColor(m.key, colors) + "33", // 20% opacity when inactive
                  },
                ]}
              />
            );
          })}
        </View>

        {/* Prominent position marker — pill above + vertical line + big
            ringed dot at the intersection. Rendered as an absolutely-
            positioned overlay so the gauge segments underneath stay
            perfectly rectangular. */}
        <View
          pointerEvents="none"
          style={[styles.markerAnchor, { left: `${assessment.gaugePosition * 100}%` }]}
        >
          {/* Label pill hovering ABOVE the gauge — always readable, never
              overlaps the coloured band. Colour matches the current band. */}
          <View style={[styles.markerPill, { backgroundColor: assessment.color }]} testID="mileage-marker-pill">
            <Ionicons name="speedometer" size={11} color="#fff" />
            <Text style={styles.markerPillText} numberOfLines={1}>
              {Math.round(assessment.kmPerYear).toLocaleString()} km/y
            </Text>
          </View>
          {/* Tick from the pill down to the top of the gauge */}
          <View style={[styles.markerTick, { backgroundColor: assessment.color }]} />
          {/* Vertical line piercing the entire gauge height for pixel-
              precise readability of position. */}
          <View style={[styles.markerLine, { backgroundColor: assessment.color }]} />
          {/* Big ringed dot at the intersection with the gauge midline */}
          <View style={[styles.markerDot, { backgroundColor: assessment.color, borderColor: colors.card }]}>
            <View style={[styles.markerDotInner, { backgroundColor: "#fff" }]} />
          </View>
        </View>
      </View>

      {/* Legend */}
      <View style={styles.legendRow}>
        {BAND_META.map((m) => (
          <View key={m.key} style={styles.legendCol}>
            <Text
              style={[
                styles.legendLabel,
                m.key === assessment.band && { color: colors.text, fontWeight: "700" },
              ]}
              numberOfLines={1}
            >
              {m.label}
            </Text>
          </View>
        ))}
      </View>

      {/* Typical-range explainer */}
      <View style={styles.footRow}>
        <Ionicons name="information-circle-outline" size={13} color={colors.textSecondary} />
        <Text style={styles.footText}>
          Typical for a {assessment.ageYears < 1
            ? `${Math.round(assessment.ageYears * 12)}-month-old`
            : `${assessment.ageYears.toFixed(1)}-year-old`}
          {" "}car: {typicalLow.toLocaleString()}–{typicalHigh.toLocaleString()} km
        </Text>
      </View>
    </View>
  );
}

function makeStyles(colors: Palette) {
  return StyleSheet.create({
    container: {
      backgroundColor: colors.card,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
      marginTop: spacing.md,
      marginBottom: spacing.md,
    },
    header: {
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      marginBottom: spacing.sm,
    },
    title: {
      color: colors.text,
      fontSize: 14,
      fontWeight: "700" as const,
      fontFamily: fonts.heading,
      marginBottom: 2,
    },
    subtitle: {
      color: colors.textSecondary,
      fontSize: 12,
      lineHeight: 16,
    },
    badge: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
      borderRadius: 999,
    },
    badgeText: {
      color: "#fff",
      fontSize: 10,
      fontWeight: "800" as const,
      letterSpacing: 0.4,
    },
    gaugeWrap: {
      position: "relative" as const,
      // Enough top padding for the label pill + tick above the gauge.
      paddingTop: 34,
      marginTop: spacing.sm,
      marginBottom: 6,
    },
    gaugeRow: {
      flexDirection: "row" as const,
      height: 16,
      borderRadius: 999,
      overflow: "hidden" as const,
    },
    gaugeSegment: {
      flex: 1,
      height: "100%",
      marginHorizontal: 0.5,
    },
    /* --- Prominent position marker (pill + tick + line + dot) --- */
    markerAnchor: {
      position: "absolute" as const,
      top: 0,
      bottom: 0,
      // Zero-width anchor so `left: X%` places the centreline exactly at
      // that fraction of the gauge width.
      width: 0,
      alignItems: "center" as const,
    },
    markerPill: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 999,
      // Prevent RN flex-wrapping the pill contents to a second line when
      // the anchor width is 0 — force everything to stay on one row.
      flexWrap: "nowrap" as const,
      alignSelf: "center" as const,
      minWidth: 96,
      justifyContent: "center" as const,
      // Soft elevation so the pill floats above the gauge on light bg too.
      shadowColor: "#000",
      shadowOpacity: 0.25,
      shadowRadius: 4,
      shadowOffset: { width: 0, height: 2 },
      elevation: 3,
    },
    markerPillText: {
      color: "#fff",
      fontSize: 11,
      fontWeight: "800" as const,
      letterSpacing: 0.3,
    },
    markerTick: {
      width: 2,
      height: 6,
      marginTop: 1,
    },
    markerLine: {
      position: "absolute" as const,
      top: 34, // start at top of gauge (gaugeWrap.paddingTop)
      width: 3,
      height: 16, // matches gauge height
      opacity: 0.9,
    },
    markerDot: {
      position: "absolute" as const,
      top: 34 + 16 / 2 - 9, // centre vertically on the 16px-tall gauge
      width: 18,
      height: 18,
      borderRadius: 9,
      borderWidth: 3,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      // Elevation so the dot pops off both the gauge and the card bg
      shadowColor: "#000",
      shadowOpacity: 0.35,
      shadowRadius: 3,
      shadowOffset: { width: 0, height: 1 },
      elevation: 4,
    },
    markerDotInner: {
      width: 6,
      height: 6,
      borderRadius: 3,
    },
    legendRow: {
      flexDirection: "row" as const,
      marginTop: 8,
    },
    legendCol: {
      flex: 1,
      alignItems: "center" as const,
    },
    legendLabel: {
      color: colors.textSecondary,
      fontSize: 10,
      letterSpacing: 0.2,
    },
    footRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 4,
      marginTop: spacing.md,
    },
    footText: {
      color: colors.textSecondary,
      fontSize: 12,
      flex: 1,
    },
  });
}
