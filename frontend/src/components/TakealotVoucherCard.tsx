import React from "react";
import { View, Text, StyleSheet, ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing, fonts } from "@/src/theme";

type Props = {
  value?: number;
  pointsRequired?: number;
  unlocked?: boolean;
  style?: ViewStyle;
};

// Subtle brand-pattern icons scattered across the card background.
// Rendered at very low opacity so the R500 / wordmark stay crisp.
const PATTERN: {
  name: keyof typeof Ionicons.glyphMap;
  top: string;
  left: string;
  size: number;
}[] = [
  { name: "headset-outline", top: "10%", left: "78%", size: 20 },
  { name: "heart-outline", top: "22%", left: "8%", size: 16 },
  { name: "musical-notes-outline", top: "38%", left: "88%", size: 18 },
  { name: "game-controller-outline", top: "50%", left: "6%", size: 20 },
  { name: "cube-outline", top: "56%", left: "82%", size: 16 },
  { name: "flame-outline", top: "70%", left: "12%", size: 16 },
  { name: "gift-outline", top: "76%", left: "78%", size: 18 },
  { name: "sparkles-outline", top: "18%", left: "42%", size: 14 },
];

export function TakealotVoucherCard({
  value = 500,
  pointsRequired = 50,
  unlocked = false,
  style,
}: Props) {
  return (
    <View style={[styles.outer, style]}>
      {/* Card body — dark charcoal for maximum R500 contrast */}
      <LinearGradient
        colors={["#1F2937", "#0B1220"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.card}
      >
        {/* Icon pattern layer */}
        <View style={styles.pattern} pointerEvents="none">
          {PATTERN.map((p, i) => (
            <View
              key={i}
              style={[
                styles.patternIcon,
                { top: p.top as any, left: p.left as any },
              ]}
            >
              <Ionicons name={p.name} size={p.size} color="rgba(255,255,255,0.06)" />
            </View>
          ))}
        </View>

        {/* Diagonal gloss highlight — very subtle, gives the card a premium sheen */}
        <LinearGradient
          colors={[
            "rgba(255,255,255,0)",
            "rgba(255,255,255,0.06)",
            "rgba(255,255,255,0)",
          ]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.gloss}
          pointerEvents="none"
        />

        {/* Top: brand + status pill */}
        <View style={styles.topRow}>
          <View style={styles.brandRow}>
            <Text style={styles.brandWord}>takealot</Text>
            <View style={styles.brandChip}>
              <Text style={styles.brandChipText}>.com</Text>
            </View>
          </View>
          <View
            style={[
              styles.statusPill,
              unlocked ? styles.statusPillOn : styles.statusPillOff,
            ]}
          >
            <Ionicons
              name={unlocked ? "checkmark-circle" : "lock-closed"}
              size={10}
              color={unlocked ? "#0B1220" : "#F5F5F5"}
            />
            <Text
              style={[
                styles.statusPillText,
                unlocked && styles.statusPillTextOn,
              ]}
            >
              {unlocked ? "READY" : `${pointsRequired} PTS`}
            </Text>
          </View>
        </View>

        {/* Big value */}
        <View style={styles.valueRow}>
          <Text style={styles.currency}>R</Text>
          <Text style={styles.value}>{value}</Text>
          <View style={styles.valueRight}>
            <Text style={styles.tag}>GIFT</Text>
            <Text style={styles.tag}>VOUCHER</Text>
          </View>
        </View>

        {/* Divider line */}
        <View style={styles.divider} pointerEvents="none" />

        {/* Bottom band */}
        <View style={styles.footer}>
          <View style={styles.footerLeft}>
            <Ionicons name="ribbon-outline" size={12} color="#F5F5F5" />
            <Text style={styles.footerLabel}>FOURBUY REWARDS</Text>
          </View>
          <Text style={styles.footerCode}>
            NO • {String(value).padStart(4, "0")} • ZA
          </Text>
        </View>
      </LinearGradient>

      {/* Ticket perforation notches (cut-outs against the page bg) */}
      <View style={[styles.notch, styles.notchLeft]} />
      <View style={[styles.notch, styles.notchRight]} />
    </View>
  );
}

const CARD_HEIGHT = 200;

const styles = StyleSheet.create({
  outer: {
    width: "100%",
    height: CARD_HEIGHT,
    position: "relative",
  },
  card: {
    flex: 1,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    overflow: "hidden",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    // Soft luxury shadow
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 8,
  },
  pattern: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  patternIcon: {
    position: "absolute",
  },
  gloss: {
    position: "absolute",
    top: -CARD_HEIGHT,
    left: -60,
    width: 160,
    height: CARD_HEIGHT * 3,
    transform: [{ rotate: "18deg" }],
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    zIndex: 3,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  brandWord: {
    color: "#F5F5F5",
    fontSize: 20,
    fontWeight: "800",
    letterSpacing: -0.4,
    fontFamily: fonts.heading,
  },
  brandChip: {
    backgroundColor: "#F5F5F5",
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginLeft: 2,
    marginTop: 4,
  },
  brandChipText: {
    color: "#0B1220",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  statusPillOff: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderColor: "rgba(255,255,255,0.15)",
  },
  statusPillOn: {
    backgroundColor: "#F5F5F5",
    borderColor: "#F5F5F5",
  },
  statusPillText: {
    color: "#F5F5F5",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1,
  },
  statusPillTextOn: {
    color: "#0B1220",
  },
  valueRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    marginTop: 6,
    zIndex: 3,
  },
  currency: {
    color: "#FFFFFF",
    fontSize: 32,
    fontWeight: "800",
    letterSpacing: -1,
    fontFamily: fonts.number,
    marginTop: -14, // sit slightly above the digits like a proper currency mark
    marginRight: 2,
  },
  value: {
    color: "#FFFFFF",
    fontSize: 72,
    fontWeight: "900",
    letterSpacing: -3,
    fontFamily: fonts.number,
    lineHeight: 74,
    // Subtle glow so the number pops off the dark card
    textShadowColor: "rgba(255,255,255,0.25)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 12,
  },
  valueRight: {
    marginLeft: spacing.md,
    alignItems: "flex-start",
    justifyContent: "center",
  },
  tag: {
    color: "#F5F5F5",
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 3,
    lineHeight: 16,
  },
  divider: {
    height: 1,
    backgroundColor: "rgba(255,255,255,0.10)",
    marginBottom: 8,
    zIndex: 3,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    zIndex: 3,
  },
  footerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  footerLabel: {
    color: "#F5F5F5",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.4,
  },
  footerCode: {
    color: "rgba(245,245,245,0.55)",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.4,
    fontFamily: fonts.mono,
  },
  // Ticket notches on the sides — cut-outs against the page bg
  notch: {
    position: "absolute",
    top: CARD_HEIGHT / 2 - 10,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.bg,
    zIndex: 5,
  },
  notchLeft: { left: -10 },
  notchRight: { right: -10 },
});

export default TakealotVoucherCard;
