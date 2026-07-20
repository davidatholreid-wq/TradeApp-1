/**
 * Kredo Vehicle Values — internal test screen.
 *
 * This lets us manually drive the full Kredo chain (makes → models → years
 * → derivatives → value) end-to-end against the live provider before we
 * wire it into the main Submit / Pricing screens.
 *
 * Route: /(app)/kredo-test  (admin-only)
 */
import { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch } from "@/src/api";
import { useAuth } from "@/src/context/AuthContext";
import { colors, spacing, radius, fonts } from "@/src/theme";
import { Redirect } from "expo-router";

type ValueResult = {
  make?: string;
  model?: string;
  variant?: string;
  year?: string;
  new_price_zar?: number | null;
  retail_price_zar?: number | null;
  market_price_zar?: number | null;
  adjusted_retail_zar?: number | null;
  adjusted_trade_zar?: number | null;
  pdf_base64?: string | null;
};

function fmt(v: number | null | undefined): string {
  if (!v || v === 0) return "—";
  return `R${v.toLocaleString("en-ZA", { maximumFractionDigits: 0 })}`;
}

export default function KredoTest() {
  const { user } = useAuth();
  const [makes, setMakes] = useState<string[]>([]);
  const [make, setMake] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [years, setYears] = useState<(number | string)[]>([]);
  const [year, setYear] = useState<string | null>(null);
  const [derivatives, setDerivatives] = useState<string[]>([]);
  const [derivative, setDerivative] = useState<string | null>(null);
  const [mileage, setMileage] = useState("50000");
  const [condition, setCondition] = useState("Good");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ValueResult | null>(null);

  useEffect(() => {
    // Only fetch when we know the user is admin — the redirect below
    // handles the dealer case.
    if (!user || user.role !== "admin") return;
    (async () => {
      setLoading(true);
      try {
        const r = await apiFetch("/api/kredo/makes");
        setMakes(r.makes || []);
      } catch (e: any) {
        Alert.alert("Kredo makes failed", e?.message || String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  // Admin-only page — a dealer landing here is redirected to their dashboard.
  if (user && user.role !== "admin") {
    return <Redirect href="/(app)/" />;
  }

  const pickMake = async (m: string) => {
    setMake(m); setModel(null); setYear(null); setDerivative(null);
    setModels([]); setYears([]); setDerivatives([]); setResult(null);
    setLoading(true);
    try {
      const r = await apiFetch(`/api/kredo/models?make=${encodeURIComponent(m)}`);
      setModels(r.models || []);
    } catch (e: any) { Alert.alert("Models failed", e?.message); }
    finally { setLoading(false); }
  };
  const pickModel = async (m: string) => {
    if (!make) return;
    setModel(m); setYear(null); setDerivative(null); setYears([]); setDerivatives([]); setResult(null);
    setLoading(true);
    try {
      const r = await apiFetch(`/api/kredo/years?make=${encodeURIComponent(make)}&model=${encodeURIComponent(m)}`);
      setYears(r.years || []);
    } catch (e: any) { Alert.alert("Years failed", e?.message); }
    finally { setLoading(false); }
  };
  const pickYear = async (y: number | string) => {
    if (!make || !model) return;
    const ys = String(y);
    setYear(ys); setDerivative(null); setDerivatives([]); setResult(null);
    setLoading(true);
    try {
      const r = await apiFetch(`/api/kredo/derivatives?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&year=${encodeURIComponent(ys)}`);
      setDerivatives(r.derivatives || []);
    } catch (e: any) { Alert.alert("Derivatives failed", e?.message); }
    finally { setLoading(false); }
  };
  const getValue = async () => {
    if (!make || !model || !year || !derivative) {
      Alert.alert("Fill all fields", "Make, model, year and derivative are required.");
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const r = await apiFetch("/api/kredo/value", {
        method: "POST",
        body: JSON.stringify({
          make, model, year, derivative,
          mileage: parseInt(mileage || "0", 10),
          condition,
        }),
      });
      setResult(r);
    } catch (e: any) { Alert.alert("Value failed", e?.message); }
    finally { setLoading(false); }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.h1}>Kredo Vehicle Values · Test</Text>
        <Text style={styles.sub}>Live end-to-end against api.kredo.co.za.</Text>

        <Section
          title={`1. Make ${make ? `· ${make}` : ""}`}
          items={makes}
          selected={make}
          onSelect={pickMake}
        />
        {make ? (
          <Section
            title={`2. Model ${model ? `· ${model}` : ""}`}
            items={models}
            selected={model}
            onSelect={pickModel}
          />
        ) : null}
        {model ? (
          <Section
            title={`3. Year ${year ? `· ${year}` : ""}`}
            items={years.map((y) => String(y))}
            selected={year}
            onSelect={pickYear}
          />
        ) : null}
        {year ? (
          <Section
            title={`4. Derivative ${derivative ? "· selected" : ""}`}
            items={derivatives}
            selected={derivative}
            onSelect={(d) => { setDerivative(d); setResult(null); }}
          />
        ) : null}

        {derivative ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>5. Vehicle context</Text>
            <View style={styles.rowInput}>
              <Text style={styles.rowLabel}>Mileage</Text>
              <TextInput
                style={styles.input}
                value={mileage}
                onChangeText={setMileage}
                keyboardType="numeric"
              />
            </View>
            <View style={styles.rowInput}>
              <Text style={styles.rowLabel}>Condition</Text>
              <View style={styles.condRow}>
                {["Excellent", "Very Good", "Good", "Fair", "Poor"].map((c) => (
                  <TouchableOpacity
                    key={c}
                    style={[styles.chip, condition === c && styles.chipActive]}
                    onPress={() => setCondition(c)}
                  >
                    <Text style={[styles.chipText, condition === c && styles.chipTextActive]}>{c}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
            <TouchableOpacity
              testID="kredo-get-value-btn"
              style={styles.primaryBtn}
              onPress={getValue}
              disabled={loading}
            >
              {loading ? <ActivityIndicator color="#000" /> : (
                <>
                  <Ionicons name="calculator" size={16} color="#000" />
                  <Text style={styles.primaryBtnText}>Get Kredo valuation</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        ) : null}

        {result ? (
          <View style={styles.resultCard}>
            <Text style={styles.resultTitle}>Kredo valuation</Text>
            <Text style={styles.resultSub}>{result.make} · {result.model} · {result.variant} · {result.year}</Text>
            <View style={styles.priceGrid}>
              <PriceBox label="New" value={result.new_price_zar} />
              <PriceBox label="Retail" value={result.retail_price_zar} />
              <PriceBox label="Adj. Retail" value={result.adjusted_retail_zar} />
              <PriceBox label="Adj. Trade" value={result.adjusted_trade_zar} highlight />
              <PriceBox label="Market" value={result.market_price_zar} />
            </View>
            {result.pdf_base64 ? (
              <Text style={styles.pdfNote}>
                <Ionicons name="document-attach" size={12} color={colors.textSecondary} />
                {"  "}PDF report returned by Kredo · {(result.pdf_base64.length / 1024).toFixed(1)} KB
              </Text>
            ) : null}
          </View>
        ) : null}

        {loading && !result ? <ActivityIndicator style={{ marginTop: spacing.md }} color={colors.primary} /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({
  title,
  items,
  selected,
  onSelect,
}: {
  title: string;
  items: string[];
  selected: string | null;
  onSelect: (v: string) => void;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      <ScrollView style={styles.pickList} nestedScrollEnabled>
        {items.map((v) => (
          <TouchableOpacity
            key={v}
            style={[styles.pickRow, selected === v && styles.pickRowActive]}
            onPress={() => onSelect(v)}
          >
            <Text style={[styles.pickText, selected === v && styles.pickTextActive]}>{v}</Text>
          </TouchableOpacity>
        ))}
        {items.length === 0 ? <Text style={styles.empty}>No results</Text> : null}
      </ScrollView>
    </View>
  );
}

function PriceBox({ label, value, highlight }: { label: string; value: number | null | undefined; highlight?: boolean }) {
  return (
    <View style={[styles.priceBox, highlight && styles.priceBoxHi]}>
      <Text style={[styles.priceLabel, highlight && { color: "#000" }]}>{label}</Text>
      <Text style={[styles.priceValue, highlight && { color: "#000" }]}>{fmt(value)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.md, paddingBottom: spacing.xxl },
  h1: { color: colors.text, fontSize: 22, fontWeight: "800" },
  sub: { color: colors.textSecondary, fontSize: 13, marginBottom: spacing.md },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  cardTitle: { color: colors.text, fontSize: 13, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", marginBottom: spacing.sm },
  pickList: { maxHeight: 220 },
  pickRow: { paddingVertical: 9, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  pickRowActive: { backgroundColor: colors.paper },
  pickText: { color: colors.text, fontSize: 13 },
  pickTextActive: { fontWeight: "800", color: colors.primary },
  empty: { color: colors.textSecondary, paddingVertical: 10, textAlign: "center", fontSize: 12 },
  rowInput: { flexDirection: "row", alignItems: "center", marginBottom: spacing.sm, gap: spacing.md },
  rowLabel: { color: colors.textSecondary, fontSize: 12, width: 70 },
  input: { flex: 1, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.paper, borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 10, color: colors.text, fontSize: 14 },
  condRow: { flex: 1, flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.paper },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.text, fontSize: 12 },
  chipTextActive: { color: "#000", fontWeight: "800" },
  primaryBtn: {
    marginTop: spacing.sm,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: 14,
  },
  primaryBtnText: { color: "#000", fontWeight: "800", fontSize: 13, letterSpacing: 1 },
  resultCard: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    padding: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  resultTitle: { color: colors.text, fontSize: 15, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" },
  resultSub: { color: colors.textSecondary, fontSize: 12, marginBottom: spacing.md, marginTop: 2 },
  priceGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  priceBox: {
    flexBasis: "48%", flexGrow: 1,
    backgroundColor: colors.paper,
    borderRadius: radius.sm,
    padding: spacing.md,
    borderWidth: 1, borderColor: colors.border,
  },
  priceBoxHi: { backgroundColor: colors.primary, borderColor: colors.primary },
  priceLabel: { color: colors.textSecondary, fontSize: 10, letterSpacing: 1.5, fontWeight: "800", textTransform: "uppercase" },
  priceValue: { color: colors.text, fontSize: 20, fontWeight: "900", marginTop: 4, fontFamily: fonts.number },
  pdfNote: { color: colors.textSecondary, fontSize: 11, marginTop: spacing.sm },
});
