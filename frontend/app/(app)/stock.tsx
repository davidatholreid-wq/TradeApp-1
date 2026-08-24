/**
 * Dealer Stock List screen.
 *
 * Opened from the Home dashboard "Stock" tile. Shows every submission
 * where the dealer marked the deal as done but hasn't yet marked it
 * sold — in other words, cars currently on the lot.
 *
 * Managerial (a.k.a. `is_pricing_agent`) users can:
 *   • Edit the target sell price directly on each row.
 *   • Tap "Mark Sold" to open the stock-management form.
 *
 * Everyone can:
 *   • See the summary strip (units / capital / avg age / aging count).
 *   • Filter by search / sort / age bucket.
 *   • Export the current list to CSV (web only — native falls back to
 *     copying the CSV URL).
 *
 * Aging is measured from `deal.purchased_at` (the deal-done timestamp),
 * NOT the original submission date, per product spec.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
  TextInput,
  Platform,
  Modal,
  Alert,
  Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { TouchableOpacity, Pressable } from "@/src/components/HapticButtons";
import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { apiFetch, TOKEN_KEY } from "@/src/api";
import { storage } from "@/src/utils/storage";
import { useAuth } from "@/src/context/AuthContext";
import { confirmAsync } from "@/src/utils/vehicle-detail";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type StockItem = {
  id: string;
  submission_id?: string;
  // Nov 2026 detailed web stock fields.
  floorplan_amount_zar?: number | null;
  expected_recon_cost_zar?: number | null;
  advertised?: boolean;
  fully_reconditioned?: boolean;
  stock_number?: string | null;
  make_name?: string;
  model_name?: string;
  derivative_name?: string;
  mm_code?: string | null;
  year?: number;
  mileage?: number;
  colour?: string;
  vin?: string;
  condition_score?: number | null;
  my_offer_price_zar?: number | null;
  target_sell_price_zar?: number | null;
  purchased_at?: string;
  days_in_stock?: number | null;
  dealership_id?: string;
  dealership_name?: string;
};

type StockResponse = {
  summary: {
    total_units: number;
    total_capital_zar: number;
    // Nov 2026 — Stock report enhancements: total floorplan liability
    // and total expected Gross Profit (sell − cost − recon) surfaced
    // as tiles at the top of the stock list.
    total_floorplan_zar?: number;
    total_expected_gp_zar?: number;
    gp_priced_units?: number;
    avg_age_days: number | null;
    over_60_days: number;
    buckets: { [k: string]: number };
    // Nov 2026 — cost + expected GP roll-ups per aging bucket so the
    // silos below the totals surface the profit-on-the-line.
    bucket_cost_zar?: { [k: string]: number };
    bucket_gp_zar?: { [k: string]: number };
  };
  items: StockItem[];
};

type SortKey = "newest" | "oldest" | "highest_value" | "longest_in_stock";
type AgeFilter = "all" | "0-30" | "31-60" | "61-90" | "90+";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fmtZar = (n?: number | null): string => {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return `R ${Number(n).toLocaleString("en-ZA")}`;
};

// Age-bucket colour so managers spot stale stock instantly.
function ageTint(days?: number | null): { bg: string; fg: string; label: string } {
  if (days == null) return { bg: "#374151", fg: "#E5E7EB", label: "—" };
  if (days <= 30) return { bg: "#DCFCE7", fg: "#166534", label: `${days}d` };
  if (days <= 60) return { bg: "#FEF3C7", fg: "#92400E", label: `${days}d` };
  if (days <= 90) return { bg: "#FFEDD5", fg: "#9A3412", label: `${days}d` };
  return { bg: "#FEE2E2", fg: "#991B1B", label: `${days}d` };
}

function ageBucket(days?: number | null): AgeFilter {
  if (days == null) return "all";
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function StockScreen() {
  const colors = useThemeColors();
  const router = useRouter();
  const { user } = useAuth();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const isAdmin = user?.role === "admin";
  const isManagerial = !!user?.is_pricing_agent || isAdmin;

  const [data, setData] = useState<StockResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [ageFilter, setAgeFilter] = useState<AgeFilter>("all");

  // Sold modal state ----------------------------------------------------
  const [soldModalFor, setSoldModalFor] = useState<StockItem | null>(null);

  // Target-price inline edit --------------------------------------------
  const [editingTarget, setEditingTarget] = useState<string | null>(null);
  const [targetDraft, setTargetDraft] = useState<string>("");
  const [savingTarget, setSavingTarget] = useState<boolean>(false);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch("/api/stock");
      setData(r as StockResponse);
    } catch (e) {
      // Non-fatal — the empty state falls through
      console.warn("stock load failed", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // ---------------------------------------------------------------------
  // Filtered + sorted items
  // ---------------------------------------------------------------------
  const filteredItems = useMemo(() => {
    let items = data?.items || [];
    // Search: matches stock number, VIN, submission id, make, model, derivative, dealership.
    const q = search.trim().toLowerCase();
    if (q) {
      items = items.filter((it) => {
        const hay = [
          it.stock_number, it.submission_id, it.vin, it.make_name, it.model_name,
          it.derivative_name, it.mm_code, it.dealership_name, String(it.year || ""),
        ].filter(Boolean).join(" ").toLowerCase();
        return hay.includes(q);
      });
    }
    if (ageFilter !== "all") {
      items = items.filter((it) => ageBucket(it.days_in_stock) === ageFilter);
    }
    const sorted = [...items];
    switch (sort) {
      case "oldest":
        sorted.sort((a, b) => (a.purchased_at || "").localeCompare(b.purchased_at || ""));
        break;
      case "highest_value":
        sorted.sort((a, b) => {
          const av = a.my_offer_price_zar || 0;
          const bv = b.my_offer_price_zar || 0;
          return bv - av;
        });
        break;
      case "longest_in_stock":
        sorted.sort((a, b) => (b.days_in_stock ?? -1) - (a.days_in_stock ?? -1));
        break;
      case "newest":
      default:
        sorted.sort((a, b) => (b.purchased_at || "").localeCompare(a.purchased_at || ""));
        break;
    }
    return sorted;
  }, [data, search, sort, ageFilter]);

  // ---------------------------------------------------------------------
  // Target-price save
  // ---------------------------------------------------------------------
  const commitTarget = useCallback(async (item: StockItem) => {
    const raw = (targetDraft || "").replace(/[^\d]/g, "");
    const n = raw ? parseInt(raw, 10) : null;
    if (raw && (!Number.isFinite(n as number) || (n as number) < 0)) {
      Alert.alert("Invalid price", "Please enter a positive number in Rands.");
      return;
    }
    setSavingTarget(true);
    try {
      await apiFetch(`/api/stock/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ target_sell_price_zar: n }),
      });
      setEditingTarget(null);
      setTargetDraft("");
      await load();
    } catch (e: any) {
      Alert.alert("Couldn't save", e?.message || "Please try again.");
    } finally {
      setSavingTarget(false);
    }
  }, [load, targetDraft]);

  // Optimistic toggle for boolean stock fields (advertised, fully_reconditioned).
  // We flip the local state immediately for snappy UX, PATCH in the
  // background, and roll back / show a toast on failure.
  const [togglingFlag, setTogglingFlag] = useState<string | null>(null);
  const toggleFlag = useCallback(
    async (item: StockItem, field: "advertised" | "fully_reconditioned") => {
      const nextVal = !item[field];
      const key = `${item.id}:${field}`;
      setTogglingFlag(key);
      // Optimistic UI update — mutate the real backing store (`data.items`).
      // Earlier code called a non-existent `setItems` which silently threw
      // a ReferenceError; that's why the row didn't visibly change until a
      // manual refresh.
      setData((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map((x) =>
                x.id === item.id ? { ...x, [field]: nextVal } : x,
              ),
            }
          : prev,
      );
      try {
        await apiFetch(`/api/stock/${item.id}`, {
          method: "PATCH",
          body: JSON.stringify({ [field]: nextVal }),
        });
      } catch (e: any) {
        // Roll back on failure.
        setData((prev) =>
          prev
            ? {
                ...prev,
                items: prev.items.map((x) =>
                  x.id === item.id ? { ...x, [field]: !nextVal } : x,
                ),
              }
            : prev,
        );
        Alert.alert("Couldn't save", e?.message || "Please try again.");
      } finally {
        setTogglingFlag(null);
      }
    },
    [],
  );

  // Remove a car from the stock list without deleting the underlying
  // valuation. Backend already exposes
  // POST /api/submissions/{sid}/untransfer-from-stock which drops the
  // stock_items row and clears the submission's stock_* fields — the
  // submission (and its valuation history, reports, cover offers) stay
  // completely intact. Managerial-only, guarded by a confirm.
  const [removingId, setRemovingId] = useState<string | null>(null);
  const untransferFromStock = useCallback(
    async (item: StockItem) => {
      if (!item.submission_id) {
        Alert.alert(
          "Cannot remove",
          "This stock item is not linked to a submission and cannot be removed automatically.",
        );
        return;
      }
      const proceed = () => {
        // OPTIMISTIC removal — the row disappears the moment the user
        // confirms. Before this fix the row waited for the network
        // round-trip AND used a non-existent `setItems` setter, so the
        // dealer had to refresh manually. If the request fails we
        // restore the row and show a toast.
        const original = item;
        setRemovingId(item.id);
        setData((prev) =>
          prev
            ? { ...prev, items: prev.items.filter((x) => x.id !== item.id) }
            : prev,
        );
        (async () => {
          try {
            await apiFetch(`/api/submissions/${item.submission_id}/untransfer-from-stock`, {
              method: "POST",
            });
          } catch (e: any) {
            // Restore the row in-place so the dealer isn't left
            // wondering where their car went.
            setData((prev) =>
              prev
                ? { ...prev, items: [original, ...prev.items] }
                : prev,
            );
            Alert.alert("Couldn't remove", e?.message || "Please try again.");
          } finally {
            setRemovingId(null);
          }
        })();
      };
      const title = "Remove from stock?";
      const msg =
        `${item.stock_number || item.derivative_name || "This vehicle"} will be removed ` +
        "from the stock list. The valuation, offers, and reports on the underlying " +
        "submission remain unchanged and can be transferred back at any time.";
      if (Platform.OS === "web") {
        if (typeof window !== "undefined" && window.confirm(`${title}\n\n${msg}`)) proceed();
      } else {
        Alert.alert(title, msg, [
          { text: "Cancel", style: "cancel" },
          { text: "Remove", style: "destructive", onPress: proceed },
        ]);
      }
    },
    [],
  );

  // ---------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------
  const exportCsv = useCallback(async () => {
    try {
      const token = await storage.secureGet<string>(TOKEN_KEY, "");
      const url = `${process.env.EXPO_PUBLIC_BACKEND_URL || ""}/api/stock/export.csv`;
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (Platform.OS === "web") {
        const blob = await res.blob();
        const dl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = dl;
        a.download = `stock-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(dl);
      } else {
        // Native: open in browser (backend returns the file inline).
        await Linking.openURL(url);
      }
    } catch (e: any) {
      Alert.alert("Export failed", e?.message || "Please try again.");
    }
  }, []);

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={["top"]}>
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
        <View style={styles.titleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Stock</Text>
            <Text style={styles.subtitle}>
              {isAdmin ? "All dealerships" : "Your dealership"} · transferred to stock, not yet sold
            </Text>
          </View>
          <TouchableOpacity
            onPress={exportCsv}
            style={styles.exportBtn}
            activeOpacity={0.85}
            testID="stock-export-btn"
          >
            <Ionicons name="download-outline" size={16} color={colors.text} />
            <Text style={[styles.exportBtnTxt, { color: colors.text }]}>Export</Text>
          </TouchableOpacity>
        </View>
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
          {/* Summary strip */}
          <SummaryStrip summary={data?.summary} styles={styles} colors={colors} />

          {/* Aging chart */}
          {data?.summary?.buckets ? (
            <AgingChart
              buckets={data.summary.buckets}
              bucketCost={data.summary.bucket_cost_zar}
              bucketGp={data.summary.bucket_gp_zar}
              styles={styles}
              colors={colors}
              activeFilter={ageFilter}
              onSelect={(k) => setAgeFilter(k === ageFilter ? "all" : k)}
            />
          ) : null}

          {/* Filters + search */}
          <View style={styles.searchWrap}>
            <Ionicons name="search" size={16} color={colors.textSecondary} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search VIN, ref, make, model…"
              placeholderTextColor={colors.textDisabled}
              style={styles.searchInput}
              testID="stock-search-input"
            />
            {search ? (
              <TouchableOpacity onPress={() => setSearch("")}>
                <Ionicons name="close-circle" size={16} color={colors.textDisabled} />
              </TouchableOpacity>
            ) : null}
          </View>

          <View style={styles.sortRow}>
            {(
              [
                { k: "newest", label: "Newest" },
                { k: "oldest", label: "Oldest" },
                { k: "highest_value", label: "Highest R" },
                { k: "longest_in_stock", label: "Longest" },
              ] as { k: SortKey; label: string }[]
            ).map((s) => {
              const active = sort === s.k;
              return (
                <TouchableOpacity
                  key={s.k}
                  onPress={() => setSort(s.k)}
                  activeOpacity={0.85}
                  style={[
                    styles.sortPill,
                    {
                      borderColor: active ? colors.primary : colors.border,
                      backgroundColor: active ? colors.primary + "22" : "transparent",
                    },
                  ]}
                  testID={`stock-sort-${s.k}`}
                >
                  <Text
                    style={{
                      color: active ? colors.primary : colors.textSecondary,
                      fontSize: 12,
                      fontWeight: "800",
                    }}
                  >
                    {s.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Rows */}
          {filteredItems.length === 0 ? (
            <View style={[styles.empty, { borderColor: colors.border }]}>
              <Ionicons name="car-outline" size={32} color={colors.textDisabled} />
              <Text style={{ color: colors.textSecondary, textAlign: "center", marginTop: spacing.xs }}>
                {search || ageFilter !== "all"
                  ? "No stock matches your filters."
                  : "No vehicles in stock yet. Open a fully-valued submission and tap \"Transfer to Stock\" to add it here."}
              </Text>
            </View>
          ) : (
            // Spreadsheet-style table (per Nov 2026 UX request). Wrapped
            // in a horizontal ScrollView so on narrow phones the dealer
            // gets a swipeable wide table rather than cramped wrapped
            // rows. Sticky header pinned via `stickyHeaderIndices` on
            // the outer vertical scroll would require a bigger rewrite
            // — for MVP the header re-renders inside the horizontal
            // scroller and remains at row 0.
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator
              contentContainerStyle={{ minWidth: "100%" }}
              style={{ marginTop: spacing.sm }}
              testID="stock-table-scroll"
            >
              <View style={styles.tableRoot}>
                <StockTableHeader styles={styles} colors={colors} isAdmin={isAdmin} />
                {filteredItems.map((row, i) => (
                  <StockTableRow
                    key={row.id}
                    row={row}
                    zebra={i % 2 === 1}
                    styles={styles}
                    colors={colors}
                    isAdmin={isAdmin}
                    isManagerial={isManagerial}
                    editingTarget={editingTarget === row.id}
                    targetDraft={targetDraft}
                    savingTarget={savingTarget}
                    onStartEditTarget={() => {
                      setEditingTarget(row.id);
                      setTargetDraft(
                        row.target_sell_price_zar != null ? String(row.target_sell_price_zar) : ""
                      );
                    }}
                    onCancelEditTarget={() => {
                      setEditingTarget(null);
                      setTargetDraft("");
                    }}
                    onChangeTargetDraft={setTargetDraft}
                    onCommitTarget={() => commitTarget(row)}
                    onToggleFlag={(field) => toggleFlag(row, field)}
                    togglingFlag={togglingFlag}
                    removing={removingId === row.id}
                    onOpenSubmission={() => {
                      // Route to the LINKED submission — `row.id` is the
                      // stock-item's own UUID, not the vehicle's. Using
                      // it here caused "Submission expired" on every
                      // stock row tap because /api/submissions/{stock_id}
                      // 404s.
                      if (!row.submission_id) {
                        Alert.alert(
                          "Original submission unavailable",
                          "This stock item is no longer linked to a submission (the underlying submission may have been archived).",
                        );
                        return;
                      }
                      router.push({ pathname: "/(app)/vehicle/[id]", params: { id: row.submission_id, from: "/(app)/stock" } } as never);
                    }}
                    onMarkSold={() => setSoldModalFor(row)}
                    onDelete={() => untransferFromStock(row)}
                    onGenerateAd={() => {
                      if (!row.submission_id) {
                        Alert.alert(
                          "Original submission unavailable",
                          "This stock item is no longer linked to a submission.",
                        );
                        return;
                      }
                      router.push({
                        pathname: "/(app)/vehicle/[id]",
                        params: {
                          id: row.submission_id,
                          from: "/(app)/stock",
                          openAdBlurb: "1",
                        },
                      } as never);
                    }}
                  />
                ))}
              </View>
            </ScrollView>
          )}
        </ScrollView>
      )}

      {/* Mark Sold modal */}
      {soldModalFor ? (
        <MarkSoldModal
          item={soldModalFor}
          colors={colors}
          onClose={() => setSoldModalFor(null)}
          onSaved={async () => {
            setSoldModalFor(null);
            await load();
          }}
        />
      ) : null}
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// SummaryStrip — Feb 2027 redesign.
// A 2×2 grid of big, glanceable tiles: Units, Total Cost, Exp. GP, Avg Age.
// Each tile has an icon chip in a tinted colour + a big value + a supportive
// subtext line. Floorplan tile removed per Feb 2027 request.
// ---------------------------------------------------------------------------
function SummaryStrip({
  summary,
  styles,
  colors,
}: {
  summary?: StockResponse["summary"];
  styles: ReturnType<typeof makeStyles>;
  colors: Palette;
}) {
  const s =
    summary || {
      total_units: 0,
      total_capital_zar: 0,
      total_expected_gp_zar: 0,
      gp_priced_units: 0,
      avg_age_days: null,
      over_60_days: 0,
      buckets: {},
    };
  const priced = s.gp_priced_units || 0;
  const gp = s.total_expected_gp_zar || 0;
  const gpTint = priced === 0 ? "#6B7280" : gp >= 0 ? "#22C55E" : "#DC2626";
  const gpSub =
    priced === 0
      ? "Set target sell prices"
      : priced === s.total_units
      ? "All units priced"
      : `Priced on ${priced}/${s.total_units}`;
  const ageValue = s.avg_age_days != null ? `${s.avg_age_days}d` : "—";
  const ageSub =
    s.over_60_days > 0
      ? `${s.over_60_days} over 60 days`
      : s.avg_age_days == null
      ? "No stock yet"
      : "Fleet ageing";

  return (
    <View style={styles.summaryGrid} testID="stock-summary">
      <SummaryCard
        label="Units in stock"
        value={String(s.total_units)}
        subtext={s.total_units === 1 ? "1 vehicle" : `${s.total_units} vehicles`}
        icon="car-sport"
        tint={colors.primary}
        styles={styles}
        testID="stock-summary-units"
      />
      <SummaryCard
        label="Capital tied up"
        value={fmtZar(s.total_capital_zar)}
        subtext="Total offer paid"
        icon="wallet"
        tint="#22C55E"
        styles={styles}
        testID="stock-summary-cost"
      />
      <SummaryCard
        label="Expected GP"
        value={fmtZar(gp)}
        subtext={gpSub}
        icon="trending-up"
        tint={gpTint}
        styles={styles}
        testID="stock-summary-gp"
      />
      <SummaryCard
        label="Average age"
        value={ageValue}
        subtext={ageSub}
        icon="hourglass"
        tint="#F97316"
        styles={styles}
        testID="stock-summary-age"
      />
    </View>
  );
}

function SummaryCard({
  label,
  value,
  subtext,
  icon,
  tint,
  styles,
  testID,
}: {
  label: string;
  value: string;
  subtext?: string;
  icon: keyof typeof Ionicons.glyphMap;
  tint: string;
  styles: ReturnType<typeof makeStyles>;
  testID?: string;
}) {
  return (
    <View style={styles.summaryCardBig} testID={testID}>
      <View style={styles.summaryCardInner}>
        <View style={styles.summaryCardHead}>
          <View
            style={[
              styles.summaryCardIcon,
              { backgroundColor: tint + "22", borderColor: tint + "55" },
            ]}
          >
            <Ionicons name={icon} size={18} color={tint} />
          </View>
          <Text style={styles.summaryCardLabel} numberOfLines={1}>
            {label}
          </Text>
        </View>
        <Text
          style={[styles.summaryCardValue, { color: tint }]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.65}
        >
          {value}
        </Text>
        {subtext ? (
          <Text style={styles.summaryCardSubtext} numberOfLines={1}>
            {subtext}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// AgingChart — clickable bars per age bucket. Each bar shows the
// unit count above, plus a two-line breakdown below (tied-up cost +
// expected GP) so dealers see the profit-on-the-line for each
// aging silo without leaving the chart.
// ---------------------------------------------------------------------------
function AgingChart({
  buckets,
  bucketCost,
  bucketGp,
  styles,
  colors,
  activeFilter,
  onSelect,
}: {
  buckets: { [k: string]: number };
  bucketCost?: { [k: string]: number };
  bucketGp?: { [k: string]: number };
  styles: ReturnType<typeof makeStyles>;
  colors: Palette;
  activeFilter: AgeFilter;
  onSelect: (k: AgeFilter) => void;
}) {
  const order: { k: AgeFilter; label: string; tint: string }[] = [
    { k: "0-30", label: "0-30d", tint: "#22C55E" },
    { k: "31-60", label: "31-60d", tint: "#EAB308" },
    { k: "61-90", label: "61-90d", tint: "#F97316" },
    { k: "90+", label: "90d+", tint: "#DC2626" },
  ];
  const max = Math.max(1, ...order.map((o) => buckets[o.k] || 0));
  return (
    <View style={styles.chartWrap} testID="stock-aging-chart">
      <View style={styles.chartHead}>
        <Text style={styles.chartTitle}>Aging by bucket</Text>
        <Text style={styles.chartHint}>Tap a bar to filter</Text>
      </View>
      <View style={styles.chartRow}>
        {order.map((o) => {
          const n = buckets[o.k] || 0;
          const active = activeFilter === o.k;
          const cost = bucketCost?.[o.k] || 0;
          const gp = bucketGp?.[o.k] || 0;
          const gpColor = gp > 0 ? "#22C55E" : gp < 0 ? "#DC2626" : colors.textSecondary;
          return (
            <Pressable
              key={o.k}
              onPress={() => onSelect(o.k)}
              style={styles.chartBarCol}
              testID={`stock-bar-${o.k}`}
            >
              <View style={styles.chartBarTrack}>
                <View
                  style={[
                    styles.chartBarFill,
                    {
                      height: `${Math.round((n / max) * 100)}%`,
                      backgroundColor: o.tint,
                      opacity: active ? 1 : 0.8,
                    },
                  ]}
                />
              </View>
              <Text
                style={[
                  styles.chartBarNum,
                  { color: active ? o.tint : colors.text, fontWeight: active ? "900" : "800" },
                ]}
              >
                {n}
              </Text>
              <Text style={styles.chartBarLabel}>{o.label}</Text>
              {/* Bucket cost + GP breakdown. Only rendered when there's
                  at least one unit in the bucket so empty silos stay
                  visually calm. */}
              {n > 0 ? (
                <View style={styles.chartBarStats}>
                  <Text style={styles.chartBarStatCost} numberOfLines={1}>
                    {fmtZar(cost)}
                  </Text>
                  <Text
                    style={[styles.chartBarStatGp, { color: gpColor }]}
                    numberOfLines={1}
                  >
                    GP {fmtZar(gp)}
                  </Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Spreadsheet-style stock table (Nov 2026)
// ---------------------------------------------------------------------------
// We render TWO variants of the table:
//   * WEB (Platform.OS === "web") — the detailed 13-column spreadsheet
//     dealers asked for: Stock #, Year, Make, Derivative, Mileage,
//     Colour, M&M, VIN, Cost (My Offer), Floorplan, Recon, Advertised,
//     Retail, Days in Stock. Wide table (~1500px) that horizontally
//     scrolls when the viewport is narrower.
//   * MOBILE (iOS / Android) — a simplified table (Stock, Vehicle,
//     Mileage, Cost, Retail, Age, Actions) tuned for the smaller
//     viewport. This is the one the dealer already sees in the app.
// -------------- shared: age tinting is the same everywhere -----------
const TABLE_COLS_WEB = {
  stock:      { w: 96,  align: "left"  as const, label: "STOCK #" },
  year:       { w: 60,  align: "left"  as const, label: "YEAR" },
  make:       { w: 110, align: "left"  as const, label: "MAKE" },
  // Nov 2026 revision — was "MODEL / DERIVATIVE" showing model + sub;
  // dealers only want the derivative (trade name), not the internal
  // model code. Wider now that we no longer show two lines.
  derivative: { w: 300, align: "left"  as const, label: "DERIVATIVE" },
  mileage:    { w: 100, align: "right" as const, label: "MILEAGE" },
  colour:     { w: 100, align: "left"  as const, label: "COLOUR" },
  mm:         { w: 90,  align: "left"  as const, label: "M&M" },
  vin:        { w: 156, align: "left"  as const, label: "VIN" },
  cost:       { w: 118, align: "right" as const, label: "COST (MY OFFER)" },
  reconCost:  { w: 108, align: "right" as const, label: "EXP. RECON" },
  // Nov 2026 — Estimated Gross Profit column. Value = target sell
  // price - (My Offer cost + Expected Recon). Shows both the ZAR
  // amount and a percentage (GP / sell). Colour-coded green /
  // amber / red for at-a-glance triage.
  expGp:      { w: 130, align: "right" as const, label: "EXP. GP (%)" },
  // Two clickable YES/NO chips — advertised + fully-reconditioned.
  advertised: { w: 84,  align: "center"as const, label: "ADVERT." },
  reconDone:  { w: 84,  align: "center"as const, label: "RECON" },
  retail:     { w: 124, align: "right" as const, label: "RETAIL" },
  age:        { w: 92,  align: "left"  as const, label: "AGE" },
  dship:      { w: 160, align: "left"  as const, label: "DEALERSHIP" },
  // Widened to 180 (was 140) to comfortably fit four icon buttons —
  // open · advert · mark sold · remove — on the managerial UI without cropping.
  actions:    { w: 180, align: "right" as const, label: "" },
} as const;

const TABLE_COLS_MOBILE = {
  stock:  { w: 88,  align: "left"  as const, label: "STOCK #" },
  year:   { w: 52,  align: "left"  as const, label: "YR" },
  vehicle:{ w: 240, align: "left"  as const, label: "VEHICLE" },
  km:     { w: 96,  align: "right" as const, label: "KM" },
  cost:   { w: 108, align: "right" as const, label: "COST" },
  retail: { w: 108, align: "right" as const, label: "RETAIL" },
  age:    { w: 88,  align: "left"  as const, label: "AGE" },
  dship:  { w: 140, align: "left"  as const, label: "DEALER" },
  actions:{ w: 128, align: "right" as const, label: "" },
} as const;

// Note: no shared `TABLE_COLS` — each variant uses its own constant so
// the two schemas can drift independently without runtime confusion.

function StockTableHeader({
  styles,
  colors,
  isAdmin,
}: {
  styles: ReturnType<typeof makeStyles>;
  colors: Palette;
  isAdmin: boolean;
}) {
  const isWeb = Platform.OS === "web";
  const cols = isWeb ? TABLE_COLS_WEB : TABLE_COLS_MOBILE;
  const order: string[] = isWeb
    ? [
        "stock", "year", "make", "derivative", "mileage", "colour",
        "mm", "vin", "cost", "reconCost", "expGp",
        "advertised", "reconDone",
        "retail", "age",
        ...(isAdmin ? ["dship"] : []),
        "actions",
      ]
    : [
        "stock", "year", "vehicle", "km", "cost", "retail", "age",
        ...(isAdmin ? ["dship"] : []),
        "actions",
      ];
  return (
    <View style={styles.tableHeaderRow}>
      {order.map((k) => {
        const meta = (cols as any)[k];
        if (!meta) return null;
        return (
          <Text
            key={k}
            style={[
              styles.tableHeaderCell,
              { width: meta.w, textAlign: meta.align },
            ]}
            numberOfLines={1}
          >
            {meta.label}
          </Text>
        );
      })}
    </View>
  );
}

function StockTableRow({
  row,
  zebra,
  styles,
  colors,
  isAdmin,
  isManagerial,
  editingTarget,
  targetDraft,
  savingTarget,
  onStartEditTarget,
  onCancelEditTarget,
  onChangeTargetDraft,
  onCommitTarget,
  onOpenSubmission,
  onMarkSold,
  onDelete,
  onGenerateAd,
  removing,
  onToggleFlag,
  togglingFlag,
}: {
  row: StockItem;
  zebra: boolean;
  styles: ReturnType<typeof makeStyles>;
  colors: Palette;
  isAdmin: boolean;
  isManagerial: boolean;
  editingTarget: boolean;
  targetDraft: string;
  savingTarget: boolean;
  onStartEditTarget: () => void;
  onCancelEditTarget: () => void;
  onChangeTargetDraft: (v: string) => void;
  onCommitTarget: () => void;
  onOpenSubmission: () => void;
  onMarkSold: () => void;
  onGenerateAd: () => void;
  onToggleFlag: (field: "advertised" | "fully_reconditioned") => void;
  togglingFlag: string | null;
  onDelete: () => void;
  removing: boolean;
}) {
  const isWeb = Platform.OS === "web";
  const age = ageTint(row.days_in_stock);

  // ------- Yes/No clickable pill (advertised, fully_reconditioned) ---
  // Managerial users can toggle; other roles see a read-only pill so
  // the flags aren't accidentally flipped from a non-managerial device.
  const YesNoToggle = ({
    field,
    value,
    testID,
  }: {
    field: "advertised" | "fully_reconditioned";
    value: boolean;
    testID: string;
  }) => {
    const busy = togglingFlag === `${row.id}:${field}`;
    return (
      <TouchableOpacity
        disabled={!isManagerial || busy}
        activeOpacity={isManagerial ? 0.7 : 1}
        onPress={() => onToggleFlag(field)}
        style={[
          styles.tableAdvertisedPill,
          value ? styles.tableAdvertisedPillYes : styles.tableAdvertisedPillNo,
          busy && { opacity: 0.55 },
        ]}
        testID={testID}
      >
        {busy ? (
          <ActivityIndicator size="small" color={value ? colors.onPrimary : colors.textSecondary} />
        ) : (
          <Text
            style={[
              styles.tableAdvertisedPillTxt,
              { color: value ? colors.onPrimary : colors.textSecondary },
            ]}
          >
            {value ? "YES" : "NO"}
          </Text>
        )}
      </TouchableOpacity>
    );
  };

  // ------- Retail-price editable cell (shared for web + mobile) ------
  const retailCell = editingTarget ? (
    <View style={styles.tableTargetEdit}>
      <TextInput
        value={targetDraft}
        onChangeText={onChangeTargetDraft}
        keyboardType="number-pad"
        placeholder="0"
        placeholderTextColor={colors.textDisabled}
        style={styles.tableTargetInput}
        autoFocus
        testID={`stock-target-input-${row.id}`}
      />
      <TouchableOpacity
        onPress={onCommitTarget}
        disabled={savingTarget}
        style={styles.tableTargetSave}
        testID={`stock-target-save-${row.id}`}
      >
        {savingTarget ? (
          <ActivityIndicator size="small" color={colors.onPrimary} />
        ) : (
          <Ionicons name="checkmark" size={14} color={colors.onPrimary} />
        )}
      </TouchableOpacity>
      <TouchableOpacity onPress={onCancelEditTarget} style={styles.tableTargetCancel}>
        <Ionicons name="close" size={14} color={colors.textSecondary} />
      </TouchableOpacity>
    </View>
  ) : (
    <TouchableOpacity
      onPress={isManagerial ? onStartEditTarget : undefined}
      activeOpacity={isManagerial ? 0.7 : 1}
      testID={`stock-target-cell-${row.id}`}
    >
      <Text
        style={[
          styles.tableCell,
          styles.tableCellNumeric,
          styles.tableCellPrice,
          {
            color: row.target_sell_price_zar != null ? colors.text : colors.textDisabled,
          },
          isManagerial ? styles.tableCellEditable : null,
        ]}
        numberOfLines={1}
      >
        {row.target_sell_price_zar != null ? fmtZar(row.target_sell_price_zar) : "Set…"}
      </Text>
    </TouchableOpacity>
  );

  // ------- Expected Gross Profit cell (read-only, computed) ----------
  // GP = sell − (cost + recon). Only rendered when the two required
  // inputs (sell price + cost) are present; recon is treated as 0
  // when missing since a lot of dealers don't set it until they've
  // actually spent the money.
  const sell = row.target_sell_price_zar ?? null;
  const cost = row.my_offer_price_zar ?? null;
  const recon = row.expected_recon_cost_zar ?? 0;
  let expGp: number | null = null;
  let expGpPct: number | null = null;
  if (typeof sell === "number" && typeof cost === "number") {
    expGp = sell - (cost + recon);
    expGpPct = sell > 0 ? (expGp / sell) * 100 : null;
  }
  const gpColor =
    expGp == null ? colors.textDisabled
    : expGp >= 0 ? "#22C55E"
    : "#DC2626";
  const expGpCell = (
    <View style={{ paddingVertical: 2 }}>
      <Text
        style={[
          styles.tableCell,
          styles.tableCellNumeric,
          styles.tableCellPrice,
          { color: gpColor },
        ]}
        numberOfLines={1}
      >
        {expGp != null ? fmtZar(expGp) : "—"}
      </Text>
      <Text
        style={[
          styles.tableCell,
          styles.tableCellNumeric,
          { color: gpColor, fontSize: 11, opacity: 0.85 },
        ]}
        numberOfLines={1}
      >
        {expGpPct != null ? `${expGpPct.toFixed(1)}%` : ""}
      </Text>
    </View>
  );

  // ------- Age pill (shared) -----------------------------------------
  const agePill = (
    <View style={[styles.tableAgePill, { backgroundColor: age.bg }]}>
      <Text style={[styles.tableAgePillTxt, { color: age.fg }]}>{age.label}</Text>
    </View>
  );

  // ------- Actions cell (shared) -------------------------------------
  const actionsCell = (
    <View style={styles.tableActionsCell}>
      <TouchableOpacity
        onPress={onOpenSubmission}
        style={styles.tableIconBtn}
        testID={`stock-open-${row.id}`}
      >
        <Ionicons name="open-outline" size={14} color={colors.text} />
      </TouchableOpacity>
      {/* Feb 2027 — quick "Write advert" shortcut. Deep-links into the
          vehicle detail with `?openAdBlurb=1` so the AI ad-blurb card
          auto-expands (or auto-generates if it hasn't been made yet).
          Dealers can then copy the copy straight into their marketing
          channels without leaving the stock context. */}
      <TouchableOpacity
        onPress={onGenerateAd}
        style={[styles.tableIconBtn, { backgroundColor: "#7C3AED" }]}
        testID={`stock-ad-blurb-${row.id}`}
        accessibilityLabel="Write advertising blurb"
      >
        <Ionicons name="megaphone-outline" size={14} color="#FFFFFF" />
      </TouchableOpacity>
      {isManagerial ? (
        <TouchableOpacity
          onPress={onMarkSold}
          style={[styles.tableIconBtn, { backgroundColor: colors.primary }]}
          testID={`stock-mark-sold-${row.id}`}
        >
          <Ionicons name="cash-outline" size={14} color={colors.onPrimary} />
        </TouchableOpacity>
      ) : null}
      {/* Remove-from-stock (un-transfer). Managerial-only. Does NOT
          delete the underlying valuation — the submission and all its
          history stay intact, only the stock_items row is removed. */}
      {isManagerial ? (
        <TouchableOpacity
          onPress={onDelete}
          disabled={removing}
          style={[styles.tableIconBtn, styles.tableIconBtnDanger, removing && { opacity: 0.5 }]}
          testID={`stock-delete-${row.id}`}
        >
          {removing ? (
            <ActivityIndicator size="small" color={colors.danger || "#B91C1C"} />
          ) : (
            <Ionicons name="trash-outline" size={14} color={colors.danger || "#B91C1C"} />
          )}
        </TouchableOpacity>
      ) : null}
    </View>
  );

  // =================== WEB: detailed 13-column table ==================
  if (isWeb) {
    const C = TABLE_COLS_WEB;
    return (
      <View
        style={[styles.tableBodyRow, zebra && styles.tableBodyRowZebra]}
        testID={`stock-row-${row.stock_number || row.id}`}
      >
        {/* Stock # */}
        <View style={{ width: C.stock.w }}>
          <TouchableOpacity onPress={onOpenSubmission} activeOpacity={0.7}>
            <Text style={styles.tableCellStock} numberOfLines={1}>
              {row.stock_number || "—"}
            </Text>
          </TouchableOpacity>
        </View>
        {/* Year */}
        <Text style={[styles.tableCell, { width: C.year.w }]} numberOfLines={1}>
          {row.year || "—"}
        </Text>
        {/* Make */}
        <Text
          style={[styles.tableCellVehicle, { width: C.make.w }]}
          numberOfLines={1}
        >
          {row.make_name || "—"}
        </Text>
        {/* Derivative — trade name only, no internal model code */}
        <View style={{ width: C.derivative.w, paddingRight: 8 }}>
          <TouchableOpacity onPress={onOpenSubmission} activeOpacity={0.7}>
            <Text style={styles.tableCellVehicle} numberOfLines={1}>
              {row.derivative_name || row.model_name || "—"}
            </Text>
          </TouchableOpacity>
        </View>
        {/* Mileage */}
        <Text
          style={[styles.tableCell, styles.tableCellNumeric, { width: C.mileage.w }]}
          numberOfLines={1}
        >
          {row.mileage ? `${Number(row.mileage).toLocaleString("en-ZA")} km` : "—"}
        </Text>
        {/* Colour */}
        <Text style={[styles.tableCell, { width: C.colour.w }]} numberOfLines={1}>
          {row.colour || "—"}
        </Text>
        {/* M&M code */}
        <Text style={[styles.tableCell, { width: C.mm.w }]} numberOfLines={1}>
          {row.mm_code || "—"}
        </Text>
        {/* VIN */}
        <Text
          style={[styles.tableCell, styles.tableCellMono, { width: C.vin.w }]}
          numberOfLines={1}
        >
          {row.vin || "—"}
        </Text>
        {/* Cost (My Offer) */}
        <Text
          style={[styles.tableCell, styles.tableCellNumeric, styles.tableCellPrice, { width: C.cost.w }]}
          numberOfLines={1}
        >
          {fmtZar(row.my_offer_price_zar)}
        </Text>
        {/* Expected Recon Cost */}
        <Text
          style={[
            styles.tableCell,
            styles.tableCellNumeric,
            { width: C.reconCost.w, color: row.expected_recon_cost_zar ? colors.text : colors.textDisabled },
          ]}
          numberOfLines={1}
        >
          {row.expected_recon_cost_zar != null ? fmtZar(row.expected_recon_cost_zar) : "—"}
        </Text>
        {/* Expected Gross Profit (computed) */}
        <View style={{ width: C.expGp.w }}>{expGpCell}</View>
        {/* Advertised — tap to toggle */}
        <View style={{ width: C.advertised.w, alignItems: "center" }}>
          <YesNoToggle
            field="advertised"
            value={!!row.advertised}
            testID={`stock-advertised-${row.id}`}
          />
        </View>
        {/* Fully Reconditioned — tap to toggle */}
        <View style={{ width: C.reconDone.w, alignItems: "center" }}>
          <YesNoToggle
            field="fully_reconditioned"
            value={!!row.fully_reconditioned}
            testID={`stock-recon-${row.id}`}
          />
        </View>
        {/* Retail Price (editable) */}
        <View style={{ width: C.retail.w }}>{retailCell}</View>
        {/* Age (Days in Stock) */}
        <View style={{ width: C.age.w, alignItems: "flex-start" }}>{agePill}</View>
        {/* Dealership (admin) */}
        {isAdmin ? (
          <Text
            style={[styles.tableCell, { width: C.dship.w, color: colors.textSecondary }]}
            numberOfLines={1}
          >
            {row.dealership_name || "—"}
          </Text>
        ) : null}
        {/* Actions */}
        <View style={{ width: C.actions.w }}>{actionsCell}</View>
      </View>
    );
  }

  // =================== MOBILE: simplified 7-column table ==============
  const M = TABLE_COLS_MOBILE;
  const vehicleTitle =
    [row.make_name, row.model_name].filter(Boolean).join(" ") ||
    row.derivative_name ||
    "—";
  const vehicleSub =
    row.derivative_name && row.derivative_name !== row.model_name
      ? row.derivative_name
      : row.colour || "";
  return (
    <View
      style={[styles.tableBodyRow, zebra && styles.tableBodyRowZebra]}
      testID={`stock-row-${row.stock_number || row.id}`}
    >
      <View style={{ width: M.stock.w }}>
        <TouchableOpacity onPress={onOpenSubmission} activeOpacity={0.7}>
          <Text style={styles.tableCellStock} numberOfLines={1}>
            {row.stock_number || "—"}
          </Text>
        </TouchableOpacity>
      </View>
      <Text style={[styles.tableCell, { width: M.year.w }]} numberOfLines={1}>
        {row.year || "—"}
      </Text>
      <View style={{ width: M.vehicle.w, paddingRight: 8 }}>
        <TouchableOpacity onPress={onOpenSubmission} activeOpacity={0.7}>
          <Text style={styles.tableCellVehicle} numberOfLines={1}>
            {vehicleTitle}
          </Text>
          {vehicleSub ? (
            <Text style={styles.tableCellVehicleSub} numberOfLines={1}>
              {vehicleSub}
            </Text>
          ) : null}
        </TouchableOpacity>
      </View>
      <Text
        style={[styles.tableCell, styles.tableCellNumeric, { width: M.km.w }]}
        numberOfLines={1}
      >
        {row.mileage ? `${Number(row.mileage).toLocaleString("en-ZA")} km` : "—"}
      </Text>
      <Text
        style={[styles.tableCell, styles.tableCellNumeric, styles.tableCellPrice, { width: M.cost.w }]}
        numberOfLines={1}
      >
        {fmtZar(row.my_offer_price_zar)}
      </Text>
      <View style={{ width: M.retail.w }}>{retailCell}</View>
      <View style={{ width: M.age.w, alignItems: "flex-start" }}>{agePill}</View>
      {isAdmin ? (
        <Text
          style={[styles.tableCell, { width: M.dship.w, color: colors.textSecondary }]}
          numberOfLines={1}
        >
          {row.dealership_name || "—"}
        </Text>
      ) : null}
      <View style={{ width: M.actions.w }}>{actionsCell}</View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// MarkSoldModal — stock-management sold form
// ---------------------------------------------------------------------------
function MarkSoldModal({
  item,
  colors,
  onClose,
  onSaved,
}: {
  item: StockItem;
  colors: Palette;
  onClose: () => void;
  onSaved: () => void;
}) {
  const styles = useMemo(() => makeSoldStyles(colors), [colors]);
  const [salePrice, setSalePrice] = useState<string>("");
  const [reconCost, setReconCost] = useState<string>("");
  const [buyerName, setBuyerName] = useState<string>("");
  const [buyerNotes, setBuyerNotes] = useState<string>("");
  const [soldDate, setSoldDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState<boolean>(false);

  // Live profit preview so the dealer can confirm the numbers before saving.
  const profit = useMemo(() => {
    const sp = parseInt(salePrice.replace(/[^\d]/g, ""), 10);
    const rc = parseInt(reconCost.replace(/[^\d]/g, ""), 10) || 0;
    const cost = item.my_offer_price_zar || 0;
    if (!Number.isFinite(sp)) return null;
    return sp - rc - cost;
  }, [salePrice, reconCost, item.my_offer_price_zar]);

  const submit = useCallback(async () => {
    const sp = parseInt(salePrice.replace(/[^\d]/g, ""), 10);
    if (!Number.isFinite(sp) || sp <= 0) {
      Alert.alert("Sale price required", "Please enter the sale price in Rands.");
      return;
    }
    const ok = await confirmAsync(
      "Confirm sale",
      `Record this vehicle as sold for R ${sp.toLocaleString("en-ZA")}?\nThis will move it out of your stock list.`,
      "Mark sold",
    );
    if (!ok) return;
    setSaving(true);
    try {
      const rc = parseInt(reconCost.replace(/[^\d]/g, ""), 10);
      await apiFetch(`/api/stock/${item.id}/mark-sold`, {
        method: "POST",
        body: JSON.stringify({
          sale_price_zar: sp,
          recon_cost_zar: Number.isFinite(rc) ? rc : 0,
          buyer_name: buyerName.trim() || null,
          buyer_notes: buyerNotes.trim() || null,
          sold_at: soldDate || null,
        }),
      });
      onSaved();
    } catch (e: any) {
      Alert.alert("Couldn't record sale", e?.message || "Please try again.");
    } finally {
      setSaving(false);
    }
  }, [salePrice, reconCost, buyerName, buyerNotes, soldDate, item.id, onSaved]);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Mark as sold</Text>
            <TouchableOpacity onPress={onClose} activeOpacity={0.85}>
              <Ionicons name="close" size={22} color={colors.text} />
            </TouchableOpacity>
          </View>
          <Text style={styles.vehicleLine} numberOfLines={2}>
            {[item.year, item.make_name, item.derivative_name || item.model_name]
              .filter(Boolean)
              .join(" ")}
            {item.stock_number ? ` · ${item.stock_number}` : ""}
          </Text>

          <ScrollView contentContainerStyle={{ gap: spacing.sm, paddingBottom: spacing.md }}>
            <Field label="Sale price (R)*" testID="sold-sale-price">
              <TextInput
                value={salePrice}
                onChangeText={setSalePrice}
                keyboardType="number-pad"
                placeholder="0"
                placeholderTextColor={colors.textDisabled}
                style={styles.input}
              />
            </Field>
            <Field label="Recon cost (R)" testID="sold-recon-cost">
              <TextInput
                value={reconCost}
                onChangeText={setReconCost}
                keyboardType="number-pad"
                placeholder="0"
                placeholderTextColor={colors.textDisabled}
                style={styles.input}
              />
            </Field>
            <Field label="Sold date (YYYY-MM-DD)" testID="sold-date">
              <TextInput
                value={soldDate}
                onChangeText={setSoldDate}
                placeholder="2026-08-12"
                placeholderTextColor={colors.textDisabled}
                style={styles.input}
              />
            </Field>
            <Field label="Buyer name" testID="sold-buyer-name">
              <TextInput
                value={buyerName}
                onChangeText={setBuyerName}
                placeholder="Optional"
                placeholderTextColor={colors.textDisabled}
                style={styles.input}
              />
            </Field>
            <Field label="Notes" testID="sold-buyer-notes">
              <TextInput
                value={buyerNotes}
                onChangeText={setBuyerNotes}
                placeholder="Trade-in, warranty, comments…"
                placeholderTextColor={colors.textDisabled}
                style={[styles.input, styles.inputMulti]}
                multiline
                numberOfLines={3}
              />
            </Field>

            {profit != null ? (
              <View
                style={[
                  styles.profitPreview,
                  { borderColor: profit >= 0 ? "#22C55E" + "66" : "#DC2626" + "66" },
                ]}
              >
                <Text style={styles.profitLbl}>Estimated gross profit</Text>
                <Text
                  style={[styles.profitVal, { color: profit >= 0 ? "#22C55E" : "#DC2626" }]}
                >
                  {profit >= 0 ? "+" : ""}
                  {fmtZar(profit)}
                </Text>
                <Text style={styles.profitHint}>
                  Sale − recon − My Offer (cost basis)
                </Text>
              </View>
            ) : null}
          </ScrollView>

          <View style={styles.footerRow}>
            <TouchableOpacity onPress={onClose} style={styles.cancelBtn} activeOpacity={0.85}>
              <Text style={styles.cancelBtnTxt}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={submit}
              disabled={saving}
              style={[styles.saveBtn, { backgroundColor: colors.primary }]}
              activeOpacity={0.85}
              testID="sold-submit-btn"
            >
              {saving ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <Text style={[styles.saveBtnTxt, { color: colors.onPrimary }]}>Mark sold</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function Field({
  label,
  children,
  testID,
}: {
  label: string;
  children: React.ReactNode;
  testID?: string;
}) {
  return (
    <View style={{ gap: 4 }} testID={testID}>
      <Text style={{ color: "#9CA3AF", fontSize: 11, fontWeight: "800", letterSpacing: 0.6 }}>
        {label.toUpperCase()}
      </Text>
      {children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    // -----------------------------------------------------------------
    // Spreadsheet table styles (Nov 2026 stock redesign)
    // -----------------------------------------------------------------
    tableRoot: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      overflow: "hidden",
      backgroundColor: colors.paper,
      alignSelf: "flex-start", // fit-content so horizontal scroll works cleanly
    },
    tableHeaderRow: {
      flexDirection: "row",
      backgroundColor: colors.card,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      paddingHorizontal: 12,
      paddingVertical: 10,
      gap: 12,
    },
    tableHeaderCell: {
      color: colors.textSecondary,
      fontSize: 10,
      fontWeight: "800",
      letterSpacing: 0.5,
      textTransform: "uppercase",
    },
    tableBodyRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 12,
      paddingVertical: 10,
      gap: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.borderLight,
    },
    tableBodyRowZebra: {
      backgroundColor: colors.card,
    },
    tableCell: {
      color: colors.text,
      fontSize: 12,
      lineHeight: 15,
    },
    tableCellNumeric: {
      textAlign: "right",
      fontVariant: ["tabular-nums"],
    },
    tableCellPrice: {
      fontWeight: "700",
    },
    tableCellMono: {
      fontFamily: fonts.mono,
      color: colors.textSecondary,
      fontSize: 11,
    },
    tableCellStock: {
      color: colors.primary,
      fontWeight: "800",
      fontSize: 12,
      letterSpacing: 0.3,
    },
    tableCellVehicle: {
      color: colors.text,
      fontSize: 13,
      fontWeight: "700",
    },
    tableCellVehicleSub: {
      color: colors.textSecondary,
      fontSize: 11,
      marginTop: 1,
    },
    tableCellEditable: {
      textDecorationLine: "underline",
      textDecorationStyle: "dotted" as any,
    },
    tableAgePill: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 999,
    },
    tableAgePillTxt: {
      fontSize: 10,
      fontWeight: "800",
      letterSpacing: 0.4,
    },
    tableTargetEdit: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    tableTargetInput: {
      flex: 1,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: Platform.OS === "ios" ? 4 : 2,
      color: colors.text,
      fontSize: 12,
      fontVariant: ["tabular-nums"],
      textAlign: "right",
      minWidth: 60,
    },
    tableTargetSave: {
      width: 24,
      height: 24,
      borderRadius: 6,
      backgroundColor: colors.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    tableTargetCancel: {
      width: 24,
      height: 24,
      borderRadius: 6,
      alignItems: "center",
      justifyContent: "center",
    },
    tableActionsCell: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: 6,
    },
    tableIconBtn: {
      width: 30,
      height: 26,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.paper,
      alignItems: "center",
      justifyContent: "center",
    },
    tableIconBtnDanger: {
      // Uses danger/red palette; falls back to a neutral red so we
      // don't tint the theme's primary red-adjacent hues by accident.
      borderColor: colors.danger || "#B91C1C",
    },
    // eye can scan a column of ~10-20 stock rows instantly.
    tableAdvertisedPill: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 999,
      borderWidth: 1,
    },
    tableAdvertisedPillYes: {
      backgroundColor: colors.primary,
      borderColor: colors.primary,
    },
    tableAdvertisedPillNo: {
      backgroundColor: "transparent",
      borderColor: colors.border,
    },
    tableAdvertisedPillTxt: {
      fontSize: 10,
      fontWeight: "800",
      letterSpacing: 0.4,
    },

    header: {
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
      paddingBottom: spacing.md,
      gap: 4,
    },
    titleRow: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: spacing.md,
    },
    backBtn: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      paddingVertical: 4,
      gap: 2,
    },
    backBtnTxt: { fontSize: 15, fontWeight: "600" },
    title: { color: colors.text, fontSize: 24, fontWeight: "900", marginTop: 4, letterSpacing: -0.4 },
    subtitle: { color: colors.textSecondary, fontSize: 13, fontWeight: "600" },
    exportBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
    },
    exportBtnTxt: { fontSize: 12, fontWeight: "800" },
    center: { flex: 1, alignItems: "center", justifyContent: "center" },

    // Summary strip -----------------------------------------------------
    // Feb 2027 redesign — 2×2 grid of large glanceable tiles.
    summaryGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      marginHorizontal: -6,
      marginBottom: spacing.md,
    },
    summaryCardBig: {
      width: "50%",
      paddingHorizontal: 6,
      paddingVertical: 6,
    },
    summaryCardInner: {
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.paper,
      padding: 14,
    },
    summaryCardHead: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginBottom: 8,
    },
    summaryCardIcon: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
    },
    summaryCardLabel: {
      color: colors.textSecondary,
      fontSize: 11,
      fontWeight: "800",
      letterSpacing: 0.6,
      textTransform: "uppercase",
      flexShrink: 1,
    },
    summaryCardValue: {
      color: colors.text,
      fontSize: 22,
      fontWeight: "900",
      fontFamily: fonts.number,
      letterSpacing: -0.4,
    },
    summaryCardSubtext: {
      color: colors.textSecondary,
      fontSize: 11,
      fontWeight: "600",
      marginTop: 4,
    },
    // Retained legacy names (unused by the new grid, kept for other
    // code paths that might still reference them via style prop drift).
    summaryWrap: {
      flexDirection: "row",
      gap: 8,
      marginBottom: spacing.md,
    },
    summaryCell: {
      flex: 1,
      minWidth: 0,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.paper,
      padding: 10,
      gap: 4,
    },
    summaryIconChip: {
      width: 26, height: 26, borderRadius: 13,
      alignItems: "center", justifyContent: "center",
      borderWidth: 1,
    },
    summaryLabel: {
      color: colors.textSecondary,
      fontSize: 9,
      fontWeight: "800",
      letterSpacing: 1,
    },
    summaryValue: {
      color: colors.text,
      fontSize: 15,
      fontWeight: "900",
      fontFamily: fonts.number,
      letterSpacing: -0.3,
    },
    summarySubtext: {
      color: colors.textSecondary,
      fontSize: 10,
      fontWeight: "700",
      marginTop: 2,
      letterSpacing: 0.4,
    },

    // Aging chart -------------------------------------------------------
    chartWrap: {
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.paper,
      padding: spacing.md,
      marginBottom: spacing.md,
    },
    chartHead: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: spacing.xs,
    },
    chartTitle: {
      color: colors.text,
      fontSize: 13,
      fontWeight: "800",
    },
    chartHint: {
      color: colors.textDisabled,
      fontSize: 10,
      fontStyle: "italic",
    },
    chartRow: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 8,
      height: 128,
    },
    chartBarCol: {
      flex: 1,
      alignItems: "center",
      gap: 4,
      height: "100%",
      // Room for the cost + GP stats footer under each bar
      paddingBottom: 2,
    },
    chartBarTrack: {
      width: "80%",
      flex: 1,
      backgroundColor: colors.border,
      borderRadius: 4,
      justifyContent: "flex-end",
      overflow: "hidden",
    },
    chartBarFill: {
      width: "100%",
      borderRadius: 4,
    },
    chartBarNum: {
      fontSize: 12,
      fontFamily: fonts.number,
    },
    chartBarLabel: {
      color: colors.textDisabled,
      fontSize: 9,
      fontWeight: "700",
      letterSpacing: 0.4,
    },
    // Cost + GP breakdown under each bucket bar. Two lines: total
    // cost tied up in that silo (in muted colour) plus the expected
    // GP (green/red/grey based on sign).
    chartBarStats: {
      marginTop: 2,
      alignItems: "center",
      gap: 1,
    },
    chartBarStatCost: {
      color: colors.text,
      fontSize: 10,
      fontFamily: fonts.number,
      fontWeight: "700",
    },
    chartBarStatGp: {
      fontSize: 9,
      fontFamily: fonts.number,
      fontWeight: "700",
      letterSpacing: 0.2,
    },

    // Search + sort -----------------------------------------------------
    searchWrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.paper,
      borderRadius: radius.md,
      paddingHorizontal: 12,
      height: 42,
      marginBottom: 8,
    },
    searchInput: {
      flex: 1,
      color: colors.text,
      fontSize: 14,
      paddingVertical: 0,
      // Remove default RN Web focus outline
      ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as any) : {}),
    },
    sortRow: {
      flexDirection: "row",
      gap: 6,
      marginBottom: spacing.md,
      flexWrap: "wrap",
    },
    sortPill: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 999,
      borderWidth: 1,
    },

    empty: {
      borderWidth: 1,
      borderRadius: radius.lg,
      padding: spacing.xl,
      alignItems: "center",
    },

    // Row card ----------------------------------------------------------
    rowCard: {
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.paper,
      padding: spacing.md,
      marginBottom: 10,
      gap: spacing.sm,
    },
    rowTop: {
      flexDirection: "row",
      gap: 12,
      alignItems: "flex-start",
    },
    rowThumbWrap: {
      position: "relative",
    },
    rowThumb: {
      width: 92, height: 68, borderRadius: 8, backgroundColor: "#1a1a1a",
    },
    rowThumbPlaceholder: {
      width: 92, height: 68, borderRadius: 8, backgroundColor: colors.bg,
      alignItems: "center", justifyContent: "center",
    },
    // Stock-number left rail — replaces the photo thumbnail. Vertically
    // stacks the stock number pill and the aging badge so the row still
    // has a strong left anchor even without an image.
    rowStockBadgeWrap: {
      alignItems: "flex-start",
      minWidth: 92,
    },
    rowStockBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.primary + "66",
      backgroundColor: colors.primary + "18",
    },
    rowStockBadgeTxt: {
      color: colors.primary,
      fontSize: 12,
      fontWeight: "900",
      letterSpacing: 0.4,
      maxWidth: 120,
      fontFamily: fonts.number,
    },
    ageBadge: {
      position: "absolute",
      bottom: -6, left: 4,
      paddingHorizontal: 6, paddingVertical: 2,
      borderRadius: 4,
    },
    ageBadgeTxt: {
      fontSize: 10, fontWeight: "800",
    },
    rowTitle: { color: colors.text, fontSize: 15, fontWeight: "800" },
    rowSub: { color: colors.textSecondary, fontSize: 12, fontWeight: "600", marginTop: 2 },
    rowMetaRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 4,
      marginTop: 4,
    },
    rowMeta: { color: colors.textDisabled, fontSize: 10, fontWeight: "700", letterSpacing: 0.2 },
    rowDshipChip: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      gap: 3,
      marginTop: 4,
      paddingHorizontal: 5,
      paddingVertical: 2,
      borderRadius: 4,
      backgroundColor: colors.bg,
    },
    rowDshipTxt: { color: colors.textSecondary, fontSize: 10, fontWeight: "700" },

    // Price grid --------------------------------------------------------
    priceRow: {
      flexDirection: "row",
      gap: 6,
    },
    priceCell: {
      flex: 1,
      minWidth: 0,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.bg,
      padding: 8,
      gap: 2,
    },
    priceCellEditable: {
      borderStyle: "dashed",
    },
    priceCellEdit: {
      flex: 1,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.primary,
      backgroundColor: colors.bg,
      padding: 6,
      gap: 4,
    },
    priceCellLabel: { color: colors.textSecondary, fontSize: 9, fontWeight: "800", letterSpacing: 0.6 },
    priceCellLabelRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    priceCellValue: {
      color: colors.text,
      fontSize: 13,
      fontWeight: "800",
      fontFamily: fonts.number,
    },
    targetEditRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    targetEditInput: {
      flex: 1,
      color: colors.text,
      fontSize: 13,
      fontFamily: fonts.number,
      fontWeight: "800",
      padding: 0,
      ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as any) : {}),
    },
    targetEditActions: {
      flexDirection: "row",
      gap: 4,
      justifyContent: "flex-end",
    },
    targetEditBtn: {
      paddingHorizontal: 6,
      paddingVertical: 3,
      borderRadius: 4,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: "center",
      justifyContent: "center",
      minWidth: 44,
    },
    targetEditBtnSave: {
      backgroundColor: colors.primary,
      borderColor: colors.primary,
    },

    // Row actions -------------------------------------------------------
    rowActions: {
      flexDirection: "row",
      gap: 8,
      justifyContent: "flex-end",
    },
    actionBtnGhost: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 7,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
    },
    actionBtnGhostTxt: { fontSize: 12, fontWeight: "800" },
    actionBtnPrimary: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: radius.md,
    },
    actionBtnPrimaryTxt: { color: colors.onPrimary, fontSize: 12, fontWeight: "800" },
  });

