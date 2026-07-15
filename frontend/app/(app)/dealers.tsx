import { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius, fonts } from "@/src/theme";
import { apiFetch } from "@/src/api";

type Dealer = {
  id: string;
  email: string;
  dealer_info: { first_name: string; last_name: string; phone: string };
  company_info: { company_name: string; company_address: string };
  submission_count: number;
  created_at: string;
};

export default function Dealers() {
  const [dealers, setDealers] = useState<Dealer[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch("/api/admin/dealers");
      setDealers(data.dealers || []);
    } catch (e) {
      console.log(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const confirmDelete = (dealer: Dealer) => {
    Alert.alert(
      "Remove Dealer",
      `Remove ${dealer.dealer_info.first_name} ${dealer.dealer_info.last_name} and all their submissions?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            try {
              await apiFetch(`/api/admin/dealers/${dealer.id}`, { method: "DELETE" });
              setDealers((prev) => prev.filter((d) => d.id !== dealer.id));
            } catch (e: any) {
              Alert.alert("Error", e.message || "Failed to remove");
            }
          },
        },
      ]
    );
  };

  const renderItem = ({ item }: { item: Dealer }) => (
    <View style={styles.card} testID={`dealer-card-${item.id}`}>
      <View style={styles.cardTop}>
        <View style={styles.avatar}>
          <Ionicons name="person" size={22} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.name}>
            {item.dealer_info.first_name} {item.dealer_info.last_name}
          </Text>
          <Text style={styles.company}>{item.company_info.company_name}</Text>
        </View>
        <TouchableOpacity
          testID={`remove-dealer-${item.id}`}
          style={styles.removeBtn}
          onPress={() => confirmDelete(item)}
        >
          <Ionicons name="trash-outline" size={18} color={colors.danger} />
        </TouchableOpacity>
      </View>
      <View style={styles.meta}>
        <View style={styles.metaItem}>
          <Ionicons name="mail-outline" size={13} color={colors.textSecondary} />
          <Text style={styles.metaText}>{item.email}</Text>
        </View>
        {item.dealer_info.phone ? (
          <View style={styles.metaItem}>
            <Ionicons name="call-outline" size={13} color={colors.textSecondary} />
            <Text style={styles.metaText}>{item.dealer_info.phone}</Text>
          </View>
        ) : null}
        <View style={styles.metaItem}>
          <Ionicons name="car-outline" size={13} color={colors.textSecondary} />
          <Text style={styles.metaText}>{item.submission_count} submissions</Text>
        </View>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Manage Dealers</Text>
        <Text style={styles.headerSub}>{dealers.length} registered</Text>
      </View>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : dealers.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="people-outline" size={64} color={colors.textDisabled} />
          <Text style={styles.emptyTitle}>No dealers yet</Text>
          <Text style={styles.emptyText}>Dealers will appear here once they register</Text>
        </View>
      ) : (
        <FlatList
          data={dealers}
          keyExtractor={(i) => i.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load();
              }}
              tintColor={colors.primary}
            />
          }
        />
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
  headerTitle: { color: colors.text, fontSize: 22, fontWeight: "700", fontFamily: fonts.serif, letterSpacing: 0.3 },
  headerSub: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  list: { padding: spacing.md, paddingBottom: spacing.xl },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  cardTop: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.paper,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  name: { color: colors.text, fontSize: 16, fontWeight: "700" },
  company: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  removeBtn: {
    padding: 10,
    borderRadius: radius.sm,
    backgroundColor: colors.danger + "22",
  },
  meta: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 4,
  },
  metaItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  metaText: { color: colors.textSecondary, fontSize: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm, padding: spacing.lg },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: "700", marginTop: spacing.sm },
  emptyText: { color: colors.textSecondary, fontSize: 14, textAlign: "center" },
});
