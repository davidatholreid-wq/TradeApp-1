import { useCallback, useState, useMemo } from "react";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { View, Text, StyleSheet, ScrollView, RefreshControl, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeTabBarHeight } from "@/src/utils/useSafeTabBarHeight";
import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { apiFetch } from "@/src/api";
import { useAuth } from "@/src/context/AuthContext";
import BrandLogo from "@/src/components/BrandLogo";
import { WalletCard } from "@/src/components/billing/WalletCard";

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
  // Dealership-grouped row. Legacy per-user rows (pre-migration) leave
  // `dealership_id` null; the client keys off `key` for React iteration.
  dealership_id: string | null;
  dealership_name: string;
  company_name: string;                 // legacy alias, same value as dealership_name
  user_count?: number;
  users?: {
    id: string;
    email?: string;
    name?: string | null;
    job_title?: string | null;
    active?: boolean;
    archived?: boolean;
  }[];
  active: boolean;
  archived?: boolean;
  legacy?: boolean;
  priced_count: number;
  billable_count: number;
  amount_zar: number;
  submission_amount_zar?: number;
  report_count?: number;
  report_amount_zar?: number;
  report_items?: BillingReportItem[];
  items: BillingItem[];
  // Legacy fields kept for typescript compat (unused after migration).
  dealer_id?: string;
  dealer_name?: string;
  dealer_email?: string;
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

