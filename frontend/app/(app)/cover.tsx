/**
 * Give Cover — pricing-agent workspace.
 *
 * Two-tab layout:
 *   • Cars available to cover   — blind submissions the agent hasn't
 *     yet covered. Each card shows a real photo thumbnail.
 *   • Cover given               — the agent's own binding covers so
 *     far. Tap into any of them to update the cover (each update
 *     bills another R10). Ordered by most-recent update.
 *
 * List rows navigate directly to /vehicle/{id}?cover=1 so the vehicle
 * detail loads inline (no double-hop through /cover/[id] which was
 * causing a flash-of-white on some devices).
 */
import { useEffect, useState, useCallback, useMemo } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  Image, RefreshControl,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/src/context/AuthContext";
import { apiFetch } from "@/src/api";
import { useThemeColors } from "@/src/theme/ThemeContext";
import { spacing, radius, fonts } from "@/src/theme";

type CoverSub = {
  id: string;
  reference?: string;
  make_name?: string;
  model_name?: string;
  derivative_name?: string;
  year_of_production?: number;
  year_registered?: number;
  mileage?: number;
  thumbnail?: string | null;
  photos?: any;
  fuel_type?: string;
  transmission?: string;
  status?: string;
  my_cover?: {
    price_zar: number;
    created_at: string;
    updated_at?: string;
    history?: { price_zar: number; at: string }[];
  } | null;
};

type Tab = "available" | "given";

