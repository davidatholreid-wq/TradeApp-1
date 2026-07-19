import { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeTabBarHeight } from "@/src/utils/useSafeTabBarHeight";
import { colors, spacing, radius, fonts } from "@/src/theme";
import { apiFetch } from "@/src/api";

type BillingItem = {
  id: string;
  reference?: string;
  vehicle: string;
  price?: number;
  priced_at: string;
  created_at: string;
  billable: boolean;
};

type BillingReportItem = {
  type: string;
  name: string;
  cost_zar: number;
  status: string;
  ordered_at: string;
  submission_id: string;
  vin?: string;
};

type BillingRow = {
  dealer_id: string;
  dealer_name: string;
  dealer_email: string;
  company_name: string;
  active: boolean;
  archived?: boolean;
  archived_at?: string | null;
  priced_count: number;
  billable_count: number;
  amount_zar: number;
  submission_amount_zar?: number;
  report_count?: number;
  report_amount_zar?: number;
  report_items?: BillingReportItem[];
  items: BillingItem[];
};

type BillingResponse = {
  month: string; // YYYY-MM
  fee_zar: number;
  sla_hours: number;
  rows: BillingRow[];
  totals: {
    priced_count: number;
    billable_count: number;
    amount_zar: number;
    submission_amount_zar?: number;
    report_count?: number;
    report_amount_zar?: number;
  };
};

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map((n) => parseInt(n, 10));
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map((n) => parseInt(n, 10));
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

