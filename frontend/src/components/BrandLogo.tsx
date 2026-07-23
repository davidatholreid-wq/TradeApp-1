import { useMemo } from "react";
import { Image, StyleSheet, View, StyleProp, ViewStyle, ImageStyle, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { BRAND } from "@/src/theme";
import { useTheme, type Palette } from "@/src/theme/ThemeContext";

type Props = {
  /**
   * Preset visual sizes: xs (24), sm (32), md (48), lg (72), xl (120).
   * Falls back to `md` when not provided. You can override with `style`.
   */
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  style?: StyleProp<ImageStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  testID?: string;
  /**
   * Override the automatic light/dark variant. Set `variant="dark"` on a
   * screen that's locked to a dark background regardless of the app's
   * theme mode (e.g. the login / register hero splash). Defaults to
   * following the active theme via `useTheme()`.
   */
  variant?: "auto" | "dark" | "light";
  /**
   * When true, wraps the wordmark in a touchable that navigates back to
   * the app's Home landing page. Use this on every in-app header logo
   * so the logo functions as a universal "Home" affordance (matches the
   * behaviour of a website's top-left logo).
   */
  linkToHome?: boolean;
};

const HEIGHTS: Record<NonNullable<Props["size"]>, number> = {
  // Height-driven sizing for the landscape wordmark. Values chosen so the
  // logo reads comfortably at each callsite without dominating the layout.
  xs: 22,
  sm: 30,
  md: 44,
  lg: 64,
  xl: 96,
};

// The source PNG is landscape 617×215 (aspect ~2.87:1). Height is the input;
// width is derived so the wordmark never stretches regardless of container.
const ASPECT = 617 / 215;

// Single source of truth for rendering the Fourbuy wordmark. Keep every logo
// insertion in the app routed through this component so a future rebrand is
// a one-file change.
export default function BrandLogo({ size = "md", style, containerStyle, testID, variant = "auto", linkToHome = false }: Props) {
  const { colors, mode } = useTheme();
  const router = useRouter();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const h = HEIGHTS[size];
  // Use the dark-on-white wordmark in day mode so it reads cleanly against
  // the light background. Dark mode stays with the white wordmark on black.
  // Callers can force a specific variant (e.g. `variant="dark"` on screens
  // that are always dark, like the login/register hero) to override the
  // automatic theme-driven choice.
  const effectiveMode = variant === "auto" ? mode : variant;
  const src = effectiveMode === "light" ? BRAND.logoLight : BRAND.logo;
  const inner = (
    <Image
      source={src}
      style={[{ height: h, width: h * ASPECT }, style]}
      resizeMode="contain"
      accessibilityLabel="Fourbuy Car Buying Co."
    />
  );
  if (linkToHome) {
    return (
      <TouchableOpacity
        onPress={() => {
          try {
            router.push("/(app)" as any);
          } catch {
            /* no-op */
          }
        }}
        activeOpacity={0.75}
        accessibilityRole="link"
        accessibilityLabel="Go to Fourbuy home"
        style={[styles.wrap, containerStyle]}
        testID={testID ?? "brand-logo-home-link"}
        hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
      >
        {inner}
      </TouchableOpacity>
    );
  }
  return (
    <View style={[styles.wrap, containerStyle]} testID={testID ?? "brand-logo"}>
      {inner}
    </View>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center" },
});