// Dealer-facing response — a single dealer's summary for the month.
type MyBillingResponse = {
  month: string;
  fee_zar: number;
  sla_hours: number;
  priced_count: number;
  billable_count: number;
  submission_amount_zar: number;
  report_count: number;
  report_amount_zar: number;
  amount_zar: number;
  items: BillingItem[];
  report_items: BillingReportItem[];
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
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const tabBarHeight = useSafeTabBarHeight();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const today = new Date();
  const currentYm = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;

  const [month, setMonth] = useState<string>(currentYm);
  const [data, setData] = useState<BillingResponse | null>(null);
  const [myData, setMyData] = useState<MyBillingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(
    async (m: string) => {
      try {
        if (isAdmin) {
          const res = await apiFetch(`/api/admin/billing?month=${m}`);
          setData(res);
        } else {
          const res = await apiFetch(`/api/billing/my?month=${m}`);
          setMyData(res);
        }
      } catch (e) {
        console.log(e);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [isAdmin]
  );

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load(month);
    }, [load, month])
  );

  const feeZar = (isAdmin ? data?.fee_zar : myData?.fee_zar) ?? 50;
  const slaHours = (isAdmin ? data?.sla_hours : myData?.sla_hours) ?? 24;

  // Unified totals — admin uses aggregated `totals`, dealer uses top-level fields.
  const totals = isAdmin
    ? data?.totals || {
        priced_count: 0,
        billable_count: 0,
        amount_zar: 0,
        submission_amount_zar: 0,
        report_count: 0,
        report_amount_zar: 0,
      }
    : {
        priced_count: myData?.priced_count ?? 0,
        billable_count: myData?.billable_count ?? 0,
        amount_zar: myData?.amount_zar ?? 0,
        submission_amount_zar: myData?.submission_amount_zar ?? 0,
        report_count: myData?.report_count ?? 0,
        report_amount_zar: myData?.report_amount_zar ?? 0,
      };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Billing</Text>
          <Text style={styles.sub}>
            {isAdmin
              ? `R${feeZar} incl. VAT · SLA ${slaHours}h`
              : "Your monthly invoice — submissions & VIN reports"}
          </Text>
        </View>
        <BrandLogo size="xs" linkToHome />
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
          {/* Wallet card — dealer-only. Shows current deposit balance,
              usage-to-date and links to invoice/deposit PDFs. Renders
              above the historical usage report so a dealer sees their
              live wallet first thing. Admins keep the pre-existing
              wallet-agnostic report layout below. */}
          {!isAdmin ? <WalletCard /> : null}
          {isAdmin ? (
            <>
              {(data?.rows || []).length === 0 ? (
                <View style={styles.emptyBox}>
                  <Ionicons name="cash-outline" size={54} color={colors.textDisabled} />
                  <Text style={styles.emptyTitle}>Nothing billable this month</Text>
                  <Text style={styles.emptyText}>
                    Vehicles priced within 24 hours of submission will appear here.
                  </Text>
                </View>
              ) : null}

              {(data?.rows || []).map((row) => {
                const rowKey = row.dealership_id || `legacy-${row.dealer_id ?? ""}`;
                return (
            <View key={rowKey} style={styles.dealerCard} testID={`billing-row-${rowKey}`}>
              <TouchableOpacity
                style={styles.dealerHead}
                onPress={() =>
                  setExpanded((e) => ({ ...e, [rowKey]: !e[rowKey] }))
                }
                activeOpacity={0.85}
              >
                <View style={{ flex: 1 }}>
                  <View style={styles.nameLine}>
                    <Text style={styles.dealerName}>{row.dealership_name || row.company_name || "(deleted dealership)"}</Text>
                    {row.archived ? (
                      <View style={styles.archivedPill}>
                        <Text style={styles.archivedPillText}>ARCHIVED</Text>
                      </View>
                    ) : !row.active ? (
                      <View style={styles.suspendPill}>
                        <Text style={styles.suspendPillText}>DISABLED</Text>
                      </View>
                    ) : null}
                    {row.legacy ? (
                      <View style={styles.suspendPill}>
                        <Text style={styles.suspendPillText}>LEGACY</Text>
                      </View>
                    ) : null}
                  </View>
                  {(row.users?.length ?? 0) > 0 ? (
                    <Text style={styles.dealerCompany}>
                      {row.user_count} user{row.user_count === 1 ? "" : "s"}
                      {(row.users ?? []).length > 0
                        ? "  ·  " + (row.users ?? [])
                            .map((u) => u.name || u.email || "—")
                            .slice(0, 3)
                            .join(", ")
                        + ((row.users ?? []).length > 3 ? " +" + ((row.users?.length ?? 0) - 3) : "")
                        : ""}
                    </Text>
                  ) : null}
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
                  name={expanded[rowKey] ? "chevron-up" : "chevron-down"}
                  size={18}
                  color={colors.textSecondary}
                  style={{ marginLeft: 6 }}
                />
              </TouchableOpacity>

              {expanded[rowKey] ? (
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
                );
              })}
            </>
          ) : (
            // ============ Dealer's own view ============
            <>
              {(myData?.items?.length ?? 0) === 0 &&
              (myData?.report_items?.length ?? 0) === 0 ? (
                <View style={styles.emptyBox}>
                  <Ionicons name="cash-outline" size={54} color={colors.textDisabled} />
                  <Text style={styles.emptyTitle}>Nothing billable this month</Text>
                  <Text style={styles.emptyText}>
                    Vehicles priced this month (within {slaHours}h of submission) and any VIN reports you order will appear here.
                  </Text>
                </View>
              ) : (
                <View style={styles.dealerCard} testID="my-billing-card">
                  {/* Priced submissions */}
                  {(myData?.items || []).length > 0 ? (
                    <View style={styles.itemsBox}>
                      <Text style={styles.itemsHeader}>
                        Priced Submissions ({myData?.items?.length ?? 0})
                      </Text>
                      {(myData?.items || []).map((it) => (
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
                              {it.billable ? `R${feeZar}` : "WAIVED"}
                            </Text>
                          </View>
                        </View>
                      ))}
                    </View>
                  ) : null}

                  {/* VIN Reports */}
                  {(myData?.report_items || []).length > 0 ? (
                    <View style={[styles.itemsBox, (myData?.items || []).length > 0 && { borderTopWidth: 1, borderTopColor: colors.border }]}>
                      <Text style={styles.itemsHeader}>
                        VIN Reports Ordered ({myData?.report_items?.length ?? 0})
                      </Text>
                      {(myData?.report_items || []).map((r, idx) => (
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
                            <Text style={[styles.itemBadgeText, { color: colors.neon }]}>
                              R{r.cost_zar.toFixed(0)}
                            </Text>
                          </View>
                        </View>
                      ))}
                    </View>
                  ) : null}
                </View>
              )}

              {/* Footer note explaining month attribution */}
              {((myData?.items?.length ?? 0) > 0 || (myData?.report_items?.length ?? 0) > 0) ? (
                <View style={styles.attributionNote}>
                  <Ionicons name="calendar-outline" size={14} color={colors.textDisabled} />
                  <Text style={styles.attributionText}>
                    Submissions are billed in the month they were priced. VIN reports are billed in the month they were ordered.
                  </Text>
                </View>
              ) : null}
            </>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
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
  attributionNote: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    marginTop: spacing.md,
    padding: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: "dashed",
    backgroundColor: colors.card,
  },
  attributionText: {
    flex: 1,
    color: colors.textDisabled,
    fontSize: 11,
    lineHeight: 15,
  },
});
