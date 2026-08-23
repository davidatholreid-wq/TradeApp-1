/**
 * Deal Outcomes report screen.
 *
 * Opened from the Home dashboard "Deal Outcomes" tile. Shows the
 * dealership's priced submissions from the last 90 days, grouped by
 * outcome bucket (Pending · Deal Done · No Deal), with a Deal-Done vs
 * No-Deal percentage split (pending excluded from the denominator per
 * product spec).
 *
 * Pills at the top let the user filter which bucket they're looking
 * at. Each row is tappable → the vehicle detail (where the dealer can
 * flip the outcome).
 */

import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Image,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors } from "@/src/theme/ThemeContext";
import { apiFetch } from "@/src/api";
import { useAuth } from "@/src/context/AuthContext";

type Row = {
  id: string;
  reference?: string;
  make_name?: string;
  model_name?: string;
  derivative_name?: string;
  year?: number;
  mileage?: number;
  colour?: string;
  price?: number | null;
  priced_at?: string;
  front_photo?: string | null;
  dealer_offer_zar?: number | null;
  sold?: boolean;
  sold_price_zar?: number | null;
  profit_zar?: number | null;
  auto_expired?: boolean;
  expired_at?: string | null;
};

type Report = {
  period_days: number;
  counts: { pending: number; deal_done: number; no_deal: number };
  percentages: { deal_done: number; no_deal: number };
  pending: Row[];
  deal_done: Row[];
  no_deal: Row[];
};

type Bucket = "pending" | "deal_done" | "no_deal";

