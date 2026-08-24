/**
 * Give Cover — detail redirect.
 *
 * The pricing agent's cover-detail experience is intentionally
 * identical to the standard vehicle-detail page (same photos, condition,
 * recon, warranty, VIN reports, AI market analysis, live listings and
 * PDF) — with the TradeAPP Offer / admin_pricing hidden and the price
 * banner / offer history stripped by the backend. To avoid duplicating
 * a 4700-line component, we redirect to `/vehicle/[id]?cover=1`; the
 * vehicle screen keys off `?cover=1` to render a cover-placement bar
 * instead of admin controls and to skip its offer-related sections.
 */
import { useEffect } from "react";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useThemeColors } from "@/src/theme/ThemeContext";

export default function CoverDetailRedirect() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const colors = useThemeColors();
  useEffect(() => {
    if (!id) return;
    router.replace({ pathname: "/vehicle/[id]", params: { id, cover: "1" } });
  }, [id, router]);
  return (
    <View style={[styles.center, { backgroundColor: colors.background }]}>
      <ActivityIndicator color={colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
