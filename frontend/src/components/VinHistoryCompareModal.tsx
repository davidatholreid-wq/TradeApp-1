/**
 * VinHistoryCompareModal
 *
 * Admin-cockpit modal that lets Fourbuy staff view a NEW incoming
 * submission side-by-side with a previous submission for the SAME VIN
 * (any dealership). Read-only — no edits.
 *
 * When there are 2+ previous matches the admin gets a picker to choose
 * which one to compare against; single-match auto-selects the only
 * candidate.
 */
import { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Modal,
  ScrollView,
  Image,
  Platform,
  useWindowDimensions,
} from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { spacing, radius } from "@/src/theme";

// ---- Types ---------------------------------------------------------------
type MatchSub = {
  id: string;
  reference?: string;
  status?: string;
  created_at?: string;
  priced_at?: string;
  price?: number | null;
  price_notes?: string | null;
  year?: number | null;
  make_name?: string | null;
  model_name?: string | null;
  derivative_name?: string | null;
  colour?: string | null;
  mileage?: number | null;
  vin?: string | null;
  photos?: Record<string, string | null> | null;
  mechanical_condition?: string | null;
  cosmetic_condition?: string | null;
  interior_condition?: string | null;
  history_condition?: string | null;
  dealer_name?: string | null;
  company_name?: string | null;
  submitted_by_name?: string | null;
  dealer_offer_zar?: number | null;
  notes?: string | null;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  current: MatchSub | null;
  matches: MatchSub[];
};

// ---- Helpers -------------------------------------------------------------
const fmtZar = (v?: number | null) =>
  typeof v === "number" ? `R ${v.toLocaleString("en-ZA")}` : "—";
const fmtKm = (v?: number | null) =>
  typeof v === "number" ? `${v.toLocaleString("en-ZA")} km` : "—";
const fmtDate = (iso?: string | null) => (iso ? iso.slice(0, 10) : "—");
const pick = <T,>(v: T | null | undefined, fallback: string = "—") =>
  v === null || v === undefined || v === "" ? fallback : String(v);

function heroPhoto(m: MatchSub): string | null {
  const p = m.photos || {};
  return (p.front || p.side || p.back || null) as string | null;
}

