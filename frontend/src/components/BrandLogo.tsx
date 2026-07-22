import { useMemo } from "react";
import { Image, StyleSheet, View, StyleProp, ViewStyle, ImageStyle } from "react-native";
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
export default function BrandLogo({ size = "md", style, containerStyle, testID }: Props) {
  const { colors, mode } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const h = HEIGHTS[size];
  // Use the dark-on-white wordmark in day mode so it reads cleanly against
  // the light background. Dark mode stays with the white wordmark on black.
  const src = mode === "light" ? BRAND.logoLight : BRAND.logo;
  return (
    <View style={[styles.wrap, containerStyle]} testID={testID ?? "brand-logo"}>
      <Image
        source={src}
        style={[{ height: h, width: h * ASPECT }, style]}
        resizeMode="contain"
        accessibilityLabel="Fourbuy Car Buying Co."
      />
    </View>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center" },
});
