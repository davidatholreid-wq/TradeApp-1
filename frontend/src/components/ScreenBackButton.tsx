// -----------------------------------------------------------------------------
// ScreenBackButton — floating back chevron for secondary screens.
//
// Sits absolutely-positioned in the top-left safe-area corner so it
// doesn't disturb the existing header layout of the host screen.
// Renders a subtle rounded card with a chevron; falls back to Home
// when there's no navigation history (deep-linked entry).
//
// Usage: drop `<ScreenBackButton />` as the FIRST child inside the
// screen's SafeAreaView (or any other top-level container). No other
// wiring required — it reads router + insets itself.
// -----------------------------------------------------------------------------
import React from "react";
import { View, StyleSheet, Platform } from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useThemeColors } from "@/src/theme/ThemeContext";

export type ScreenBackButtonProps = {
  /** Override the destination when there's no back-stack (default `/`). */
  fallback?: string;
};

export default function ScreenBackButton({ fallback = "/" }: ScreenBackButtonProps) {
  const colors = useThemeColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const onPress = () => {
    try {
      // expo-router doesn't expose canGoBack() on all versions — try/catch.
      // If nothing to pop, replace with the fallback (usually Home).
      // @ts-ignore  — canGoBack is present at runtime on expo-router v3+
      const canGoBack = typeof router.canGoBack === "function" ? router.canGoBack() : true;
      if (canGoBack) {
        router.back();
      } else {
        router.replace(fallback as never);
      }
    } catch {
      router.replace(fallback as never);
    }
  };

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.floatWrap,
        {
          // Sit just above the header row on both platforms. Insets
          // already handle notches / status bar.
          top: (Platform.OS === "web" ? 12 : Math.max(insets.top, 6)) + 4,
        },
      ]}
    >
      <TouchableOpacity
        testID="screen-back-button"
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel="Go back"
        style={[
          styles.btn,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
          },
        ]}
      >
        <Ionicons name="chevron-back" size={22} color={colors.text} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  floatWrap: {
    position: "absolute" as const,
    left: 8,
    zIndex: 50,
  },
  btn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    // Soft shadow so it lifts off the underlying header content.
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
});