// ---- Component -----------------------------------------------------------
export default function VinHistoryCompareModal({
  visible,
  onClose,
  current,
  matches,
}: Props) {
  const colors = useThemeColors();
  const { width: winW } = useWindowDimensions();
  const isWide = winW >= 900;
  const styles = useMemo(() => makeStyles(colors, isWide), [colors, isWide]);

  const [pickedId, setPickedId] = useState<string | null>(null);

  // Auto-select when only one candidate.
  useEffect(() => {
    if (!visible) return;
    if (matches.length === 1) setPickedId(matches[0].id);
    else if (matches.length > 1) setPickedId(null);
  }, [visible, matches]);

  const picked = matches.find((m) => m.id === pickedId) || null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          {/* Header */}
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.eyebrow}>VIN MATCH · READ ONLY</Text>
              <Text style={styles.title}>Previous submission found</Text>
              <Text style={styles.sub}>
                This VIN{" "}
                <Text style={styles.vinMono}>{current?.vin || "—"}</Text> has been
                submitted{" "}
                <Text style={styles.bold}>
                  {matches.length} {matches.length === 1 ? "time" : "times"}
                </Text>{" "}
                previously.
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} testID="vin-compare-close">
              <Ionicons name="close" size={20} color={colors.text} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={{ paddingBottom: spacing.lg }}>
            {/* Picker (only if >1 candidate) */}
            {matches.length > 1 ? (
              <View style={styles.pickerBox}>
                <Text style={styles.pickerLabel}>
                  Select a previous submission to compare against:
                </Text>
                {matches.map((m) => {
                  const active = m.id === pickedId;
                  return (
                    <TouchableOpacity
                      key={m.id}
                      onPress={() => setPickedId(m.id)}
                      style={[styles.pickerRow, active && styles.pickerRowActive]}
                      testID={`vin-compare-pick-${m.reference}`}
                    >
                      <Ionicons
                        name={active ? "radio-button-on" : "radio-button-off"}
                        size={18}
                        color={active ? colors.primary : colors.textSecondary}
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.pickerRef}>{m.reference || m.id}</Text>
                        <Text style={styles.pickerMeta}>
                          {fmtDate(m.created_at)} · {pick(m.dealer_name)}{" "}
                          {m.company_name ? `(${m.company_name})` : ""}
                        </Text>
                      </View>
                      <Text style={styles.pickerPrice}>{fmtZar(m.price)}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : null}

            {/* Side-by-side compare */}
            {picked && current ? (
              <View style={styles.compareRow}>
                <CompareCard label="THIS SUBMISSION" sub={current} accent={colors.primary} styles={styles} colors={colors} />
                <CompareCard label="PREVIOUS SUBMISSION" sub={picked} accent={colors.textSecondary} styles={styles} colors={colors} />
              </View>
            ) : matches.length > 1 ? (
              <Text style={styles.emptyHint}>Choose a previous submission above to compare.</Text>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ---- Compare card --------------------------------------------------------
function CompareCard({
  label,
  sub,
  accent,
  styles,
  colors,
}: {
  label: string;
  sub: MatchSub;
  accent: string;
  styles: ReturnType<typeof makeStyles>;
  colors: Palette;
}) {
  const hero = heroPhoto(sub);
  const title = [sub.year, sub.make_name].filter(Boolean).join(" ");
  const derivative = sub.derivative_name || sub.model_name || "";
  const rows: [string, string][] = [
    ["Reference", pick(sub.reference)],
    ["Submitted", fmtDate(sub.created_at)],
    ["Priced", fmtDate(sub.priced_at)],
    ["Dealer", pick(sub.dealer_name)],
    ["Company", pick(sub.company_name)],
    ["Submitted by", pick(sub.submitted_by_name)],
    ["Mileage", fmtKm(sub.mileage)],
    ["Colour", pick(sub.colour)],
    ["Fourbuy Price", fmtZar(sub.price)],
    ["Dealer Offer", fmtZar(sub.dealer_offer_zar)],
    ["Mechanical", pick(sub.mechanical_condition)],
    ["Cosmetic", pick(sub.cosmetic_condition)],
    ["Interior", pick(sub.interior_condition)],
    ["History", pick(sub.history_condition)],
    ["Status", (sub.status || "—").toUpperCase()],
  ];
  return (
    <View style={styles.card2}>
      <View style={[styles.cardStripe, { backgroundColor: accent }]}>
        <Text style={styles.cardStripeText}>{label}</Text>
      </View>
      <View style={styles.hero}>
        {hero ? (
          <Image source={{ uri: hero }} style={styles.heroImg} resizeMode="cover" />
        ) : (
          <View style={styles.heroFallback}>
            <Ionicons name="car" size={40} color={colors.textDisabled} />
          </View>
        )}
      </View>
      <View style={styles.cardBody}>
        <Text style={styles.heroTitle}>{title || "—"}</Text>
        {derivative ? <Text style={styles.heroSub}>{derivative}</Text> : null}
        <View style={{ height: 8 }} />
        {rows.map(([k, v]) => (
          <View key={k} style={styles.row}>
            <Text style={styles.rowLabel}>{k}</Text>
            <Text style={styles.rowValue} numberOfLines={2}>
              {v}
            </Text>
          </View>
        ))}
        {sub.price_notes ? (
          <View style={{ marginTop: 8 }}>
            <Text style={styles.rowLabel}>PRICE NOTES</Text>
            <Text style={styles.notes}>{sub.price_notes}</Text>
          </View>
        ) : null}
        {sub.notes ? (
          <View style={{ marginTop: 8 }}>
            <Text style={styles.rowLabel}>NOTES</Text>
            <Text style={styles.notes}>{sub.notes}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

// ---- Styles --------------------------------------------------------------
const makeStyles = (colors: Palette, isWide: boolean) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.85)",
      justifyContent: "center",
      alignItems: "center",
      padding: isWide ? spacing.lg : 0,
    },
    card: {
      backgroundColor: colors.card,
      borderRadius: isWide ? radius.lg : 0,
      borderWidth: 1,
      borderColor: colors.borderLight,
      maxHeight: isWide ? "90%" : "100%",
      width: "100%",
      maxWidth: isWide ? 1200 : undefined,
      overflow: "hidden",
    },
    header: {
      flexDirection: "row",
      alignItems: "flex-start",
      padding: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.paper,
    },
    eyebrow: {
      color: colors.textSecondary,
      fontSize: 10,
      fontWeight: "800",
      letterSpacing: 2,
      marginBottom: 4,
    },
    title: {
      color: colors.text,
      fontSize: 20,
      fontWeight: "900",
      letterSpacing: 0.2,
      marginBottom: 4,
    },
    sub: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
    vinMono: {
      fontFamily: Platform.OS === "web" ? "monospace" : "Courier",
      fontWeight: "800",
      color: colors.text,
    },
    bold: { fontWeight: "900", color: colors.text },
    closeBtn: {
      padding: 8,
      borderRadius: 8,
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
    },

    // Picker
    pickerBox: {
      padding: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: 6,
    },
    pickerLabel: {
      color: colors.textSecondary,
      fontSize: 11,
      fontWeight: "800",
      letterSpacing: 1.5,
      marginBottom: 4,
    },
    pickerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      padding: spacing.md,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      backgroundColor: colors.paper,
    },
    pickerRowActive: {
      borderColor: colors.primary,
      backgroundColor: colors.card,
    },
    pickerRef: { color: colors.text, fontWeight: "900", fontSize: 14 },
    pickerMeta: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
    pickerPrice: { color: colors.text, fontWeight: "800", fontSize: 13 },

    emptyHint: {
      color: colors.textSecondary,
      textAlign: "center",
      padding: spacing.lg,
    },

    // Compare
    compareRow: {
      padding: spacing.lg,
      flexDirection: isWide ? "row" : "column",
      gap: spacing.md,
    },
    card2: {
      flex: 1,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      backgroundColor: colors.paper,
      overflow: "hidden",
    },
    cardStripe: {
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
    },
    cardStripeText: {
      color: "#fff",
      fontSize: 10,
      fontWeight: "900",
      letterSpacing: 2,
    },
    hero: {
      width: "100%",
      aspectRatio: 16 / 10,
      backgroundColor: colors.card,
    },
    heroImg: { width: "100%", height: "100%" },
    heroFallback: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    cardBody: { padding: spacing.md },
    heroTitle: { color: colors.text, fontWeight: "900", fontSize: 18 },
    heroSub: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
    row: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      paddingVertical: 4,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: spacing.md,
    },
    rowLabel: {
      color: colors.textSecondary,
      fontSize: 11,
      fontWeight: "800",
      letterSpacing: 1,
      textTransform: "uppercase",
      flexShrink: 0,
      width: 110,
    },
    rowValue: {
      color: colors.text,
      fontSize: 13,
      fontWeight: "600",
      flex: 1,
      textAlign: "right",
    },
    notes: {
      color: colors.text,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 4,
      backgroundColor: colors.card,
      padding: spacing.sm,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: colors.border,
    },
  });
