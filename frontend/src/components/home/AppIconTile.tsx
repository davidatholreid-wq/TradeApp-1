// -----------------------------------------------------------------------------
// AppIconTile — iOS-inspired "squircle" navigation tile.
//
// Renders a compact tap-target that mimics the look-and-feel of a
// Home-screen app icon:
//   • Coloured rounded-square (border-radius ≈ 22% of size — the classic
//     "squircle" ratio Apple uses) with a subtle gradient overlay for
//     depth.
//   • Large white icon centred within the squircle.
//   • Small label BELOW the squircle so the coloured tile stays clean.
//   • Optional badge in the top-right corner (unread-style pill).
//   • A short scale-down animation on tap for tactile feedback before
//     navigating.
//
// Sizing is driven by the grid parent — the tile is 100% wide on its
// column and enforces a 1:1 aspect ratio (icon area) so a 3-up mobile
// grid and a 6-up wide grid both render perfect squares.
// -----------------------------------------------------------------------------
import React, { useCallback, useMemo } from "react";
import { View, Text, StyleSheet, Platform } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { spacing, fonts } from "@/src/theme";
import type { Palette } from "@/src/theme/ThemeContext";

export type AppIconTileProps = {
  label: string;
  hint?: string;
  icon: keyof typeof Ionicons.glyphMap;
  tint: string;
  badge?: string | number;
  onPress: () => void;
  colors: Palette;
  testID?: string;
};

export default function AppIconTile({
  label,
  hint,
  icon,
  tint,
  badge,
  onPress,
  colors,
  testID,
}: AppIconTileProps) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const scale = useSharedValue(1);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  // Fire the navigation IMMEDIATELY on tap so the screen transition
  // starts without waiting for the pop-back spring to settle. The scale
  // "pulse" animation runs in the background purely as tactile feedback
  // and never blocks router.push. Haptic tick is provided by the
  // `TouchableOpacity` wrapper from HapticButtons.
  const handleTap = useCallback(() => {
    scale.value = withSequence(
      withTiming(0.92, { duration: 60 }),
      withSpring(1, { damping: 14, stiffness: 220 }),
    );
    onPress();
  }, [onPress, scale]);

  return (
    <View style={styles.wrap} testID={testID}>
      <TouchableOpacity
        activeOpacity={0.9}
        onPress={handleTap}
        style={styles.iconWrap}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        <Animated.View style={[styles.iconWrap, animStyle]}>
          {/* Squircle icon — gradient tinted, drop-shadowed, white icon */}
          <View style={styles.squircle}>
          <LinearGradient
            colors={[shade(tint, 1.2), tint, shade(tint, 0.85)]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          {/* soft top-left highlight for the glassy app-icon look */}
          <LinearGradient
            colors={["rgba(255,255,255,0.28)", "rgba(255,255,255,0)"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0.6, y: 0.6 }}
            style={StyleSheet.absoluteFill}
          />
          <Ionicons name={icon} size={38} color="#fff" />

          {/* Badge — unread-style pill in the top-right corner. */}
          {badge != null && String(badge).length > 0 ? (
            <View style={styles.badge} testID={testID ? `${testID}-badge` : undefined}>
              <Text style={styles.badgeText} numberOfLines={1}>{String(badge)}</Text>
            </View>
          ) : null}
        </View>
        </Animated.View>
      </TouchableOpacity>
      <Text style={styles.label} numberOfLines={2}>{label}</Text>
      {hint ? (
        <Text style={styles.hint} numberOfLines={2}>{hint}</Text>
      ) : null}
    </View>
  );
}

// -----------------------------------------------------------------------------
// Tiny colour helper — lightens/darkens a hex colour by multiplying each
// channel. Used to synthesise the top-left highlight and bottom-right
// shadow of the squircle without needing a per-tile palette.
// -----------------------------------------------------------------------------
function shade(hex: string, factor: number): string {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return hex;
  const r = Math.min(255, Math.max(0, Math.round(parseInt(clean.slice(0, 2), 16) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(parseInt(clean.slice(2, 4), 16) * factor)));
  const b = Math.min(255, Math.max(0, Math.round(parseInt(clean.slice(4, 6), 16) * factor)));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function makeStyles(colors: Palette) {
  return StyleSheet.create({
    wrap: {
      alignItems: "center" as const,
      gap: 6,
      // Fill the parent grid cell. The squircle uses aspectRatio so it
      // sizes with the cell width.
      width: "100%" as const,
    },
    iconWrap: {
      // Match parent cell width so the squircle's `width: 100%` has a
      // meaningful basis; without this the reanimated view collapses to
      // its intrinsic content width and the icon shrinks to ~55px.
      width: "100%" as const,
      aspectRatio: 1,
    },
    squircle: {
      width: "100%" as const,
      aspectRatio: 1,
      // 22% radius matches Apple's rounded-square curvature. Uses a
      // reasonable fixed value that reads as a squircle at typical tile
      // sizes (60-160 px).
      borderRadius: 22 as any,
      overflow: "hidden" as const,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      // Elevated card shadow so the tiles feel like they float off the bg.
      ...Platform.select({
        ios: {
          shadowColor: "#000",
          shadowOpacity: 0.22,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 4 },
        },
        android: { elevation: 4 },
        web: {
          // RN Web bakes shadowX props into boxShadow but the composite
          // still needs explicit fallback for older Chromium builds.
          shadowColor: "#000",
          shadowOpacity: 0.22,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 4 },
        },
      }),
    },
    label: {
      color: colors.text,
      fontSize: 13,
      fontWeight: "700" as const,
      fontFamily: fonts.heading,
      textAlign: "center" as const,
      letterSpacing: 0.1,
      marginTop: 2,
    },
    hint: {
      color: colors.textSecondary,
      fontSize: 10.5,
      lineHeight: 13,
      textAlign: "center" as const,
      paddingHorizontal: 2,
    },
    badge: {
      position: "absolute" as const,
      top: 6,
      right: 6,
      minWidth: 22,
      height: 22,
      borderRadius: 11,
      paddingHorizontal: 6,
      backgroundColor: "#EF4444", // red-500 (iOS-style unread badge)
      borderWidth: 2,
      borderColor: "#fff",
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    badgeText: {
      color: "#fff",
      fontSize: 10,
      fontWeight: "800" as const,
      letterSpacing: 0.3,
    },
  });
}

// Grid helpers -----------------------------------------------------------------
// The parent decides column count based on viewport width. Rather than
// exporting a helper, we keep the choice inline where the grid is
// rendered so a future redesign only touches one file.
// -----------------------------------------------------------------------------
export const APP_ICON_TILE_GAP = spacing.md;
