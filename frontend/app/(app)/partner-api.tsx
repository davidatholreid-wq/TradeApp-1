/**
 * Mobile route that surfaces the "Partner API" cockpit on the phone
 * for admin users. Reuses the existing `AdminPartnerApiScreen`
 * component (which already lives inside the desktop Admin Cockpit)
 * so the mobile view and the desktop view stay in perfect sync — a
 * single source of truth for partner-client management.
 *
 * The component itself handles all the plumbing (list, create, rotate,
 * revoke, usage). We just wrap it in the standard mobile chrome:
 * SafeAreaView + a back button + a screen title.
 */
import { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import ScreenBackButton from "@/src/components/ScreenBackButton";
import AdminPartnerApiScreen from "@/src/components/AdminPartnerApiScreen";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { spacing, fonts } from "@/src/theme";

export default function PartnerApiRoute() {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <ScreenBackButton />
        <Text style={styles.title}>Partner API</Text>
        <View style={{ width: 32 }} />
      </View>
      {/* The screen component takes it from here — grid of clients,
          create/rotate/revoke modals and usage drilldowns. */}
      <AdminPartnerApiScreen />
    </SafeAreaView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
    backgroundColor: colors.paper,
  },
  title: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "800",
    fontFamily: fonts.heading,
    letterSpacing: 0.3,
  },
});