const makeSoldStyles = (colors: Palette) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.6)",
      alignItems: "center",
      justifyContent: "center",
      padding: spacing.md,
    },
    card: {
      width: "100%",
      maxWidth: 480,
      backgroundColor: colors.paper,
      borderRadius: radius.lg,
      padding: spacing.md,
      borderWidth: 1,
      borderColor: colors.border,
      maxHeight: "90%",
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    title: { color: colors.text, fontSize: 18, fontWeight: "900", letterSpacing: -0.3 },
    vehicleLine: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: "600",
      marginTop: 2,
      marginBottom: spacing.sm,
    },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: colors.text,
      fontSize: 14,
      backgroundColor: colors.bg,
      ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as any) : {}),
    },
    inputMulti: {
      minHeight: 72,
      textAlignVertical: "top",
    },
    profitPreview: {
      borderRadius: radius.md,
      borderWidth: 1,
      padding: spacing.sm,
      gap: 2,
      marginTop: 4,
    },
    profitLbl: {
      color: colors.textSecondary,
      fontSize: 11,
      fontWeight: "800",
      letterSpacing: 0.6,
    },
    profitVal: {
      fontSize: 22,
      fontWeight: "900",
      fontFamily: fonts.number,
      letterSpacing: -0.5,
    },
    profitHint: {
      color: colors.textDisabled,
      fontSize: 10,
      fontStyle: "italic",
    },
    footerRow: {
      flexDirection: "row",
      gap: 8,
      justifyContent: "flex-end",
      marginTop: spacing.sm,
    },
    cancelBtn: {
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
    },
    cancelBtnTxt: { color: colors.textSecondary, fontWeight: "800", fontSize: 13 },
    saveBtn: {
      paddingHorizontal: 18,
      paddingVertical: 10,
      borderRadius: radius.md,
      minWidth: 120,
      alignItems: "center",
    },
    saveBtnTxt: { color: colors.onPrimary, fontWeight: "800", fontSize: 13 },
  });
