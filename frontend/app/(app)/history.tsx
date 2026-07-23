import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { View, Text, StyleSheet, FlatList, TextInput, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { apiFetch } from "@/src/api";
import { useAuth } from "@/src/context/AuthContext";
import { formatZAR } from "@/src/utils/format";
import BrandLogo from "@/src/components/BrandLogo";

/**
 * History screen — dedicated "past valuations" search.
 *
 * Behaves per role:
 *   - Dealer: their own submissions across every status/bucket (incl. declined
 *     & archived).
 *   - Admin : every dealer's submissions across every status/bucket.
 *
 * Search matches (case-insensitive contains) against reference, make, model
 * and VIN — the four fields you're most likely to remember about a past car.
 * Status filter narrows further (All / Pending / Priced / Declined).
 */

type HistoryItem = {
  id: string;
  reference?: string;
  make_name?: string;
  model_name?: string;
  derivative_name?: string;
  year?: number;
  year_registered?: number;
  vin?: string;
  mileage?: number;
  colour?: string;
  status: "pending" | "priced" | "declined";
  bucket?: string;
  price?: number | null;
  priced_at?: string | null;
  declined_at?: string | null;
  created_at: string;
  front_photo?: string | null;
  dealer_email?: string;
  dealer_name?: string;
  company_name?: string;
  unseen?: boolean;
};

const STATUS_OPTIONS = [
  { key: "all", label: "All" },
  { key: "priced", label: "Priced" },
  { key: "declined", label: "No Offer" },
  { key: "pending", label: "Pending" },
] as const;
type StatusKey = (typeof STATUS_OPTIONS)[number]["key"];

export default function HistoryScreen() {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const { user } = useAuth();
  const tabBarHeight = useBottomTabBarHeight();
  const isAdmin = user?.role === "admin";

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusKey>("all");
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const debounceRef = useRef<any>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (status !== "all") params.set("status", status);
      const qs = params.toString();
      const data = await apiFetch(`/api/history${qs ? "?" + qs : ""}`);
      setItems(data.submissions || []);
    } catch (e) {
      console.log("history load error", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [q, status]);

  // Initial + focus load.
  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load();
    }, [load])
  );

  // Debounced re-fetch as user types.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setLoading(true);
      load();
    }, 350);
    return () => clearTimeout(debounceRef.current);
  }, [q, status, load]);

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  const resultsCount = items.length;
  const emptyCopy = useMemo(() => {
    if (q.trim()) return `No results for "${q.trim()}"`;
    if (status !== "all") return `No ${status} submissions found`;
    return "No submissions in your history yet";
  }, [q, status]);

  const renderItem = ({ item }: { item: HistoryItem }) => {
    const statusPill =
      item.status === "priced"
        ? { color: colors.success, label: "PRICED" }
        : item.status === "declined"
        ? { color: colors.danger, label: "NO OFFER" }
        : { color: colors.warning, label: "PENDING" };
    const displayDate =
      item.priced_at || item.declined_at || item.created_at;
    return (
      <TouchableOpacity
        style={styles.card}
        onPress={() => router.push(`/(app)/vehicle/${item.id}` as any)}
        testID={`history-card-${item.id}`}
      >
        <View style={styles.cardHeader}>
          <View style={{ flex: 1 }}>
            {item.reference ? (
              <Text style={styles.reference}>{item.reference}</Text>
            ) : null}
            <Text style={styles.vehicle}>
              {[item.year_registered || item.year, item.make_name, item.model_name]
                .filter(Boolean)
                .join(" ")}
            </Text>
            {item.derivative_name ? (
              <Text style={styles.derivative}>{item.derivative_name}</Text>
            ) : null}
            {item.unseen ? (
              <View style={styles.unseenPill} testID="unseen-pill">
                <Ionicons name="eye-off" size={9} color="#B3261E" />
                <Text style={styles.unseenPillText}>UNSEEN · SUBJECT TO VIEW</Text>
              </View>
            ) : null}
          </View>
          <View
            style={[
              styles.statusPill,
              { backgroundColor: statusPill.color + "22", borderColor: statusPill.color + "55" },
            ]}
          >
            <Text style={[styles.statusPillText, { color: statusPill.color }]}>
              {statusPill.label}
            </Text>
          </View>
        </View>

        <View style={styles.metaRow}>
          {item.vin ? (
            <View style={styles.metaItem}>
              <Ionicons name="barcode-outline" size={12} color={colors.textSecondary} />
              <Text style={[styles.metaText, { fontFamily: fonts.mono }]} numberOfLines={1}>
                {item.vin}
              </Text>
            </View>
          ) : null}
          {item.mileage ? (
            <View style={styles.metaItem}>
              <Ionicons name="speedometer-outline" size={12} color={colors.textSecondary} />
              <Text style={styles.metaText}>{item.mileage.toLocaleString()} km</Text>
            </View>
          ) : null}
          {item.colour ? (
            <View style={styles.metaItem}>
              <Ionicons name="color-palette-outline" size={12} color={colors.textSecondary} />
              <Text style={styles.metaText}>{item.colour}</Text>
            </View>
          ) : null}
        </View>

        {isAdmin && (item.dealer_name || item.dealer_email) ? (
          <View style={styles.dealerRow}>
            <Ionicons name="business-outline" size={11} color={colors.textSecondary} />
            <Text style={styles.dealerText} numberOfLines={1}>
              {item.dealer_name || item.dealer_email}
              {item.company_name ? ` · ${item.company_name}` : ""}
            </Text>
          </View>
        ) : null}

        <View style={styles.footer}>
          <Text style={styles.dateText}>
            {new Date(displayDate).toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
          </Text>
          {item.status === "priced" && item.price != null ? (
            <Text style={styles.priceText}>{formatZAR(item.price)}</Text>
          ) : item.status === "declined" ? (
            <Text style={[styles.priceText, { color: colors.textSecondary, fontSize: 12 }]}>
              Not charged
            </Text>
          ) : null}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>History</Text>
          <Text style={styles.sub}>
            {isAdmin ? "All submissions · all dealers" : "Your past valuations"}
          </Text>
        </View>
        <BrandLogo size="xs" linkToHome />
      </View>

      <View style={styles.searchWrap}>
        <View style={styles.searchInner}>
          <Ionicons name="search-outline" size={16} color={colors.textSecondary} />
          <TextInput
            testID="history-search"
            style={styles.searchInput}
            placeholder="Search reference, make, model or VIN"
            placeholderTextColor={colors.textDisabled}
            value={q}
            onChangeText={setQ}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="search"
          />
          {q.length > 0 ? (
            <TouchableOpacity onPress={() => setQ("")} testID="history-clear">
              <Ionicons name="close-circle" size={16} color={colors.textDisabled} />
            </TouchableOpacity>
          ) : null}
        </View>

        <View style={styles.filterRow}>
          {STATUS_OPTIONS.map((opt) => (
            <TouchableOpacity
              key={opt.key}
              style={[styles.chip, status === opt.key && styles.chipActive]}
              onPress={() => setStatus(opt.key)}
              testID={`history-filter-${opt.key}`}
            >
              <Text
                style={[styles.chipText, status === opt.key && styles.chipTextActive]}
              >
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.resultsCount}>
          {loading ? "Loading…" : `${resultsCount} result${resultsCount === 1 ? "" : "s"}`}
        </Text>
      </View>

      {loading && items.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.text} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="archive-outline" size={44} color={colors.textDisabled} />
          <Text style={styles.emptyTitle}>{emptyCopy}</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          renderItem={renderItem}
          contentContainerStyle={[styles.list, { paddingBottom: tabBarHeight + spacing.md }]}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
        />
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
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  title: { color: colors.text, fontSize: 22, fontWeight: "800", letterSpacing: 0.4 },
  sub: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },

  searchWrap: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  searchInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: 14,
    letterSpacing: 0.3,
    padding: 0,
  },
  filterRow: {
    flexDirection: "row",
    gap: 6,
    marginTop: spacing.sm,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: {
    backgroundColor: colors.text,
    borderColor: colors.text,
  },
  chipText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  chipTextActive: { color: colors.onPrimary },
  resultsCount: {
    marginTop: spacing.sm,
    color: colors.textDisabled,
    fontSize: 11,
    letterSpacing: 0.6,
  },

  list: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  reference: {
    color: colors.textSecondary,
    fontSize: 10,
    letterSpacing: 1.5,
    fontWeight: "800",
    marginBottom: 2,
  },
  vehicle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  derivative: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  unseenPill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    marginTop: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: "#FDECEA",
    borderWidth: 1,
    borderColor: "#B3261E",
  },
  unseenPillText: {
    color: "#B3261E",
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  statusPillText: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.1,
  },

  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: 4,
  },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  metaText: {
    color: colors.textSecondary,
    fontSize: 11,
  },

  dealerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  dealerText: {
    color: colors.textSecondary,
    fontSize: 11,
    flex: 1,
  },

  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  dateText: {
    color: colors.textDisabled,
    fontSize: 11,
    fontFamily: fonts.mono,
  },
  priceText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "800",
    fontFamily: fonts.number,
    fontVariant: ["tabular-nums"],
  },

  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    gap: spacing.sm,
  },
  emptyTitle: {
    color: colors.textSecondary,
    textAlign: "center",
  },
});