export default function DealOutcomesScreen() {
  const colors = useThemeColors();
  const router = useRouter();
  const styles = makeStyles(colors);
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  // Optional `?bucket=deal_done` (or `pending`/`no_deal`) query param lets
  // the dashboard tile deep-link straight into the relevant filter.
  const { bucket: bucketParam } = useLocalSearchParams<{ bucket?: string }>();
  const initialBucket: Bucket =
    bucketParam === "deal_done" || bucketParam === "no_deal" ? (bucketParam as Bucket) : "pending";
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [bucket, setBucket] = useState<Bucket>(initialBucket);

  // Keep the pill selection in sync if the user navigates back to the
  // dashboard and taps a different bucket without unmounting the route.
  useEffect(() => {
    if (bucketParam === "pending" || bucketParam === "deal_done" || bucketParam === "no_deal") {
      setBucket(bucketParam as Bucket);
    }
  }, [bucketParam]);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch("/api/stats/deal-outcomes/list");
      setReport(r as Report);
    } catch {
      // Non-fatal; the empty-state falls through.
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const rows = report ? report[bucket] : [];
  const counts = report?.counts || { pending: 0, deal_done: 0, no_deal: 0 };
  const pct = report?.percentages || { deal_done: 0, no_deal: 0 };
  const answered = counts.deal_done + counts.no_deal;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => {
            // @ts-ignore  — canGoBack is present at runtime on expo-router v3+
            const canGo = typeof router.canGoBack === "function" ? router.canGoBack() : true;
            if (canGo) router.back();
            else router.replace("/" as never);
          }}
          style={styles.backBtn}
          activeOpacity={0.85}
        >
          <Ionicons name="chevron-back" size={22} color={colors.text} />
          <Text style={[styles.backBtnTxt, { color: colors.text }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Deal Outcomes</Text>
        <Text style={styles.subtitle}>
          {isAdmin ? "All dealerships" : "Your dealership"} · last 90 days
        </Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xl }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor={colors.primary}
            />
          }
        >
          {/* Percentage split card — deal-done vs no-deal of answered
              submissions. Pending is excluded from the denominator so
              early days with only 1 answered sub don't skew to 100%
              deal-done + a bunch of pending. */}
          <View style={[styles.pctCard, { backgroundColor: colors.paper, borderColor: colors.border }]}>
            <Text style={[styles.pctEyebrow, { color: colors.textSecondary }]}>
              CONVERSION · {answered} answered
            </Text>
            <View style={styles.pctRow}>
              <View style={styles.pctColLeft}>
                <Text style={[styles.pctNum, { color: colors.success }]}>{pct.deal_done}%</Text>
                <Text style={[styles.pctLabel, { color: colors.textSecondary }]}>DEAL DONE</Text>
              </View>
              <View style={styles.pctColRight}>
                <Text style={[styles.pctNum, { color: "#DC2626" }]}>{pct.no_deal}%</Text>
                <Text style={[styles.pctLabel, { color: colors.textSecondary }]}>NO DEAL</Text>
              </View>
            </View>
            {/* Horizontal split bar — visual of the same %. */}
            <View style={[styles.pctBar, { backgroundColor: colors.border }]}>
              <View
                style={{
                  width: `${pct.deal_done}%`,
                  height: "100%",
                  backgroundColor: colors.success,
                }}
              />
              <View
                style={{
                  width: `${pct.no_deal}%`,
                  height: "100%",
                  backgroundColor: "#DC2626",
                }}
              />
            </View>
            <Text style={[styles.pctFootnote, { color: colors.textDisabled }]}>
              Pending submissions are excluded until an outcome is recorded.
            </Text>
          </View>

          {/* Pills */}
          <View style={styles.pillsRow}>
            {(
              [
                { key: "pending", label: "Pending", count: counts.pending, tint: "#E5E7EB" },
                { key: "deal_done", label: "Deal Done", count: counts.deal_done, tint: colors.success },
                { key: "no_deal", label: "No Deal", count: counts.no_deal, tint: "#DC2626" },
              ] as { key: Bucket; label: string; count: number; tint: string }[]
            ).map((p) => {
              const active = bucket === p.key;
              return (
                <TouchableOpacity
                  key={p.key}
                  onPress={() => setBucket(p.key)}
                  activeOpacity={0.85}
                  style={[
                    styles.pill,
                    {
                      borderColor: active ? p.tint : colors.border,
                      backgroundColor: active ? p.tint + "22" : "transparent",
                    },
                  ]}
                  testID={`bucket-pill-${p.key}`}
                >
                  <Text
                    style={[styles.pillTxt, { color: active ? p.tint : colors.textSecondary }]}
                    numberOfLines={1}
                  >
                    {p.label}
                  </Text>
                  <View style={[styles.pillBadge, { backgroundColor: active ? p.tint : colors.border }]}>
                    <Text style={[styles.pillBadgeTxt, { color: active ? "#0B0B0B" : colors.text }]}>
                      {p.count}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Rows */}
          {rows.length === 0 ? (
            <View style={[styles.empty, { borderColor: colors.border }]}>
              <Ionicons name="checkmark-done-outline" size={32} color={colors.textDisabled} />
              <Text style={{ color: colors.textSecondary, textAlign: "center", marginTop: spacing.xs }}>
                No submissions in this bucket for the last 90 days.
              </Text>
            </View>
          ) : (
            rows.map((row) => (
              <TouchableOpacity
                key={row.id}
                onPress={() => router.push({ pathname: "/(app)/vehicle/[id]", params: { id: row.id, from: "/(app)/deal-outcomes" } } as never)}
                activeOpacity={0.9}
                style={[styles.row, { borderColor: colors.border, backgroundColor: colors.paper }]}
                testID={`outcome-row-${row.reference || row.id}`}
              >
                {row.front_photo ? (
                  <Image source={{ uri: row.front_photo }} style={styles.thumb} resizeMode="cover" />
                ) : (
                  <View style={[styles.thumb, { backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" }]}>
                    <Ionicons name="car-outline" size={22} color={colors.textDisabled} />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>
                    {row.year} {row.make_name}
                  </Text>
                  {row.derivative_name || row.model_name ? (
                    <Text style={[styles.rowSub, { color: colors.textSecondary }]} numberOfLines={2}>
                      {row.derivative_name || row.model_name}
                    </Text>
                  ) : null}
                  {row.reference ? (
                    <Text style={[styles.rowMeta, { color: colors.textDisabled }]}>{row.reference}</Text>
                  ) : null}
                  {row.auto_expired ? (
                    <View style={styles.autoExpiredChip} testID={`auto-expired-${row.reference || row.id}`}>
                      <Ionicons name="time-outline" size={11} color="#B45309" />
                      <Text style={styles.autoExpiredTxt}>Auto-expired · tap to override</Text>
                    </View>
                  ) : null}
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  {bucket === "deal_done" && row.profit_zar != null ? (
                    <Text style={[styles.rowRight, { color: row.profit_zar >= 0 ? colors.success : "#DC2626" }]}>
                      {row.profit_zar >= 0 ? "+" : ""}R {row.profit_zar.toLocaleString()}
                    </Text>
                  ) : row.price != null ? (
                    <Text style={[styles.rowRight, { color: colors.text }]}>
                      R {row.price.toLocaleString()}
                    </Text>
                  ) : null}
                  <Ionicons name="chevron-forward" size={18} color={colors.textDisabled} />
                </View>
              </TouchableOpacity>
            ))
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const makeStyles = (colors: any) =>
  StyleSheet.create({
    header: {
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
      paddingBottom: spacing.md,
      gap: 4,
    },
    backBtn: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      paddingVertical: 4,
      gap: 2,
    },
    backBtnTxt: { fontSize: 15, fontWeight: "600" },
    title: {
      color: colors.text,
      fontSize: 24,
      fontWeight: "900",
      marginTop: 4,
      letterSpacing: -0.4,
    },
    subtitle: { color: colors.textSecondary, fontSize: 13, fontWeight: "600" },
    center: { flex: 1, alignItems: "center", justifyContent: "center" },
    pctCard: {
      borderRadius: radius.lg,
      borderWidth: 1,
      padding: spacing.md,
      marginBottom: spacing.md,
      gap: 10,
    },
    pctEyebrow: { fontSize: 11, fontWeight: "900", letterSpacing: 1.2 },
    pctRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" },
    pctColLeft: { alignItems: "flex-start" },
    pctColRight: { alignItems: "flex-end" },
    pctNum: { fontSize: 34, fontWeight: "900", letterSpacing: -1, fontFamily: fonts.number },
    pctLabel: { fontSize: 11, fontWeight: "800", letterSpacing: 1 },
    pctBar: { height: 8, borderRadius: 4, overflow: "hidden", flexDirection: "row" },
    pctFootnote: { fontSize: 11, fontStyle: "italic" },
    pillsRow: {
      flexDirection: "row",
      gap: 8,
      marginBottom: spacing.md,
    },
    pill: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 4,
      paddingVertical: 8,
      paddingHorizontal: 6,
      borderRadius: 999,
      borderWidth: 1,
    },
    pillTxt: { fontSize: 12, fontWeight: "800", letterSpacing: 0.1 },
    pillBadge: {
      minWidth: 22,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 999,
      alignItems: "center",
      justifyContent: "center",
    },
    pillBadgeTxt: { fontSize: 11, fontWeight: "900" },
    empty: {
      borderWidth: 1,
      borderRadius: radius.lg,
      padding: spacing.xl,
      alignItems: "center",
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      padding: 12,
      borderRadius: radius.lg,
      borderWidth: 1,
      marginBottom: 10,
    },
    thumb: { width: 66, height: 50, borderRadius: 8, backgroundColor: "#1a1a1a" },
    rowTitle: { fontSize: 15, fontWeight: "800" },
    rowSub: { fontSize: 12, fontWeight: "600", marginTop: 2 },
    rowMeta: { fontSize: 10, fontWeight: "700", letterSpacing: 0.3, marginTop: 2 },
    rowRight: { fontSize: 14, fontWeight: "900", fontFamily: fonts.number },
    autoExpiredChip: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      gap: 4,
      marginTop: 4,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
      backgroundColor: "#FEF3C7",
    },
    autoExpiredTxt: {
      color: "#B45309",
      fontSize: 10,
      fontWeight: "800",
      letterSpacing: 0.2,
    },
  });
