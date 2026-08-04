/**
 * Give Cover — pricing-agent workspace.
 *
 * Only visible to users flagged `is_pricing_agent`. Lists every priced /
 * pending submission on the platform (excluding drafts and the agent's
 * own dealership stock) so the agent can place a binding cover offer.
 * Each cover is billed R10 to the agent's dealership on their next
 * invoice. Covers are binding subject to physical inspection.
 */
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Image } from "react-native";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/src/context/AuthContext";
import { apiFetch } from "@/src/api";
import { useThemeColors } from "@/src/theme/ThemeContext";
import { spacing, radius } from "@/src/theme";

type CoverSub = {
  id: string;
  reference?: string;
  make_name?: string;
  model_name?: string;
  derivative_name?: string;
  year_of_production?: number;
  year_registered?: number;
  mileage?: number;
  photos?: string[];
  fuel_type?: string;
  transmission?: string;
  status?: string;
  my_cover?: { price_zar: number; created_at: string } | null;
};

export default function GiveCoverScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const colors = useThemeColors();
  const [subs, setSubs] = useState<CoverSub[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch("/api/cover/submissions");
      setSubs((r as any).submissions || []);
    } catch (e) {
      console.warn("cover load failed", e);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

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
    <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={{ padding: spacing.md, paddingBottom: 80 }}>
      <Text style={[styles.heading, { color: colors.text }]}>Give Cover</Text>
      <Text style={[styles.subheading, { color: colors.textSecondary }]}>
        Place a binding cover offer on any submission below. Each cover costs R10 and is billed to your next invoice. Covers are binding subject to physical inspection.
      </Text>

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
      ) : subs.length === 0 ? (
        <View style={[styles.emptyBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={{ color: colors.textSecondary }}>No submissions available for cover right now.</Text>
        </View>
      ) : (
        subs.map((s) => {
          const thumb = (s.photos || [])[0];
          const year = s.year_of_production ?? s.year_registered;
          return (
            <TouchableOpacity
              key={s.id}
              testID={`cover-row-${s.id}`}
              style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
              onPress={() => router.push({ pathname: "/cover/[id]", params: { id: s.id } })}
            >
              {thumb ? (
                <Image source={{ uri: thumb }} style={styles.thumb} resizeMode="cover" />
              ) : (
                <View style={[styles.thumb, styles.thumbEmpty, { backgroundColor: colors.paper }]}>
                  <Ionicons name="car-outline" size={26} color={colors.textDisabled} />
                </View>
              )}
              <View style={{ flex: 1, marginLeft: spacing.md }}>
                <Text style={[styles.ref, { color: colors.textSecondary }]}>{s.reference || s.id.slice(0, 8)}</Text>
                <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
                  {[s.make_name, s.model_name].filter(Boolean).join(" ")}
                </Text>
                {s.derivative_name ? (
                  <Text style={[styles.deriv, { color: colors.textSecondary }]} numberOfLines={1}>
                    {s.derivative_name}
                  </Text>
                ) : null}
                <Text style={[styles.meta, { color: colors.textDisabled }]}>
                  {[year, s.mileage ? `${s.mileage.toLocaleString()} km` : null, s.fuel_type, s.transmission].filter(Boolean).join(" · ")}
                </Text>
                {s.my_cover ? (
                  <View style={[styles.pill, { backgroundColor: colors.success + "20" }]}>
                    <Ionicons name="checkmark-circle" size={12} color={colors.success} />
                    <Text style={[styles.pillText, { color: colors.success }]}>
                      Cover placed · R{s.my_cover.price_zar.toLocaleString()}
                    </Text>
                  </View>
                ) : (
                  <View style={[styles.pill, { backgroundColor: colors.primary + "20" }]}>
                    <Text style={[styles.pillText, { color: colors.primary }]}>Tap to review & cover</Text>
                  </View>
                )}
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
  subheading: { fontSize: 13, lineHeight: 18, marginBottom: spacing.md },
  card: {
    flexDirection: "row", alignItems: "center", borderWidth: 1, borderRadius: radius.md,
    padding: spacing.md, marginBottom: spacing.sm,
  },
  thumb: { width: 72, height: 54, borderRadius: 8, backgroundColor: "#000" },
  thumbEmpty: { alignItems: "center", justifyContent: "center" },
  ref: { fontSize: 11, fontWeight: "700", letterSpacing: 0.6, marginBottom: 2 },
  name: { fontSize: 15, fontWeight: "800" },
  deriv: { fontSize: 12, marginTop: 1 },
  meta: { fontSize: 11, marginTop: 3 },
  pill: {
    alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, marginTop: 6,
  },
  pillText: { fontSize: 11, fontWeight: "700" },
  blockedWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.sm },
  blockedTitle: { fontSize: 17, fontWeight: "800" },
  blockedSub: { fontSize: 13, textAlign: "center" },
  emptyBox: {
    borderWidth: 1, borderRadius: radius.md, padding: spacing.lg, alignItems: "center",
  },
});
