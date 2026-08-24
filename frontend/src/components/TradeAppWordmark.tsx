/**
 * TradeAppWordmark — Feb 2027.
 *
 * Pure React Native wordmark rendered as text + a rounded-square badge.
 * Replaces the AI-generated PNG logo everywhere it was causing visual
 * artefacts (baked-in dark background creating a black rectangle on
 * light surfaces, faded glyphs after auto-crop, etc.).
 *
 * Renders as:
 *   [TRADE]  [APP]
 *   ^       ^
 *   text    rounded-square badge
 *
 * Colour follows the enclosing theme — pass `tint` to force white
 * (dark backgrounds) or `colors.text` (light backgrounds). Defaults
 * to white which matches the app's cinematic hero panels.
 */
import React from "react";
import { View, Text, StyleSheet } from "react-native";

export type TradeAppWordmarkProps = {
  /** Height of the whole lockup in px. Width auto-scales. Default 64. */
  size?: number;
  /** Colour of the "TRADE" text + the "APP" badge fill. Default white. */
  tint?: string;
  /** Colour used INSIDE the "APP" badge (opposite of tint). Default black. */
  onTint?: string;
  /** Show the thin horizontal rules above/below the wordmark. Default true. */
  showRules?: boolean;
  /** Optional accessibility label override. */
  accessibilityLabel?: string;
};

export default function TradeAppWordmark({
  size = 64,
  tint = "#FFFFFF",
  onTint = "#000000",
  showRules = true,
  accessibilityLabel = "TradeAPP",
}: TradeAppWordmarkProps) {
  // Every internal dimension scales off `size` so the wordmark
  // stays balanced at any callsite. Numbers were tuned to match the
  // AI-generated PNG's proportions the client approved.
  const tradeFontSize = Math.round(size * 0.62);
  const appFontSize = Math.round(size * 0.36);
  const badgePadV = Math.round(size * 0.14);
  const badgePadH = Math.round(size * 0.18);
  const badgeRadius = Math.round(size * 0.20);
  const gap = Math.round(size * 0.16);
  const ruleThickness = Math.max(1, Math.round(size * 0.02));
  const ruleGap = Math.round(size * 0.08);
  return (
    <View
      style={styles.wrap}
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
    >
      {showRules ? (
        <View
          style={[styles.rule, { backgroundColor: tint, height: ruleThickness, marginBottom: ruleGap }]}
        />
      ) : null}
      <View style={[styles.row, { gap }]}>
        <Text
          style={{
            color: tint,
            fontSize: tradeFontSize,
            fontWeight: "900",
            letterSpacing: tradeFontSize * 0.02,
            lineHeight: tradeFontSize * 1.05,
          }}
          allowFontScaling={false}
        >
          TRADE
        </Text>
        <View
          style={{
            backgroundColor: tint,
            paddingVertical: badgePadV,
            paddingHorizontal: badgePadH,
            borderRadius: badgeRadius,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Text
            style={{
              color: onTint,
              fontSize: appFontSize,
              fontWeight: "900",
              letterSpacing: appFontSize * 0.04,
              lineHeight: appFontSize * 1.05,
            }}
            allowFontScaling={false}
          >
            APP
          </Text>
        </View>
      </View>
      {showRules ? (
        <View
          style={[styles.rule, { backgroundColor: tint, height: ruleThickness, marginTop: ruleGap }]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  rule: {
    width: "100%",
    maxWidth: 480,
  },
});
