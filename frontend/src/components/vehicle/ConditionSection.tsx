// -----------------------------------------------------------------------------
// ConditionSection — Condition breakdown + Overall condition hero +
// Subject-to-View hero (for unseen submissions).
//
// Extracted from `/app/frontend/app/(app)/vehicle/[id].tsx` during the
// P3 modularization pass — Round C (Aug 2026).
// -----------------------------------------------------------------------------
import React from "react";
import { View, Text } from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import DetailRow from "@/src/components/vehicle/DetailRow";
import HeroPill from "@/src/components/vehicle/HeroPill";
import type { Submission } from "@/src/types/vehicle";

export type ConditionSectionProps = {
  sub: Submission;
  averageRating: number | null;
  onOpenRatingGuide: () => void;
  colors: any;
  styles: any;
};

export function ConditionSection({
  sub,
  averageRating,
  onOpenRatingGuide,
  colors,
  styles,
}: ConditionSectionProps) {
  return (
    <>
      {/* Condition breakdown — 4 pillars for new submissions, 3 for legacy. */}
      {!sub.unseen ? (
        <>
          <Text style={styles.sectionTitle}>Condition</Text>
          <View style={styles.detailsList}>
            {typeof sub.mechanical_condition === "number" ? (
              <>
                <DetailRow label="Mechanical Health" value={`${sub.mechanical_condition} / 10`} />
                <DetailRow label="Cosmetic Appearance" value={`${sub.cosmetic_condition} / 10`} />
                <DetailRow label="Interior Condition" value={`${sub.interior_condition} / 10`} />
                <DetailRow label="General Condition" value={`${sub.history_condition} / 10`} />
              </>
            ) : (
              <>
                <DetailRow label="Exterior" value={sub.exterior_condition ? `${sub.exterior_condition} / 10` : "—"} />
                <DetailRow label="Interior" value={sub.interior_condition ? `${sub.interior_condition} / 10` : "—"} />
                <DetailRow label="Tyres" value={sub.tyre_condition ? `${sub.tyre_condition} / 10` : "—"} />
              </>
            )}
            <DetailRow
              label="Previous Accident Damage"
              value={sub.accident_damage ? "Yes" : "None"}
              valueColor={sub.accident_damage ? colors.danger : colors.text}
            />
            {sub.accident_damage && sub.accident_damage_types && sub.accident_damage_types.length > 0 ? (
              <DetailRow
                label="Damage Types"
                value={sub.accident_damage_types.join(", ")}
                valueColor={colors.danger}
              />
            ) : null}
            <DetailRow
              label="Paint Evidence"
              value={sub.paint_evidence ? "Yes" : "No"}
              valueColor={sub.paint_evidence ? colors.danger : colors.text}
              last={!(sub.paint_evidence && sub.paint_quality)}
            />
            {sub.paint_evidence && sub.paint_quality ? (
              <DetailRow label="Paint Repair Quality" value={sub.paint_quality} last />
            ) : null}
          </View>

          {/* Overall condition hero */}
          {averageRating !== null ? (
            <TouchableOpacity
              testID="avg-rating-hero"
              style={styles.heroBox}
              activeOpacity={0.85}
              onPress={onOpenRatingGuide}
              accessibilityLabel="Tap to view condition rating guide"
            >
              <View style={styles.heroTopRow}>
                <Text style={styles.heroLabel}>OVERALL CONDITION</Text>
                <View style={styles.heroInfoBtn}>
                  <Ionicons name="information-circle-outline" size={16} color={colors.textSecondary} />
                  <Text style={styles.heroInfoText}>Guide</Text>
                </View>
              </View>
              <View style={styles.heroRow}>
                <Text style={styles.heroValue}>{averageRating.toFixed(1)}</Text>
                <Text style={styles.heroOutOf}>/ 10</Text>
              </View>
              <View style={styles.heroBar}>
                <View style={[styles.heroBarFill, { width: `${(averageRating / 10) * 100}%` }]} />
              </View>
              <View style={styles.heroBreakdown}>
                {typeof sub.mechanical_condition === "number" ? (
                  <>
                    <HeroPill label="MECH" value={sub.mechanical_condition} />
                    <HeroPill label="COSM" value={sub.cosmetic_condition} />
                    <HeroPill label="INT" value={sub.interior_condition} />
                    <HeroPill label="GEN" value={sub.history_condition} />
                  </>
                ) : (
                  <>
                    <HeroPill label="EXT" value={sub.exterior_condition} />
                    <HeroPill label="INT" value={sub.interior_condition} />
                    <HeroPill label="TYRES" value={sub.tyre_condition} />
                  </>
                )}
              </View>
            </TouchableOpacity>
          ) : null}
        </>
      ) : null}

      {/* Subject-to-View condition hero — replaces the normal Condition
          widget when the vehicle was submitted unseen. */}
      {sub.unseen ? (
        <View style={styles.heroBox} testID="unseen-condition-hero">
          <View style={styles.heroTopRow}>
            <Text style={styles.heroLabel}>OVERALL CONDITION</Text>
            <View style={styles.heroInfoBtn}>
              <Ionicons name="eye-off-outline" size={13} color={colors.textSecondary} />
              <Text style={styles.heroInfoText}>Subject to View</Text>
            </View>
          </View>
          <View style={styles.heroRow}>
            <Text style={styles.heroValue}>10.0</Text>
            <Text style={styles.heroOutOf}>/ 10</Text>
          </View>
          <View style={styles.heroBar}>
            <View style={[styles.heroBarFill, { width: "100%" }]} />
          </View>
          <Text style={styles.unseenHeroCaption}>
            Subject to View — Less to Spend · Priced as-if-perfect condition. Adjusts on physical inspection.
          </Text>
        </View>
      ) : null}
    </>
  );
}

export default ConditionSection;