export default function BillingScreen() {
  const tabBarHeight = useSafeTabBarHeight();
  const today = new Date();
  const currentYm = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;

  const [month, setMonth] = useState<string>(currentYm);
  const [data, setData] = useState<BillingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(
    async (m: string) => {
      try {
        const res = await apiFetch(`/api/admin/billing?month=${m}`);
        setData(res);
      } catch (e) {
        console.log(e);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    []
  );

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load(month);
    }, [load, month])
  );

  const totals = data?.totals || { priced_count: 0, billable_count: 0, amount_zar: 0 };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Billing</Text>
          <Text style={styles.sub}>R{data?.fee_zar ?? 50} incl. VAT · SLA {data?.sla_hours ?? 24}h</Text>
        </View>
      </View>

      <View style={styles.monthRow}>
        <TouchableOpacity
          testID="billing-prev-month"
          onPress={() => setMonth((m) => shiftMonth(m, -1))}
          style={styles.monthNav}
        >
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.monthLabel}>{monthLabel(month)}</Text>
        <TouchableOpacity
          testID="billing-next-month"
          onPress={() => setMonth((m) => shiftMonth(m, 1))}
          style={styles.monthNav}
          disabled={month >= currentYm}
        >
          <Ionicons
            name="chevron-forward"
            size={20}
            color={month >= currentYm ? colors.textDisabled : colors.text}
          />
        </TouchableOpacity>
      </View>

      <View style={styles.totalsRow}>
        <View style={styles.totalCard}>
          <Text style={styles.totalLabel}>PRICED</Text>
          <Text style={styles.totalValue}>{totals.priced_count}</Text>
        </View>
        <View style={styles.totalCard}>
          <Text style={styles.totalLabel}>REPORTS</Text>
          <Text style={[styles.totalValue, { color: colors.neon }]}>
            {totals.report_count ?? 0}
          </Text>
        </View>
        <View style={[styles.totalCard, styles.totalCardAccent]}>
          <Text style={styles.totalLabel}>TOTAL DUE</Text>
          <Text style={[styles.totalValue, { color: colors.neon }]}>
            R {totals.amount_zar.toFixed(2)}
          </Text>
        </View>
      </View>

      {/* Compact submissions vs reports breakdown, only when there's report activity */}
      {(totals.report_count ?? 0) > 0 ? (
        <View style={styles.totalsBreakdown}>
          <Text style={styles.breakdownText}>
            Submissions <Text style={styles.breakdownValue}>R {(totals.submission_amount_zar ?? 0).toFixed(2)}</Text>
            {"  ·  "}
            VIN Reports <Text style={styles.breakdownValue}>R {(totals.report_amount_zar ?? 0).toFixed(2)}</Text>
          </Text>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingBottom: tabBarHeight + spacing.md }]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load(month);
              }}
              tintColor={colors.primary}
            />
          }
        >
          {(data?.rows || []).length === 0 ? (
            <View style={styles.emptyBox}>
              <Ionicons name="cash-outline" size={54} color={colors.textDisabled} />
              <Text style={styles.emptyTitle}>Nothing billable this month</Text>
              <Text style={styles.emptyText}>
                Vehicles priced within 24 hours of submission will appear here.
              </Text>
            </View>
          ) : null}

          {(data?.rows || []).map((row) => (
            <View key={row.dealer_id} style={styles.dealerCard} testID={`billing-row-${row.dealer_id}`}>
              <TouchableOpacity
                style={styles.dealerHead}
                onPress={() =>
                  setExpanded((e) => ({ ...e, [row.dealer_id]: !e[row.dealer_id] }))
                }
                activeOpacity={0.85}
              >
                <View style={{ flex: 1 }}>
                  <View style={styles.nameLine}>
                    <Text style={styles.dealerName}>{row.dealer_name || "(deleted dealer)"}</Text>
                    {row.archived ? (
                      <View style={styles.archivedPill}>
                        <Text style={styles.archivedPillText}>ARCHIVED</Text>
                      </View>
                    ) : !row.active ? (
                      <View style={styles.suspendPill}>
                        <Text style={styles.suspendPillText}>SUSPENDED</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.dealerCompany}>{row.company_name}</Text>
                  <Text style={styles.dealerEmail}>{row.dealer_email}</Text>
                </View>
                <View style={styles.amountBox}>
                  <Text style={styles.amountValue}>R {row.amount_zar.toFixed(2)}</Text>
                  <Text style={styles.amountCaption}>
                    {row.billable_count} of {row.priced_count} priced
                    {(row.report_count ?? 0) > 0
                      ? `  ·  ${row.report_count} report${row.report_count === 1 ? "" : "s"}`
                      : ""}
                  </Text>
                </View>
                <Ionicons
                  name={expanded[row.dealer_id] ? "chevron-up" : "chevron-down"}
                  size={18}
                  color={colors.textSecondary}
                  style={{ marginLeft: 6 }}
                />
              </TouchableOpacity>

              {expanded[row.dealer_id] ? (
                <View style={styles.itemsBox}>
                  {row.items.length > 0 ? (
                    <>
                      <Text style={styles.itemsHeader}>
                        Priced Submissions ({row.items.length})
                      </Text>
                      {row.items.map((it) => (
                        <View key={it.id} style={styles.item}>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.itemRef}>{it.reference}</Text>
                            <Text style={styles.itemVehicle}>{it.vehicle}</Text>
                            <Text style={styles.itemMeta}>
                              Submitted {new Date(it.created_at).toLocaleString()}
                            </Text>
                            <Text style={styles.itemMeta}>
                              Priced {new Date(it.priced_at).toLocaleString()}
                            </Text>
                          </View>
                          <View
                            style={[
                              styles.itemBadge,
                              it.billable
                                ? { backgroundColor: colors.neon + "22", borderColor: colors.neon + "55" }
                                : { backgroundColor: colors.warning + "18", borderColor: colors.warning + "55" },
                            ]}
                          >
                            <Text
                              style={[
                                styles.itemBadgeText,
                                { color: it.billable ? colors.neon : colors.warning },
                              ]}
                            >
                              {it.billable ? "R50" : "WAIVED"}
                            </Text>
                          </View>
                        </View>
                      ))}
                    </>
                  ) : null}

                  {(row.report_items || []).length > 0 ? (
                    <>
                      <Text style={[styles.itemsHeader, { marginTop: spacing.sm }]}>
                        VIN Reports Ordered ({row.report_items!.length})
                      </Text>
                      {row.report_items!.map((r, idx) => (
                        <View key={`${r.type}-${idx}`} style={styles.item}>
                          <View style={styles.reportIconBox}>
                            <Ionicons name="document-text" size={16} color={colors.neon} />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.itemVehicle}>{r.name}</Text>
                            {r.vin ? (
                              <Text style={[styles.itemMeta, { fontFamily: fonts.mono }]}>
                                VIN {r.vin}
                              </Text>
                            ) : null}
                            <Text style={styles.itemMeta}>
                              Ordered {new Date(r.ordered_at).toLocaleString()} · {r.status.toUpperCase()}
                            </Text>
                          </View>
                          <View
                            style={[
                              styles.itemBadge,
                              { backgroundColor: colors.neon + "22", borderColor: colors.neon + "55" },
                            ]}
                          >
                            <Text
                              style={[styles.itemBadgeText, { color: colors.neon }]}
                            >
                              R{r.cost_zar.toFixed(0)}
                            </Text>
                          </View>
                        </View>
                      ))}
                    </>
                  ) : null}
                </View>
              ) : null}
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.paper,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { color: colors.text, fontSize: 22, fontWeight: "800", fontFamily: fonts.heading, letterSpacing: 2, textTransform: "uppercase" },
  sub: { color: colors.textSecondary, fontSize: 12, marginTop: 2, letterSpacing: 0.5 },
  monthRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  monthNav: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  monthLabel: { color: colors.text, fontSize: 15, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" },
  totalsRow: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  totalCard: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    padding: spacing.sm,
    alignItems: "center",
  },
  totalCardAccent: { borderColor: colors.neon + "55", backgroundColor: colors.neon + "10" },
  totalLabel: { color: colors.textSecondary, fontSize: 10, fontWeight: "800", letterSpacing: 1.5, marginBottom: 4 },
  totalValue: { color: colors.text, fontSize: 22, fontWeight: "800", fontFamily: fonts.number, fontVariant: ["tabular-nums"], letterSpacing: -0.2 },
  scroll: { padding: spacing.md, paddingBottom: spacing.xl, gap: spacing.sm },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.lg },
  emptyBox: { alignItems: "center", padding: spacing.xl, gap: 8 },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: "700", marginTop: 8 },
  emptyText: { color: colors.textSecondary, fontSize: 13, textAlign: "center" },
  dealerCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
    overflow: "hidden",
  },
  dealerHead: { flexDirection: "row", alignItems: "center", padding: spacing.md, gap: spacing.sm },
  nameLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  dealerName: { color: colors.text, fontSize: 15, fontWeight: "700" },
  suspendPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.danger + "22",
    borderWidth: 1,
    borderColor: colors.danger + "55",
  },
  suspendPillText: { color: colors.danger, fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  archivedPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.textDisabled + "22",
    borderWidth: 1,
    borderColor: colors.textDisabled + "55",
  },
  archivedPillText: { color: colors.textSecondary, fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  dealerCompany: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  dealerEmail: { color: colors.textDisabled, fontSize: 11, marginTop: 1 },
  amountBox: { alignItems: "flex-end" },
  amountValue: { color: colors.text, fontSize: 20, fontWeight: "800", fontFamily: fonts.number, fontVariant: ["tabular-nums"], letterSpacing: -0.2 },
  amountCaption: { color: colors.textSecondary, fontSize: 11, marginTop: 2 },
  itemsBox: { borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.paper, padding: spacing.sm, gap: 6 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    gap: spacing.sm,
  },
  itemRef: { color: colors.neon, fontSize: 11, fontWeight: "800", fontFamily: fonts.mono, letterSpacing: 1 },
  itemVehicle: { color: colors.text, fontSize: 14, fontWeight: "700", marginTop: 2 },
  itemMeta: { color: colors.textSecondary, fontSize: 11, marginTop: 1 },
  itemBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  itemBadgeText: { fontSize: 11, fontWeight: "800", letterSpacing: 0.5 },
  totalsBreakdown: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  breakdownText: {
    color: colors.textSecondary,
    fontSize: 12,
    letterSpacing: 0.3,
  },
  breakdownValue: {
    color: colors.text,
    fontFamily: fonts.number,
    fontVariant: ["tabular-nums"],
    fontWeight: "700",
  },
  itemsHeader: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.4,
    textTransform: "uppercase",
    marginTop: 2,
    marginBottom: 4,
    paddingHorizontal: 4,
  },
  reportIconBox: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: colors.neon + "18",
    borderWidth: 1,
    borderColor: colors.neon + "44",
    marginRight: spacing.xs,
  },
});
