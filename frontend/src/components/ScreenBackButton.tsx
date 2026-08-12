// -----------------------------------------------------------------------------
// ScreenBackButton — consistent back-nav bar for secondary screens.
//
// Renders as an in-flow row (48pt tall) at the top of the host screen
// so it NEVER overlaps existing headers or titles. Every screen using
// it therefore has a predictable 48pt "back strip" above its own
// content, giving a uniform look across the app.
//
// Falls back to Home when there's no back-stack (deep-linked entry).
// -----------------------------------------------------------------------------
import React from "react";
import { View, StyleSheet } from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
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

  const onPress = () => {
    try {
      // @ts-ignore  — canGoBack is present at runtime on expo-router v3+
      const canGoBack = typeof router.canGoBack === "function" ? router.canGoBack() : true;
      if (canGoBack) router.back();
      else router.replace(fallback as never);
    } catch {
      router.replace(fallback as never);
    }
  };

  return (
    <View style={styles.bar}>
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
        <Ionicons name="chevron-back" size={20} color={colors.text} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    // In-flow row so the host screen's real header sits BELOW it.
    // Uniform 48pt height across every screen for consistency.
    height: 48,
    justifyContent: "center" as const,
    paddingHorizontal: 8,
  },
  btn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
});
