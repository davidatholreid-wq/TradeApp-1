// -----------------------------------------------------------------------------
// Suppliers — standalone Recon Suppliers screen. Reached from the Home
// screen tile. Available to any user on the dealership; add/edit/delete
// controls are hidden for non-managerial users (backend enforces the
// same guard).
// -----------------------------------------------------------------------------
import React, { useMemo } from "react";
import { View, Text, StyleSheet, ScrollView, Platform, useWindowDimensions } from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { spacing, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { useAuth } from "@/src/context/AuthContext";
import SupplierListSection from "@/src/components/profile/SupplierListSection";

export default function SuppliersScreen() {
  const colors = useThemeColors();
  const { user } = useAuth();
  const router = useRouter();
  const tabBarHeight = useBottomTabBarHeight();
  const { width: winW } = useWindowDimensions();
  const isWide = Platform.OS === "web" && winW >= 900;
  const styles = useMemo(() => makeStyles(colors, isWide), [colors, isWide]);
  const canEdit = !!(user as any)?.is_pricing_agent && user?.role !== "admin";

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity
          testID="suppliers-back"
          onPress={() => router.back()}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.eyebrow}>DEALERSHIP CATALOG</Text>
          <Text style={styles.title}>Recon Suppliers</Text>
        </View>
      </View>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: tabBarHeight + spacing.lg }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.wrap}>
          <SupplierListSection colors={colors} canEdit={canEdit} mode="page" />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(colors: Palette, isWide: boolean) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: colors.bg,
    },
    header: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.card,
    },
    backBtn: {
      width: 40,
      height: 40,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    eyebrow: {
      color: colors.textSecondary,
      fontSize: 10,
      fontWeight: "800" as const,
      letterSpacing: 1.2,
    },
    title: {
      color: colors.text,
      fontSize: 20,
      fontWeight: "800" as const,
      fontFamily: fonts.heading,
    },
    scroll: {
      paddingVertical: spacing.md,
    },
    wrap: {
      maxWidth: isWide ? 900 : undefined,
      width: "100%" as const,
      alignSelf: "center" as const,
      paddingHorizontal: spacing.md,
    },
  });
}
