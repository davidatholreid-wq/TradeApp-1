import { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius, fonts } from "@/src/theme";
import { useAuth } from "@/src/context/AuthContext";
import { apiFetch } from "@/src/api";

type Submission = {
  id: string;
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
  price: number | null;
  created_at: string;
};

export default function DashboardScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const [items, setItems] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const isAdmin = user?.role === "admin";

  const load = useCallback(async () => {
    try {
      const path = isAdmin ? "/api/admin/submissions" : "/api/submissions/my";
      const data = await apiFetch(path);
      setItems(data.submissions || []);
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

  const renderItem = ({ item }: { item: Submission }) => (
    <TouchableOpacity
      testID={`submission-card-${item.id}`}
      style={styles.card}
      onPress={() => router.push(`/(app)/vehicle/${item.id}` as any)}
    >
      <View style={styles.cardTop}>
        <View style={{ flex: 1 }}>
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
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>{isAdmin ? "Fourbuy Admin" : "My Submissions"}</Text>
          <Text style={styles.subGreeting}>
            {items.length} {items.length === 1 ? "vehicle" : "vehicles"}
          </Text>
        </View>
        {!isAdmin ? (
          <TouchableOpacity
            testID="header-new-submission-button"
            style={styles.newBtn}
            onPress={() => router.push("/(app)/submit" as any)}
          >
            <Ionicons name="add" size={20} color="#fff" />
            <Text style={styles.newBtnText}>New</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="car-outline" size={64} color={colors.textDisabled} />
          <Text style={styles.emptyTitle}>No submissions yet</Text>
          <Text style={styles.emptyText}>
            {isAdmin ? "Dealer submissions will appear here" : "Submit your first vehicle for pricing"}
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
          data={items}
          keyExtractor={(i) => i.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
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
  greeting: { color: colors.text, fontSize: 22, fontWeight: "700", fontFamily: fonts.serif, letterSpacing: 0.3 },
  subGreeting: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  newBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.sm,
  },
  newBtnText: { color: "#fff", fontWeight: "700" },
  list: { padding: spacing.md, paddingBottom: spacing.xl },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  cardTop: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  cardSubtitle: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.sm,
  },
  badgeText: { fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  metaRow: { flexDirection: "row", gap: spacing.md, marginTop: spacing.sm, flexWrap: "wrap" },
  metaItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  metaText: { color: colors.textSecondary, fontSize: 12 },
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
  emptyBtnText: { color: "#fff", fontWeight: "700" },
});
