// -----------------------------------------------------------------------------
// TyreEstimateCard — admin-only GPT-5.2 tyre replacement price estimate.
//
// Extracted from `/app/frontend/app/(app)/vehicle/[id].tsx` during the
// P3 modularization pass — Round C (Aug 2026).
// -----------------------------------------------------------------------------
import React from "react";
import { View, Text, ActivityIndicator } from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import CollapsibleSection from "@/src/components/vehicle/CollapsibleSection";
import type { TyreEstimatePayload } from "@/src/types/vehicle";

export type TyreEstimateCardProps = {
  tyreEstimate: TyreEstimatePayload | null | undefined;
  estimating: boolean;
  onEstimate: () => void;
  colors: any;
  styles: any;
  // Aug 2026: collapsible via the shared CollapsibleSection component so
  // the header/chevron style matches AI Market Analysis, Compare Live
  // Listings and VIN-Linked Reports exactly. When these props aren't
  // supplied the caller is treated as legacy and the card renders fully.
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
};

export function TyreEstimateCard({
  tyreEstimate,
  estimating,
  onEstimate,
  colors,
  styles,
  collapsed = false,
  onToggleCollapsed,
}: TyreEstimateCardProps) {
  // Right-slot action button (Estimate / Refresh). Kept in the header
  // so dealers don't need to expand the card to trigger the LLM call.
  const rightSlot = (
    <TouchableOpacity
      testID="tyre-estimate-button"
      style={[styles.analysisBtn, estimating && { opacity: 0.6 }]}
      onPress={onEstimate}
      disabled={estimating}
    >
      {estimating ? (
        <ActivityIndicator color={colors.primary} size="small" />
      ) : (
        <>
          <Ionicons name="disc-outline" size={14} color={colors.primary} />
          <Text style={styles.analysisBtnText}>
            {tyreEstimate ? "Refresh" : "Estimate"}
          </Text>
        </>
      )}
    </TouchableOpacity>
  );

  const summary = tyreEstimate?.generated_at
    ? `Generated ${new Date(tyreEstimate.generated_at).toLocaleString()}`
    : "Not yet estimated";

  return (
    <CollapsibleSection
      testID="tyre-estimate-section"
      title="Tyre Replacement Estimate"
      summary={summary}
      right={rightSlot}
      open={!collapsed}
      onToggle={() => onToggleCollapsed?.()}
      colors={colors}
      styles={styles}
    >
      {tyreEstimate?.estimate ? (
        <View style={styles.analysisCard} testID="tyre-estimate-card">
          <View style={styles.tyreHeaderRow}>
            <View style={styles.tyreSpecBadge}>
              <Ionicons name="disc" size={14} color="#fff" />
              <Text style={styles.tyreSpecText}>
                {tyreEstimate.estimate.tyre_spec ?? "—"}
              </Text>
            </View>
          </View>

          {tyreEstimate.estimate.total_replacement_estimate_zar ? (
            <View style={styles.tyreTotalBox}>
              <Text style={styles.tyreTotalLabel}>Total 4-tyre replacement</Text>
              <Text style={styles.tyreTotalValue}>
                R {tyreEstimate.estimate.total_replacement_estimate_zar.toLocaleString()}
              </Text>
            </View>
          ) : null}

          {tyreEstimate.estimate.set_of_four_zar ? (
            <View style={styles.rangeBox}>
              <View style={styles.rangeCol}>
                <Text style={styles.rangeLabel}>SET LOW</Text>
                <Text style={styles.rangeValue}>
                  R {tyreEstimate.estimate.set_of_four_zar.low.toLocaleString()}
                </Text>
              </View>
              <View style={[styles.rangeCol, styles.rangeColMid]}>
                <Text style={styles.rangeLabel}>TYPICAL</Text>
                <Text style={styles.rangeValue}>
                  R {tyreEstimate.estimate.set_of_four_zar.typical.toLocaleString()}
                </Text>
              </View>
              <View style={styles.rangeCol}>
                <Text style={styles.rangeLabel}>SET HIGH</Text>
                <Text style={styles.rangeValue}>
                  R {tyreEstimate.estimate.set_of_four_zar.high.toLocaleString()}
                </Text>
              </View>
            </View>
          ) : null}

          <View style={styles.tradeRow}>
            {tyreEstimate.estimate.per_tyre_range_zar ? (
              <View style={styles.tradeCol}>
                <Text style={styles.tradeLabel}>Per tyre (typical)</Text>
                <Text style={styles.tradeValue}>
                  R {tyreEstimate.estimate.per_tyre_range_zar.typical.toLocaleString()}
                </Text>
              </View>
            ) : null}
            {tyreEstimate.estimate.fitment_and_balance_zar ? (
              <View style={styles.tradeCol}>
                <Text style={styles.tradeLabel}>Fitment &amp; balance</Text>
                <Text style={styles.tradeValue}>
                  R {tyreEstimate.estimate.fitment_and_balance_zar.toLocaleString()}
                </Text>
              </View>
            ) : null}
          </View>

          {tyreEstimate.estimate.recommended_brands?.length ? (
            <View style={styles.factorsBox}>
              <Text style={styles.factorsTitle}>RECOMMENDED BRANDS</Text>
              {tyreEstimate.estimate.recommended_brands.map((b, i) => (
                <View key={i} style={styles.factorRow}>
                  <Ionicons name="checkmark-circle" size={14} color={colors.primary} />
                  <Text style={styles.factorText}>{b}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {tyreEstimate.estimate.notes ? (
            <Text style={styles.summary}>{tyreEstimate.estimate.notes}</Text>
          ) : null}

          {tyreEstimate.estimate.confidence ? (
            <Text style={styles.confidence}>
              Confidence: {tyreEstimate.estimate.confidence.toUpperCase()}
            </Text>
          ) : null}

          {tyreEstimate.estimate.raw ? (
            <Text style={styles.summary}>{tyreEstimate.estimate.raw}</Text>
          ) : null}

          {tyreEstimate.estimate.disclaimer ? (
            <Text style={styles.disclaimer}>{tyreEstimate.estimate.disclaimer}</Text>
          ) : null}
        </View>
      ) : (
        <View style={styles.analysisEmpty}>
          <Ionicons name="disc-outline" size={20} color={colors.textSecondary} />
          <Text style={styles.analysisEmptyText}>
            Tap Estimate for a GPT-5.2 tyre-replacement price based on this vehicle&apos;s
            OEM tyre spec and current SA aftermarket pricing.
          </Text>
        </View>
      )}
    </CollapsibleSection>
  );
}

export default TyreEstimateCard;
