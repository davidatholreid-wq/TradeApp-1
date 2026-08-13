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
    avg_age_days: number | null;
    over_60_days: number;
    buckets: { [k: string]: number };
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
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} activeOpacity={0.85}>
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
            filteredItems.map((row) => (
              <StockRow
                key={row.id}
                row={row}
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
                onOpenSubmission={() => router.push(`/(app)/vehicle/${row.id}` as never)}
                onMarkSold={() => setSoldModalFor(row)}
              />
            ))
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
// SummaryStrip
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
  const s = summary || { total_units: 0, total_capital_zar: 0, avg_age_days: null, over_60_days: 0, buckets: {} };
  return (
    <View style={styles.summaryWrap} testID="stock-summary">
      <SummaryCell
        label="UNITS"
        value={String(s.total_units)}
        icon="car-sport"
        tint={colors.primary}
        styles={styles}
      />
      <SummaryCell
        label="CAPITAL"
        value={fmtZar(s.total_capital_zar)}
        icon="wallet"
        tint="#22C55E"
        styles={styles}
      />
      <SummaryCell
        label="AVG AGE"
        value={s.avg_age_days != null ? `${s.avg_age_days}d` : "—"}
        icon="hourglass"
        tint="#F97316"
        styles={styles}
      />
      <SummaryCell
        label="60+ DAYS"
        value={String(s.over_60_days)}
        icon="alert-circle"
        tint={s.over_60_days > 0 ? "#DC2626" : "#6B7280"}
        styles={styles}
      />
    </View>
  );
}

