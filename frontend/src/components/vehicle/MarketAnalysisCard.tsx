// -----------------------------------------------------------------------------
// MarketAnalysisCard — collapsible AI-generated market analysis section.
//
// Extracted from `/app/frontend/app/(app)/vehicle/[id].tsx` during the
// P3 modularization pass (Aug 2026). Renders the GPT-5.2 market-range
// summary, trade/retail estimates, year/mileage positioning, key
// factors, Kredo alignment, recon impact and confidence. The parent
// still owns the raw `sub.market_analysis` payload and the
// analyse/refresh action — this component only handles presentation.
// -----------------------------------------------------------------------------
import React from "react";
import { View, Text, ActivityIndicator } from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import { spacing } from "@/src/theme";
import CollapsibleSection from "@/src/components/vehicle/CollapsibleSection";
import type { MarketAnalysisPayload } from "@/src/types/vehicle";

export type MarketAnalysisCardProps = {
  analysis: MarketAnalysisPayload | null | undefined;
  open: boolean;
  onToggle: () => void;
  analysing: boolean;
  onAnalyse: () => void;
  colors: any;
  styles: any;
};

export function MarketAnalysisCard({
  analysis,
  open,
  onToggle,
  analysing,
  onAnalyse,
  colors,
  styles,
}: MarketAnalysisCardProps) {
  const summary = analysis?.analysis?.estimated_market_range_zar
    ? `R ${analysis.analysis.estimated_market_range_zar.low.toLocaleString()} — R ${analysis.analysis.estimated_market_range_zar.high.toLocaleString()}`
    : analysis?.generated_at
      ? "Analysis ready"
      : "Not yet analysed";

  return (
    <CollapsibleSection
      title="AI Market Analysis"
      open={open}
      onToggle={onToggle}
      summary={summary}
      right={
        <TouchableOpacity
          testID="market-analysis-button"
          style={[styles.analysisBtn, analysing && { opacity: 0.6 }]}
          onPress={(e: any) => { e?.stopPropagation?.(); onAnalyse(); }}
          disabled={analysing}
        >
          {analysing ? (
            <ActivityIndicator color={colors.primary} size="small" />
          ) : (
            <>
              <Ionicons name="sparkles" size={14} color={colors.primary} />
              <Text style={styles.analysisBtnText}>
                {analysis ? "Refresh" : "Analyse"}
              </Text>
            </>
          )}
        </TouchableOpacity>
      }
      colors={colors}
      styles={styles}
      testID="ai-market-analysis"
    >
      {analysis?.generated_at ? (
        <Text style={[styles.analysisTs, { marginBottom: spacing.sm }]}>
          Generated {new Date(analysis.generated_at).toLocaleString()}
        </Text>
      ) : null}

      {analysis?.analysis ? (
        <View style={styles.analysisCard} testID="market-analysis-card">
          {analysis.analysis.estimated_market_range_zar ? (
            <View style={styles.rangeBox}>
              <View style={styles.rangeCol}>
                <Text style={styles.rangeLabel}>LOW</Text>
                <Text style={styles.rangeValue}>
                  R {analysis.analysis.estimated_market_range_zar.low.toLocaleString()}
                </Text>
              </View>
              <View style={[styles.rangeCol, styles.rangeColMid]}>
                <Text style={styles.rangeLabel}>TYPICAL</Text>
                <Text style={styles.rangeValue}>
                  R {analysis.analysis.estimated_market_range_zar.typical.toLocaleString()}
                </Text>
              </View>
              <View style={styles.rangeCol}>
                <Text style={styles.rangeLabel}>HIGH</Text>
                <Text style={styles.rangeValue}>
                  R {analysis.analysis.estimated_market_range_zar.high.toLocaleString()}
                </Text>
              </View>
            </View>
          ) : null}

          <View style={styles.tradeRow}>
            {analysis.analysis.trade_price_estimate_zar ? (
              <View style={styles.tradeCol}>
                <Text style={styles.tradeLabel}>Trade Estimate</Text>
                <Text style={styles.tradeValue}>
                  R {analysis.analysis.trade_price_estimate_zar.toLocaleString()}
                </Text>
              </View>
            ) : null}
            {analysis.analysis.retail_price_estimate_zar ? (
              <View style={styles.tradeCol}>
                <Text style={styles.tradeLabel}>Retail Estimate</Text>
                <Text style={styles.tradeValue}>
                  R {analysis.analysis.retail_price_estimate_zar.toLocaleString()}
                </Text>
              </View>
            ) : null}
          </View>

          {analysis.analysis.year_positioning ? (
            <View style={styles.factorsBox}>
              <Text style={styles.factorsTitle}>YEAR POSITIONING</Text>
              <Text style={styles.factorText}>
                {analysis.analysis.year_positioning}
              </Text>
            </View>
          ) : null}

          {analysis.analysis.mileage_positioning ? (
            <View style={styles.factorsBox}>
              <Text style={styles.factorsTitle}>MILEAGE POSITIONING</Text>
              <Text style={styles.factorText}>
                {analysis.analysis.mileage_positioning}
              </Text>
            </View>
          ) : null}

          {analysis.analysis.listings_summary ? (
            <Text style={styles.summary}>{analysis.analysis.listings_summary}</Text>
          ) : null}

          {analysis.analysis.key_factors?.length ? (
            <View style={styles.factorsBox}>
              <Text style={styles.factorsTitle}>KEY FACTORS</Text>
              {analysis.analysis.key_factors.map((f, i) => (
                <View key={i} style={styles.factorRow}>
                  <Ionicons name="checkmark-circle" size={14} color={colors.primary} />
                  <Text style={styles.factorText}>{f}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {analysis.analysis.kredo_alignment ? (
            <View style={styles.factorsBox}>
              <Text style={styles.factorsTitle}>KREDO ALIGNMENT</Text>
              <Text style={styles.factorText}>
                {analysis.analysis.kredo_alignment}
              </Text>
            </View>
          ) : null}

          {analysis.analysis.recon_impact_zar ? (
            <Text style={styles.confidence}>
              Recon adjustment: −R {analysis.analysis.recon_impact_zar.toLocaleString()}
            </Text>
          ) : null}

          {analysis.analysis.confidence ? (
            <Text style={styles.confidence}>
              Confidence: {analysis.analysis.confidence.toUpperCase()}
            </Text>
          ) : null}

          {analysis.analysis.raw ? (
            <Text style={styles.summary}>{analysis.analysis.raw}</Text>
          ) : null}

          {analysis.analysis.disclaimer ? (
            <Text style={styles.disclaimer}>{analysis.analysis.disclaimer}</Text>
          ) : null}
        </View>
      ) : (
        <View style={styles.analysisEmpty}>
          <Ionicons name="analytics-outline" size={20} color={colors.textSecondary} />
          <Text style={styles.analysisEmptyText}>
            Tap Analyse for a GPT-5.2 market overview comparing this car against typical
            autotrader.co.za and cars.co.za listings.
          </Text>
        </View>
      )}
    </CollapsibleSection>
  );
}

export default MarketAnalysisCard;
