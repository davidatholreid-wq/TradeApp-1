/**
 * Cover-detail screen — pricing agent inspects a submission and places
 * a binding cover offer.
 *
 * Renders the full submission (photos, condition, recon, warranty, VIN
 * reports, AI market analysis, AutoTrader deep link) but *without* the
 * Fourbuy admin Offer / admin pricing (server-stripped). Bottom action
 * bar posts the cover; each cover is R10 billed to the agent's
 * dealership on their next invoice. Covers are binding — no withdraw.
 */
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Image, TextInput, Alert, Platform, Linking } from "react-native";
import { useEffect, useState, useCallback } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch } from "@/src/api";
import { useThemeColors } from "@/src/theme/ThemeContext";
import { spacing, radius } from "@/src/theme";
import ComparableListingsCard from "@/src/components/ComparableListingsCard";

export default function CoverDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const colors = useThemeColors();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [price, setPrice] = useState("");
  const [placing, setPlacing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch(`/api/cover/submissions/${id}`);
      setData(r);
    } catch (e: any) {
      Alert.alert("Cover", e?.message || "Could not load submission.");
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const placeCover = async () => {
    const n = parseInt(price.replace(/[^0-9]/g, ""), 10);
    if (!n || n <= 0) {
      Alert.alert("Enter a valid amount", "Please enter your cover price in Rand.");
      return;
    }
    const cost = data?.cover_cost_zar ?? 10;
    const proceed = Platform.OS === "web"
      ? (globalThis as any).window?.confirm?.(
          `Confirm binding cover of R${n.toLocaleString()} — you'll be billed R${cost} to your next invoice. Cover is subject to physical inspection.`
        )
      : await new Promise<boolean>((res) => Alert.alert(
          "Confirm binding cover",
          `Cover of R${n.toLocaleString()}. You'll be billed R${cost} to your next invoice. Cover is subject to physical inspection and confirmation that all submission details are correct.`,
          [
            { text: "Cancel", style: "cancel", onPress: () => res(false) },
            { text: "Confirm", onPress: () => res(true) },
          ],
        ));
    if (!proceed) return;
    setPlacing(true);
    try {
      await apiFetch(`/api/submissions/${id}/covers`, {
        method: "POST",
        body: JSON.stringify({ price_zar: n }),
      });
      await load();
      Alert.alert("Cover placed", "Your binding cover has been recorded. R10 was added to your next invoice.");
    } catch (e: any) {
      Alert.alert("Cover", e?.message || "Could not place cover.");
    } finally {
      setPlacing(false);
    }
  };

  if (loading || !data) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  const s = data.submission || {};
  const year = s.year_of_production ?? s.year_registered;
  const my = data.my_cover;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView contentContainerStyle={{ padding: spacing.md, paddingBottom: 140 }}>
        <Text style={[styles.ref, { color: colors.textSecondary }]}>{s.reference}</Text>
        <Text style={[styles.title, { color: colors.text }]}>{[s.make_name, s.model_name].filter(Boolean).join(" ")}</Text>
        {s.derivative_name ? <Text style={[styles.deriv, { color: colors.textSecondary }]}>{s.derivative_name}</Text> : null}
        <Text style={[styles.meta, { color: colors.textDisabled }]}>
          {[year, s.mileage ? `${s.mileage.toLocaleString()} km` : null, s.fuel_type, s.transmission, s.colour].filter(Boolean).join(" · ")}
        </Text>

        {(s.photos || []).length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: spacing.md }}>
            {(s.photos || []).map((p: string, i: number) => (
              <Image key={i} source={{ uri: p }} style={styles.photo} resizeMode="cover" />
            ))}
          </ScrollView>
        ) : null}

        {/* Compare Live Listings — same URL logic dealers see */}
        <View style={{ marginTop: spacing.md }}>
          <ComparableListingsCard
            make={s.make_name}
            model={s.model_name}
            derivative={s.derivative_name}
            fuelType={s.fuel_type}
            transmission={s.transmission}
            year={year}
            yearFrom={s.variant_manufacture_range?.min ?? null}
            yearTo={s.variant_manufacture_range?.max ?? null}
          />
        </View>

        {/* AI Market Analysis */}
        {s.market_analysis?.analysis ? (
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>AI Market Analysis</Text>
            {s.market_analysis.analysis.estimated_market_range_zar ? (
              <Text style={[styles.big, { color: colors.text }]}>
                R{s.market_analysis.analysis.estimated_market_range_zar.low?.toLocaleString()} — R{s.market_analysis.analysis.estimated_market_range_zar.high?.toLocaleString()}
              </Text>
            ) : null}
            {s.market_analysis.analysis.retail_price_estimate_zar ? (
              <Text style={{ color: colors.textSecondary, marginTop: 4 }}>
                Retail estimate: R{s.market_analysis.analysis.retail_price_estimate_zar.toLocaleString()}
              </Text>
            ) : null}
            {s.market_analysis.analysis.year_positioning ? (
              <Text style={[styles.p, { color: colors.textSecondary }]}>{s.market_analysis.analysis.year_positioning}</Text>
            ) : null}
            {s.market_analysis.analysis.mileage_positioning ? (
              <Text style={[styles.p, { color: colors.textSecondary }]}>{s.market_analysis.analysis.mileage_positioning}</Text>
            ) : null}
          </View>
        ) : null}

        {/* Ordered reports by dealer */}
        {(data.report_orders || []).length > 0 ? (
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Reports ordered by dealer</Text>
            {data.report_orders.map((r: any) => (
              <View key={r.id} style={styles.reportRow}>
                <Ionicons name="document-text-outline" size={16} color={colors.primary} />
                <Text style={{ color: colors.text, flex: 1 }}>{r.name || r.type}</Text>
                <Text style={{ color: colors.textDisabled, fontSize: 11 }}>{(r.status || "").toUpperCase()}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* Recon summary */}
        {s.reconditioning_total_zar ? (
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Reconditioning</Text>
            <Text style={{ color: colors.text }}>Total: R{s.reconditioning_total_zar.toLocaleString()}</Text>
          </View>
        ) : null}
      </ScrollView>

      {/* Bottom cover-place bar */}
      <View style={[styles.bar, { backgroundColor: colors.card, borderTopColor: colors.border }]}>
        {my ? (
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.success, fontWeight: "800", fontSize: 15 }}>
              Cover placed · R{my.price_zar.toLocaleString()}
            </Text>
            <Text style={{ color: colors.textDisabled, fontSize: 11 }}>
              Binding subject to inspection. Cannot be withdrawn.
            </Text>
          </View>
        ) : (
          <>
            <View style={{ flex: 1 }}>
              <TextInput
                testID="cover-price-input"
                value={price}
                onChangeText={(t) => setPrice(t.replace(/[^0-9]/g, ""))}
                placeholder="Enter your cover (R)"
                placeholderTextColor={colors.textDisabled}
                keyboardType="numeric"
                style={[styles.input, { color: colors.text, borderColor: colors.border }]}
              />
              <Text style={{ color: colors.textDisabled, fontSize: 10, marginTop: 3 }}>
                R{data.cover_cost_zar} billed on submit. Binding subject to inspection.
              </Text>
            </View>
            <TouchableOpacity
              testID="cover-submit-btn"
              style={[styles.btn, { backgroundColor: colors.primary }, placing && { opacity: 0.6 }]}
              onPress={placeCover}
              disabled={placing}
            >
              {placing ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Place Cover</Text>}
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  ref: { fontSize: 11, fontWeight: "700", letterSpacing: 0.6 },
  title: { fontSize: 20, fontWeight: "800", marginTop: 2 },
  deriv: { fontSize: 13, marginTop: 2 },
  meta: { fontSize: 12, marginTop: 4 },
  photo: { width: 140, height: 100, borderRadius: 8, marginRight: 8, backgroundColor: "#000" },
  section: { borderWidth: 1, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.md },
  sectionTitle: { fontSize: 13, fontWeight: "800", letterSpacing: 0.5, marginBottom: 6 },
  big: { fontSize: 17, fontWeight: "800" },
  p: { fontSize: 12, marginTop: 4, lineHeight: 17 },
  reportRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  bar: {
    position: "absolute", bottom: 0, left: 0, right: 0, padding: spacing.md,
    borderTopWidth: 1, flexDirection: "row", alignItems: "center", gap: spacing.sm,
  },
  input: { borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15, fontWeight: "700" },
  btn: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: radius.sm },
  btnText: { color: "#fff", fontWeight: "800" },
});