function SummaryCell({
  label,
  value,
  icon,
  tint,
  styles,
}: {
  label: string;
  value: string;
  icon: keyof typeof Ionicons.glyphMap;
  tint: string;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.summaryCell}>
      <View style={[styles.summaryIconChip, { backgroundColor: tint + "22", borderColor: tint + "66" }]}>
        <Ionicons name={icon} size={16} color={tint} />
      </View>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={styles.summaryValue} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// AgingChart — clickable bars per age bucket
// ---------------------------------------------------------------------------
function AgingChart({
  buckets,
  styles,
  colors,
  activeFilter,
  onSelect,
}: {
  buckets: { [k: string]: number };
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
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// StockRow
// ---------------------------------------------------------------------------
function StockRow({
  row,
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
}: {
  row: StockItem;
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
}) {
  const age = ageTint(row.days_in_stock);
  const title = [row.year, row.make_name].filter(Boolean).join(" ");
  return (
    <View style={styles.rowCard} testID={`stock-row-${row.stock_number || row.id}`}>
      <View style={styles.rowTop}>
        {/* Stock-number badge + age pill — replaces the photo thumbnail
            (per product spec: no images copied from the submission). */}
        <View style={styles.rowStockBadgeWrap}>
          <View style={styles.rowStockBadge}>
            <Ionicons name="pricetag" size={12} color={colors.primary} />
            <Text style={styles.rowStockBadgeTxt} numberOfLines={1}>
              {row.stock_number || "—"}
            </Text>
          </View>
          <View style={[styles.ageBadge, { backgroundColor: age.bg, position: "relative", bottom: undefined, left: undefined, marginTop: 6 }]}>
            <Text style={[styles.ageBadgeTxt, { color: age.fg }]}>{age.label}</Text>
          </View>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <TouchableOpacity onPress={onOpenSubmission} activeOpacity={0.85}>
            <Text style={styles.rowTitle} numberOfLines={1}>{title || "—"}</Text>
            {row.derivative_name || row.model_name ? (
              <Text style={styles.rowSub} numberOfLines={2}>
                {row.derivative_name || row.model_name}
              </Text>
            ) : null}
          </TouchableOpacity>
          <View style={styles.rowMetaRow}>
            {row.mm_code ? (
              <Text style={styles.rowMeta}>M&M {row.mm_code}</Text>
            ) : null}
            {row.mileage ? (
              <Text style={styles.rowMeta}>
                {row.mm_code ? "· " : ""}
                {Number(row.mileage).toLocaleString("en-ZA")} km
              </Text>
            ) : null}
            {row.colour ? (
              <Text style={styles.rowMeta}>· {row.colour}</Text>
            ) : null}
            {row.condition_score != null ? (
              <Text style={styles.rowMeta}>· Cond {Number(row.condition_score).toFixed(1)}</Text>
            ) : null}
            {row.vin ? (
              <Text style={styles.rowMeta} numberOfLines={1}>· VIN {row.vin}</Text>
            ) : null}
          </View>
          {isAdmin && row.dealership_name ? (
            <View style={styles.rowDshipChip}>
              <Ionicons name="business" size={10} color={colors.textSecondary} />
              <Text style={styles.rowDshipTxt} numberOfLines={1}>{row.dealership_name}</Text>
            </View>
          ) : null}
        </View>
      </View>

      {/* Price grid — My Offer (cost basis) on the left, target sell on
          the right.  The old "Purchased" cell is gone; My Offer is the
          only cost basis in the new stock model (per product spec). */}
      <View style={styles.priceRow}>
        <PriceCell
          label="MY OFFER"
          value={fmtZar(row.my_offer_price_zar)}
          styles={styles}
        />
        {editingTarget ? (
          <View style={styles.priceCellEdit}>
            <Text style={styles.priceCellLabel}>TARGET</Text>
            <View style={styles.targetEditRow}>
              <Text style={{ color: colors.text, fontSize: 13, fontWeight: "700" }}>R</Text>
              <TextInput
                value={targetDraft}
                onChangeText={onChangeTargetDraft}
                keyboardType="number-pad"
                placeholder="0"
                placeholderTextColor={colors.textDisabled}
                style={styles.targetEditInput}
                autoFocus
                testID={`stock-target-input-${row.id}`}
              />
            </View>
            <View style={styles.targetEditActions}>
              <TouchableOpacity
                onPress={onCancelEditTarget}
                style={styles.targetEditBtn}
                activeOpacity={0.8}
              >
                <Text style={{ color: colors.textSecondary, fontSize: 11, fontWeight: "800" }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onCommitTarget}
                style={[styles.targetEditBtn, styles.targetEditBtnSave]}
                activeOpacity={0.8}
                disabled={savingTarget}
                testID={`stock-target-save-${row.id}`}
              >
                {savingTarget ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={{ color: "#fff", fontSize: 11, fontWeight: "800" }}>Save</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <TouchableOpacity
            onPress={isManagerial ? onStartEditTarget : undefined}
            activeOpacity={isManagerial ? 0.8 : 1}
            style={[styles.priceCell, isManagerial ? styles.priceCellEditable : null]}
            testID={`stock-target-cell-${row.id}`}
          >
            <View style={styles.priceCellLabelRow}>
              <Text style={styles.priceCellLabel}>TARGET</Text>
              {isManagerial ? (
                <Ionicons name="pencil" size={10} color={colors.textSecondary} />
              ) : null}
            </View>
            <Text
              style={[
                styles.priceCellValue,
                { color: row.target_sell_price_zar != null ? colors.text : colors.textDisabled },
              ]}
              numberOfLines={1}
            >
              {row.target_sell_price_zar != null ? fmtZar(row.target_sell_price_zar) : "Set"}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {isManagerial ? (
        <View style={styles.rowActions}>
          <TouchableOpacity
            onPress={onOpenSubmission}
            style={styles.actionBtnGhost}
            activeOpacity={0.85}
          >
            <Ionicons name="document-text-outline" size={14} color={colors.textSecondary} />
            <Text style={[styles.actionBtnGhostTxt, { color: colors.textSecondary }]}>Open</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onMarkSold}
            style={[styles.actionBtnPrimary, { backgroundColor: colors.primary }]}
            activeOpacity={0.85}
            testID={`stock-mark-sold-${row.id}`}
          >
            <Ionicons name="cash-outline" size={14} color="#fff" />
            <Text style={styles.actionBtnPrimaryTxt}>Mark Sold</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

function PriceCell({
  label,
  value,
  styles,
}: {
  label: string;
  value: string;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.priceCell}>
      <Text style={styles.priceCellLabel}>{label}</Text>
      <Text style={styles.priceCellValue} numberOfLines={1}>{value}</Text>
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
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.saveBtnTxt}>Mark sold</Text>
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
      height: 96,
    },
    chartBarCol: {
      flex: 1,
      alignItems: "center",
      gap: 4,
      height: "100%",
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
    actionBtnPrimaryTxt: { color: "#fff", fontSize: 12, fontWeight: "800" },
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
    saveBtnTxt: { color: "#fff", fontWeight: "800", fontSize: 13 },
  });
