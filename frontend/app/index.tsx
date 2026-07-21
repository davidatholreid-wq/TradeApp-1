import { useMemo } from "react";
import { View, ActivityIndicator, StyleSheet } from "react-native";

import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";

export default function Index() {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.container} testID="splash-screen">
      <ActivityIndicator size="large" color={colors.primary} />
    </View>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
});
