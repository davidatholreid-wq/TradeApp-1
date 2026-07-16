import { Image, StyleSheet, View, StyleProp, ViewStyle, ImageStyle } from "react-native";
import { BRAND } from "@/src/theme";

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
  // Values include a small allowance for the built-in black padding in the
  // 1:1 source PNG — the visible wordmark ends up roughly 70% of these.
  xs: 44,
  sm: 60,
  md: 84,
  lg: 120,
  xl: 180,
};

// The source PNG is 1:1 with black padding around the centred wordmark, so
// we render it as a square and let resizeMode="contain" handle scaling.
const ASPECT = 1;

// Single source of truth for rendering the Fourbuy wordmark. Keep every logo
// insertion in the app routed through this component so a future rebrand is
// a one-file change.
export default function BrandLogo({ size = "md", style, containerStyle, testID }: Props) {
  const h = HEIGHTS[size];
  return (
    <View style={[styles.wrap, containerStyle]} testID={testID ?? "brand-logo"}>
      <Image
        source={BRAND.logo}
        style={[{ height: h, width: h * ASPECT }, style]}
        resizeMode="contain"
        accessibilityLabel="Fourbuy Car Buying Co."
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center" },
});
