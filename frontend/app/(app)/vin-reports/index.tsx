/**
 * VIN Reports — landing screen.
 *
 * Shows every VIN-linked report the caller has ordered, newest first,
 * with a prominent "New Report" CTA at the top. Every user (dealer,
 * pricing agent, admin) can access this screen — it's not gated
 * behind Managerial / pricing-agent permissions.
 *
 * Tapping a row shows the order's payload (or a friendly failed
 * state). Tapping "New Report" routes into the make → VIN → picker
 * flow at `/vin-reports/new`.
 */
import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import ScreenBackButton from "@/src/components/ScreenBackButton";
import { spacing, radius } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { apiFetch } from "@/src/api";

type VinReportOrder = {
  id: string;
  make?: string;
  vin?: string;
  report_type?: string;
  report_label?: string;
  status?: "pending" | "completed" | "failed";
  cost_zar?: number;
  ordered_at?: string;
  ordered_by_name?: string;
  error?: string | null;
};

const REPORT_TYPE_ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  vin_history: "shield-checkmark",
  bimmervin: "car-sport",
  mbtools: "car-sport",
  outvin: "document-text",
};

const REPORT_TYPE_TINT: Record<string, string> = {
  vin_history: "#F97316",
  bimmervin: "#3B82F6",
  mbtools: "#3B82F6",
  outvin: "#22C55E",
};

export default function VinReportsScreen() {
  const colors = useThemeColors();
  const router = useRouter();
  const styles = makeStyles(colors);
  const [orders, setOrders] = useState<VinReportOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch("/api/vin-reports/mine");
      setOrders(Array.isArray(r?.orders) ? r.orders : []);
    } catch (e) {
      // Non-fatal — show the empty state.
      console.warn("vin-reports load failed:", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const renderRow = (o: VinReportOrder) => {
    const tint = REPORT_TYPE_TINT[o.report_type || ""] || colors.primary;
    const icon = REPORT_TYPE_ICON[o.report_type || ""] || "document-text";
    const statusColour =
      o.status === "completed" ? colors.success :
      o.status === "failed"    ? colors.danger  :
      colors.warning;
    const dateStr = o.ordered_at ? new Date(o.ordered_at).toLocaleString("en-ZA", {
      dateStyle: "medium", timeStyle: "short",
    } as any) : "";
    return (
      <TouchableOpacity
        key={o.id}
        testID={`vin-report-row-${o.id}`}
        style={styles.orderRow}
        onPress={() => router.push({ pathname: "/(app)/vin-reports/new", params: { orderId: o.id } } as any)}
        accessibilityRole="button"
        accessibilityLabel={`View ${o.report_label} for ${o.vin}`}
        activeOpacity={0.85}
      >
        <View style={[styles.orderIconChip, { backgroundColor: tint + "22", borderColor: tint + "66" }]}>
          <Ionicons name={icon} size={22} color={tint} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.orderTitle} numberOfLines={1}>
            {o.report_label || o.report_type}
          </Text>
          <Text style={styles.orderSub} numberOfLines={1}>
            {(o.make || "").toUpperCase()} · VIN {o.vin}
          </Text>
          <Text style={styles.orderMeta} numberOfLines={1}>{dateStr}</Text>
        </View>
        <View style={{ alignItems: "flex-end", gap: 4 }}>
          <View style={[styles.statusChip, { backgroundColor: statusColour + "22", borderColor: statusColour + "77" }]}>
            <Text style={[styles.statusChipTxt, { color: statusColour }]}>
              {(o.status || "").toUpperCase()}
            </Text>
          </View>
          <Text style={styles.costTxt}>
            {o.cost_zar ? `R${o.cost_zar}` : "Free"}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={["top"]}>
      <ScreenBackButton />
      <ScrollView
        contentContainerStyle={{ padding: spacing.md, paddingBottom: 96 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); load(); }}
            tintColor={colors.primary}
          />
        }
      >
        {/* Header */}
        <Text style={styles.title}>VIN Reports</Text>
        <Text style={styles.subtitle}>
          Order OEM factory options & VIN accident-history reports for any vehicle — no full valuation needed.
        </Text>

        {/* New Report CTA */}
        <TouchableOpacity
          testID="vin-reports-new"
          style={styles.newBtn}
          onPress={() => router.push("/(app)/vin-reports/new" as any)}
          activeOpacity={0.9}
        >
          <Ionicons name="add-circle" size={22} color={colors.onPrimary} />
          <Text style={styles.newBtnTxt}>Order a New Report</Text>
        </TouchableOpacity>

        {/* Info panel — what's available */}
        <View style={[styles.infoPanel, { borderColor: colors.border, backgroundColor: colors.card }]}>
          <Text style={styles.infoTitle}>Available reports</Text>
          <View style={styles.infoRow}>
            <View style={[styles.infoDot, { backgroundColor: "#F97316" }]} />
            <Text style={styles.infoLabel}>Accident & Claim History</Text>
            <Text style={styles.infoCost}>R100</Text>
          </View>
          <View style={styles.infoRow}>
            <View style={[styles.infoDot, { backgroundColor: "#3B82F6" }]} />
            <Text style={styles.infoLabel}>BMW Factory Options · Mercedes-Benz Datacard</Text>
            <Text style={styles.infoCost}>Free</Text>
          </View>
          <View style={styles.infoRow}>
            <View style={[styles.infoDot, { backgroundColor: "#22C55E" }]} />
            <Text style={styles.infoLabel}>OEM Spec Decode (30+ makes)</Text>
            <Text style={styles.infoCost}>R20</Text>
          </View>
        </View>

        {/* Orders list */}
        <View style={{ marginTop: spacing.lg }}>
          <Text style={styles.sectionHead}>Your orders</Text>
          {loading ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.lg }} />
          ) : orders.length === 0 ? (
            <View style={[styles.emptyBox, { borderColor: colors.border }]}>
              <Ionicons name="document-text-outline" size={30} color={colors.textDisabled} />
              <Text style={[styles.emptyTitle, { color: colors.text }]}>No reports yet</Text>
              <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>
                Tap &quot;Order a New Report&quot; above to run your first VIN report. Every report you order is stored here.
              </Text>
            </View>
          ) : (
            orders.map(renderRow)
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "800",
    letterSpacing: -0.4,
    marginBottom: 4,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: spacing.md,
  },
  newBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 14,
    marginBottom: spacing.md,
  },
  newBtnTxt: {
    color: colors.onPrimary,
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  infoPanel: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 8,
  },
  infoTitle: {
    color: colors.textSecondary,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    fontWeight: "800",
    marginBottom: 4,
  },
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  infoDot: {
    width: 8, height: 8, borderRadius: 4,
  },
  infoLabel: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
    fontWeight: "600",
  },
  infoCost: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "800",
  },
  sectionHead: {
    color: colors.textSecondary,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    fontWeight: "800",
    marginBottom: spacing.sm,
  },
  orderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    marginBottom: 8,
  },
  orderIconChip: {
    width: 44, height: 44, borderRadius: 22,
    borderWidth: 1,
    alignItems: "center", justifyContent: "center",
  },
  orderTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: -0.1,
  },
  orderSub: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  orderMeta: {
    color: colors.textDisabled,
    fontSize: 11,
    marginTop: 2,
  },
  statusChip: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  statusChipTxt: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  costTxt: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
  },
  emptyBox: {
    borderWidth: 1,
    borderRadius: radius.md,
    borderStyle: "dashed" as const,
    padding: spacing.lg,
    alignItems: "center",
    gap: 8,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: "800",
    marginTop: 6,
  },
  emptyBody: {
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center" as const,
  },
});