export default function GiveCoverScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const colors = useThemeColors();
  const [subs, setSubs] = useState<CoverSub[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>("available");

  const load = useCallback(async () => {
    try {
      const r = await apiFetch("/api/cover/submissions");
      setSubs((r as any).submissions || []);
    } catch (e) {
      console.warn("cover load failed", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const available = useMemo(() => subs.filter((s) => !s.my_cover), [subs]);
  const given = useMemo(
    () => subs.filter((s) => s.my_cover)
      .sort((a, b) => (
        (b.my_cover?.updated_at || b.my_cover?.created_at || "") <
        (a.my_cover?.updated_at || a.my_cover?.created_at || "") ? -1 : 1
      )),
    [subs],
  );
  const shown = tab === "available" ? available : given;

  if (!user?.is_pricing_agent) {
    return (
      <View style={[styles.blockedWrap, { backgroundColor: colors.background }]}>
        <Ionicons name="lock-closed-outline" size={36} color={colors.textDisabled} />
        <Text style={[styles.blockedTitle, { color: colors.text }]}>Pricing Agent access only</Text>
        <Text style={[styles.blockedSub, { color: colors.textSecondary }]}>
          Ask a Fourbuy admin to enable pricing-agent permissions on your account.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={{ padding: spacing.md, paddingBottom: 80 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => { setRefreshing(true); load(); }}
          tintColor={colors.primary}
        />
      }
    >
      <Text style={[styles.heading, { color: colors.text }]}>Give Cover</Text>
      <Text style={[styles.subheading, { color: colors.textSecondary }]}>
        Place a binding cover on any submission below. Each cover costs R10 and
        is billed to your next invoice. Covers are binding subject to physical
        inspection. You can update a cover you&apos;ve already placed — every
        update is billed R10.
      </Text>

      {/* Tab switch — Available to Cover / Cover given */}
      <View style={styles.tabRow}>
        <TouchableOpacity
          testID="cover-tab-available"
          style={[
            styles.tabBtn,
            { borderColor: colors.border, backgroundColor: colors.card },
            tab === "available" && { borderColor: colors.primary, borderWidth: 2 },
          ]}
          onPress={() => setTab("available")}
        >
          <Ionicons
            name="car-sport-outline"
            size={15}
            color={tab === "available" ? colors.text : colors.textSecondary}
          />
          <Text style={[
            styles.tabBtnText,
            { color: tab === "available" ? colors.text : colors.textSecondary },
          ]}>
            Available to Cover · {available.length}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="cover-tab-given"
          style={[
            styles.tabBtn,
            { borderColor: colors.border, backgroundColor: colors.card },
            tab === "given" && { borderColor: colors.primary, borderWidth: 2 },
          ]}
          onPress={() => setTab("given")}
        >
          <Ionicons
            name="checkmark-done-outline"
            size={15}
            color={tab === "given" ? colors.text : colors.textSecondary}
          />
          <Text style={[
            styles.tabBtnText,
            { color: tab === "given" ? colors.text : colors.textSecondary },
          ]}>
            Cover given · {given.length}
          </Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
      ) : shown.length === 0 ? (
        <View style={[styles.emptyBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Ionicons
            name={tab === "available" ? "search-outline" : "receipt-outline"}
            size={30}
            color={colors.textDisabled}
          />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>
            {tab === "available" ? "No submissions to cover" : "No covers placed yet"}
          </Text>
          <Text style={{ color: colors.textSecondary, textAlign: "center", fontSize: 12 }}>
            {tab === "available"
              ? "Pull to refresh — new submissions land here as dealers submit them."
              : "Head to Cars available to place your first binding cover."}
          </Text>
        </View>
      ) : (
        shown.map((s) => {
          const thumb = s.thumbnail;
          const year = s.year_of_production ?? s.year_registered;
          const meta = [
            year,
            s.mileage ? `${s.mileage.toLocaleString()} km` : null,
            s.fuel_type,
            s.transmission,
          ].filter(Boolean).join(" · ");
          const covered = !!s.my_cover;
          const historyCount = (s.my_cover?.history || []).length;
          return (
            <TouchableOpacity
              key={s.id}
              testID={`cover-row-${s.id}`}
              style={[
                styles.card,
                { backgroundColor: colors.card, borderColor: colors.border },
                covered && { borderColor: colors.success + "88" },
              ]}
              onPress={() =>
                router.push({
                  pathname: "/vehicle/[id]",
                  params: { id: s.id, cover: "1" },
                })
              }
              activeOpacity={0.85}
            >
              {thumb ? (
                <Image source={{ uri: thumb }} style={styles.thumb} resizeMode="cover" />
              ) : (
                <View style={[styles.thumb, styles.thumbEmpty, { backgroundColor: colors.paper }]}>
                  <Ionicons name="car-outline" size={30} color={colors.textDisabled} />
                </View>
              )}
              <View style={styles.cardBody}>
                <View style={styles.cardTopRow}>
                  <Text style={[styles.ref, { color: colors.textSecondary }]}>
                    {s.reference || s.id.slice(0, 8)}
                  </Text>
                  {covered ? (
                    <View style={[styles.pill, { backgroundColor: colors.success + "22" }]}>
                      <Ionicons name="shield-checkmark" size={11} color={colors.success} />
                      <Text style={[styles.pillText, { color: colors.success }]}>
                        R{s.my_cover!.price_zar.toLocaleString()}
                      </Text>
                    </View>
                  ) : (
                    <View style={[styles.pill, { backgroundColor: colors.primary + "22" }]}>
                      <Text style={[styles.pillText, { color: colors.primary }]}>Cover this</Text>
                    </View>
                  )}
                </View>
                <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
                  {[s.make_name, s.model_name].filter(Boolean).join(" ")}
                </Text>
                {s.derivative_name ? (
                  <Text style={[styles.deriv, { color: colors.textSecondary }]} numberOfLines={1}>
                    {s.derivative_name}
                  </Text>
                ) : null}
                {meta ? (
                  <Text style={[styles.meta, { color: colors.textDisabled }]}>{meta}</Text>
                ) : null}
                {covered ? (
                  <Text style={[styles.updatedAt, { color: colors.textDisabled }]}>
                    {historyCount > 0
                      ? `Updated ${new Date(s.my_cover!.updated_at || s.my_cover!.created_at).toLocaleDateString()} · ${historyCount + 1} version${historyCount ? "s" : ""}`
                      : `Placed ${new Date(s.my_cover!.created_at).toLocaleDateString()}`}
                  </Text>
                ) : null}
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textDisabled} />
            </TouchableOpacity>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 22, fontWeight: "800", marginBottom: 6 },
  subheading: { fontSize: 12, lineHeight: 17, marginBottom: spacing.md },
  tabRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  tabBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  tabBtnText: {
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  thumb: {
    width: 96,
    height: 72,
    borderRadius: 10,
    backgroundColor: "#000",
  },
  thumbEmpty: { alignItems: "center", justifyContent: "center" },
  cardBody: { flex: 1, minWidth: 0 },
  cardTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 2,
    gap: spacing.sm,
  },
  ref: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.8,
    fontFamily: fonts.mono,
  },
  name: { fontSize: 15, fontWeight: "800" },
  deriv: { fontSize: 12, marginTop: 1 },
  meta: { fontSize: 11, marginTop: 4 },
  updatedAt: { fontSize: 10, marginTop: 6, fontStyle: "italic" },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  pillText: { fontSize: 11, fontWeight: "800" },
  blockedWrap: {
    flex: 1, alignItems: "center", justifyContent: "center",
    padding: spacing.xl, gap: spacing.sm,
  },
  blockedTitle: { fontSize: 17, fontWeight: "800" },
  blockedSub: { fontSize: 13, textAlign: "center" },
  emptyBox: {
    borderWidth: 1, borderRadius: radius.md, padding: spacing.xl,
    alignItems: "center", gap: spacing.sm,
  },
  emptyTitle: { fontSize: 14, fontWeight: "800", marginTop: 4 },
});
