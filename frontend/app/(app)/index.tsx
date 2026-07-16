import { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
  Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { colors, spacing, radius, fonts } from "@/src/theme";
import { useAuth } from "@/src/context/AuthContext";
import { apiFetch } from "@/src/api";
import BrandLogo from "@/src/components/BrandLogo";

type Submission = {
  id: string;
  reference?: string;
  dealer_name?: string;
  company_name?: string;
  make_name: string;
  model_name: string;
  derivative_name: string;
  year: number;
  mileage: number;
  condition: number;
  colour: string;
  status: "pending" | "priced";
  bucket?: "incoming" | "priced" | "archived";
  price: number | null;
  priced_at?: string | null;
  created_at: string;
  front_photo?: string | null;
};

type BucketCounts = { incoming: number; priced: number; archived: number };

export default function DashboardScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const tabBarHeight = useBottomTabBarHeight();
  const [items, setItems] = useState<Submission[]>([]);
  const [counts, setCounts] = useState<BucketCounts>({ incoming: 0, priced: 0, archived: 0 });
  const [bucket, setBucket] = useState<"incoming" | "priced">("incoming");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const isAdmin = user?.role === "admin";

  const load = useCallback(async () => {
    try {
      const path = isAdmin ? "/api/admin/submissions" : "/api/submissions/my";
      const data = await apiFetch(path);
      const subs: Submission[] = data.submissions || [];
      setItems(subs);
      if (isAdmin) {
        if (data.counts) {
          setCounts(data.counts);
        } else {
          // Fallback: derive counts client-side.
          const c: BucketCounts = { incoming: 0, priced: 0, archived: 0 };
          subs.forEach((s) => {
            const b = s.bucket || (s.status === "priced" ? "priced" : "incoming");
            c[b] = (c[b] || 0) + 1;
          });
          setCounts(c);
        }
      }
    } catch (e) {
      console.log("load error", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isAdmin]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  // Filter items by the current silo (admin only). Non-admin sees all their
  // (non-archived) items which are already filtered server-side.
  const visibleItems = isAdmin
    ? items.filter((s) => (s.bucket || (s.status === "priced" ? "priced" : "incoming")) === bucket)
    : items;

  const renderItem = ({ item }: { item: Submission }) => (
    <TouchableOpacity
      testID={`submission-card-${item.id}`}
      style={styles.card}
      onPress={() => router.push(`/(app)/vehicle/${item.id}` as any)}
    >
      <View style={styles.cardTop}>
        {/* Front photo thumbnail (or placeholder if missing) — helps the
            dealer visually identify their submissions at a glance. */}
        <View style={styles.thumbWrap}>
          {item.front_photo ? (
            <Image source={{ uri: item.front_photo }} style={styles.thumb} resizeMode="cover" />
          ) : (
            <View style={styles.thumbPlaceholder}>
              <Ionicons name="car-outline" size={22} color={colors.textDisabled} />
            </View>
          )}
        </View>
        <View style={{ flex: 1 }}>
          {item.reference ? (
            <Text style={styles.cardRef}>{item.reference}</Text>
          ) : null}
          <Text style={styles.cardTitle} numberOfLines={1}>
            {item.year} {item.make_name} {item.model_name}
          </Text>
          <Text style={styles.cardSubtitle} numberOfLines={1}>
            {item.derivative_name}
          </Text>
        </View>
        <View
          style={[
            styles.badge,
            { backgroundColor: item.status === "priced" ? colors.success + "22" : colors.warning + "22" },
          ]}
        >
          <Text
            style={[
              styles.badgeText,
              { color: item.status === "priced" ? colors.success : colors.warning },
            ]}
          >
            {item.status === "priced" ? "PRICED" : "PENDING"}
          </Text>
        </View>
      </View>

      <View style={styles.metaRow}>
        <View style={styles.metaItem}>
          <Ionicons name="speedometer-outline" size={14} color={colors.textSecondary} />
          <Text style={styles.metaText}>{item.mileage.toLocaleString()} km</Text>
        </View>
        <View style={styles.metaItem}>
          <Ionicons name="color-palette-outline" size={14} color={colors.textSecondary} />
          <Text style={styles.metaText}>{item.colour}</Text>
        </View>
        <View style={styles.metaItem}>
          <Ionicons name="star-outline" size={14} color={colors.textSecondary} />
          <Text style={styles.metaText}>Condition {item.condition}/10</Text>
        </View>
      </View>

      {isAdmin && item.dealer_name ? (
        <View style={styles.dealerRow}>
          <Ionicons name="business-outline" size={12} color={colors.textSecondary} />
          <Text style={styles.dealerText}>
            {item.dealer_name} · {item.company_name}
          </Text>
        </View>
      ) : null}

      {item.status === "priced" && item.price !== null ? (
        <View style={styles.priceRow}>
          <Text style={styles.priceLabel}>Offer</Text>
          <Text style={styles.priceValue}>R {item.price.toLocaleString()}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Slim brand strip so the logo is always visible above the header. */}
      <View style={styles.brandStrip}>
        <BrandLogo size="sm" />
      </View>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.greeting}>{isAdmin ? "Fourbuy Admin" : "My Submissions"}</Text>
          <Text style={styles.subGreeting}>
            {isAdmin
              ? `${counts.incoming + counts.priced} active · ${counts.archived} archived`
              : `${items.length} ${items.length === 1 ? "vehicle" : "vehicles"}`}
          </Text>
        </View>
        {!isAdmin ? (
          <TouchableOpacity
            testID="header-new-submission-button"
            style={styles.newBtn}
            onPress={() => router.push("/(app)/submit" as any)}
          >
            <Ionicons name="add" size={20} color="#000" />
            <Text style={styles.newBtnText}>New</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {isAdmin ? (
        <View style={styles.silosRow}>
          {(["incoming", "priced"] as const).map((b) => {
            const active = bucket === b;
            const label = b === "incoming" ? "Incoming" : "Priced";
            const n = counts[b] || 0;
            return (
              <TouchableOpacity
                key={b}
                testID={`silo-${b}`}
                onPress={() => setBucket(b)}
                style={[styles.silo, active && styles.siloActive]}
                activeOpacity={0.85}
              >
                <Text style={[styles.siloLabel, active && styles.siloLabelActive]}>{label}</Text>
                <View style={[styles.siloBadge, active && styles.siloBadgeActive]}>
                  <Text style={[styles.siloBadgeText, active && styles.siloBadgeTextActive]}>{n}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : visibleItems.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="car-outline" size={64} color={colors.textDisabled} />
          <Text style={styles.emptyTitle}>
            {isAdmin
              ? bucket === "incoming"
                ? "No incoming submissions"
                : "Nothing priced in the last 14 days"
              : "No submissions yet"}
          </Text>
          <Text style={styles.emptyText}>
            {isAdmin
              ? bucket === "incoming"
                ? "New dealer submissions will appear here"
                : "Priced vehicles appear here for 14 days then move to Archive on desktop"
              : "Submit your first vehicle for pricing"}
          </Text>
          {!isAdmin ? (
            <TouchableOpacity
              testID="empty-new-submission-button"
              style={styles.emptyBtn}
              onPress={() => router.push("/(app)/submit" as any)}
            >
              <Text style={styles.emptyBtnText}>Submit Vehicle</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : (
        <FlatList
          data={visibleItems}
          keyExtractor={(i) => i.id}
          renderItem={renderItem}
          contentContainerStyle={[styles.list, { paddingBottom: tabBarHeight + spacing.md }]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  brandStrip: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: 4,
    backgroundColor: colors.bg,
    alignItems: "flex-start",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.paper,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  greeting: { color: colors.text, fontSize: 24, fontWeight: "800", fontFamily: fonts.heading, letterSpacing: 0.3 },
  subGreeting: { color: colors.textSecondary, fontSize: 14, marginTop: 4, letterSpacing: 0.1 },
  newBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.sm,
  },
  newBtnText: { color: "#000", fontWeight: "800", letterSpacing: 0.5 },

  silosRow: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    backgroundColor: colors.bg,
  },
  silo: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  siloActive: {
    borderColor: colors.neon,
    backgroundColor: colors.neon + "12",
  },
  siloLabel: { color: colors.textSecondary, fontSize: 13, fontWeight: "700", letterSpacing: 0.3 },
  siloLabelActive: { color: colors.text },
  siloBadge: {
    minWidth: 24,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.border,
    alignItems: "center",
  },
  siloBadgeActive: { backgroundColor: colors.neon },
  siloBadgeText: { color: colors.text, fontSize: 11, fontWeight: "800" },
  siloBadgeTextActive: { color: "#000" },
  list: { padding: spacing.md, paddingBottom: spacing.xl },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  cardTop: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  thumbWrap: {
    width: 68,
    height: 52,
    borderRadius: radius.sm,
    overflow: "hidden",
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.border,
  },
  thumb: { width: "100%", height: "100%" },
  thumbPlaceholder: { flex: 1, alignItems: "center", justifyContent: "center" },
  cardRef: { color: "#fff", fontSize: 14, fontWeight: "800", letterSpacing: 0.6, fontFamily: fonts.mono, marginBottom: 6 },
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: "700", letterSpacing: 0.1 },
  cardSubtitle: { color: colors.textSecondary, fontSize: 14, marginTop: 3, letterSpacing: 0.1 },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.sm,
  },
  badgeText: { fontSize: 11, fontWeight: "700", letterSpacing: 0.3 },
  metaRow: { flexDirection: "row", gap: spacing.md, marginTop: spacing.sm, flexWrap: "wrap" },
  metaItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  metaText: { color: colors.textSecondary, fontSize: 13, letterSpacing: 0.1 },
  dealerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  dealerText: { color: colors.textSecondary, fontSize: 12 },
  priceRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  priceLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: "600" },
  priceValue: { color: colors.success, fontSize: 18, fontWeight: "800" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm, padding: spacing.lg },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: "700", marginTop: spacing.sm },
  emptyText: { color: colors.textSecondary, fontSize: 14, textAlign: "center" },
  emptyBtn: {
    marginTop: spacing.md,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.xl,
    paddingVertical: 12,
    borderRadius: radius.sm,
  },
  emptyBtnText: { color: "#000", fontWeight: "800", letterSpacing: 0.5 },
});
