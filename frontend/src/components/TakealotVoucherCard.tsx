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
// Kept very low-opacity so the R500 / wordmark stay crisp.
const PATTERN: {
  name: keyof typeof Ionicons.glyphMap;
  top: string;
  left: string;
  size: number;
}[] = [
  { name: "headset-outline", top: "8%", left: "78%", size: 18 },
  { name: "heart-outline", top: "18%", left: "6%", size: 14 },
  { name: "musical-notes-outline", top: "30%", left: "88%", size: 16 },
  { name: "game-controller-outline", top: "42%", left: "4%", size: 18 },
  { name: "cube-outline", top: "48%", left: "82%", size: 15 },
  { name: "flame-outline", top: "62%", left: "10%", size: 14 },
  { name: "gift-outline", top: "72%", left: "80%", size: 16 },
  { name: "star-outline", top: "56%", left: "50%", size: 14 },
  { name: "sparkles-outline", top: "22%", left: "40%", size: 14 },
];

export function TakealotVoucherCard({
  value = 500,
  pointsRequired = 50,
  unlocked = false,
  style,
}: Props) {
  return (
    <View style={[styles.outer, style]}>
      <LinearGradient
        colors={["#FFFFFF", "#F2F3F5"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.card}
      >
        {/* Subtle icon pattern */}
        <View style={styles.pattern} pointerEvents="none">
          {PATTERN.map((p, i) => (
            <View
              key={i}
              style={[
                styles.patternIcon,
                { top: p.top as any, left: p.left as any },
              ]}
            >
              <Ionicons name={p.name} size={p.size} color="rgba(15,23,42,0.06)" />
            </View>
          ))}
        </View>

        {/* Brand row */}
        <View style={styles.brandRow}>
          <Text style={styles.brandWord}>takealot</Text>
          <View style={styles.brandChip}>
            <Text style={styles.brandChipText}>.com</Text>
          </View>
        </View>

        {/* Value */}
        <View style={styles.valueBlock}>
          <Text style={styles.value}>
            R<Text style={styles.valueNum}>{value}</Text>
          </Text>
          <Text style={styles.subtitle}>GIFT VOUCHER</Text>
        </View>

        {/* Decorative ribbon (bottom-left arc, faked with an oversized
            rotated square with a large border radius) */}
        <View style={styles.ribbon} pointerEvents="none" />
        <View style={styles.ribbonShadow} pointerEvents="none" />

        {/* Bottom band */}
        <View style={styles.footer}>
          <View style={styles.footerLeft}>
            <Ionicons name="ribbon-outline" size={12} color="#F5F5F5" />
            <Text style={styles.footerLabel}>FOURBUY REWARDS</Text>
          </View>
          <Text
            style={[
              styles.footerStatus,
              unlocked && styles.footerStatusOn,
            ]}
            numberOfLines={1}
          >
            {unlocked ? "READY TO REDEEM" : `UNLOCK AT ${pointsRequired} PTS`}
          </Text>
        </View>
      </LinearGradient>

      {/* Ticket perforation notches */}
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
    borderColor: "rgba(255,255,255,0.15)",
    overflow: "hidden",
    padding: spacing.lg,
    // Soft luxury shadow
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 6,
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
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    zIndex: 3,
  },
  brandWord: {
    color: "#0F172A",
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: -0.5,
    fontFamily: fonts.heading,
  },
  brandChip: {
    backgroundColor: "#0F172A",
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginLeft: 2,
    marginTop: 4,
  },
  brandChipText: {
    color: "#FFFFFF",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  valueBlock: {
    marginTop: 6,
    zIndex: 3,
  },
  value: {
    color: "#0F172A",
    fontSize: 44,
    fontWeight: "900",
    letterSpacing: -1.5,
    fontFamily: fonts.number,
    lineHeight: 46,
  },
  valueNum: {
    fontSize: 48,
    fontWeight: "900",
  },
  subtitle: {
    color: "#0F172A",
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: 3,
    marginTop: 4,
  },
  // Dark bottom band with a soft diagonal top edge (rotated dark rect
  // creates the "ribbon" effect without SVG).
  ribbon: {
    position: "absolute",
    left: -30,
    right: -30,
    bottom: -30,
    height: 90,
    backgroundColor: "#0F172A",
    transform: [{ rotate: "-6deg" }],
    zIndex: 1,
  },
  ribbonShadow: {
    position: "absolute",
    left: -30,
    right: -30,
    bottom: -20,
    height: 90,
    backgroundColor: "rgba(0,0,0,0.15)",
    transform: [{ rotate: "-8deg" }],
    zIndex: 0,
  },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    zIndex: 4,
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
  footerStatus: {
    color: "rgba(245,245,245,0.75)",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.2,
  },
  footerStatusOn: {
    color: "#FFFFFF",
  },
  // Ticket notches on the sides (mid-height circles cut into the card visually)
  notch: {
    position: "absolute",
    top: CARD_HEIGHT / 2 - 10,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.bg,
    zIndex: 5,
  },
  notchLeft: {
    left: -10,
  },
  notchRight: {
    right: -10,
  },
});

export default TakealotVoucherCard;
