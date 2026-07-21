import { useCallback, useState, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Modal,
  TextInput,
  Alert,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { apiFetch } from "@/src/api";
import { useAuth } from "@/src/context/AuthContext";
import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { TakealotVoucherCard } from "@/src/components/TakealotVoucherCard";

type Redemption = {
  id: string;
  requested_email: string;
  points_cost: number;
  voucher_value_zar: number;
  voucher_provider: string;
  status: "pending" | "fulfilled" | "rejected";
  voucher_code?: string | null;
  admin_note?: string | null;
  requested_at: string;
  actioned_at?: string | null;
};
type LedgerEntry = {
  id: string;
  type: "earn" | "spend" | "refund" | "fulfill" | "adjust";
  delta: number;
  note?: string;
  at: string;
};
type RewardsSummary = {
  label: string;
  balance: number;
  points_per_voucher: number;
  voucher_value_zar: number;
  voucher_provider: string;
  can_redeem: boolean;
  points_to_next_voucher: number;
  totals: { earned: number; spent: number; refunded: number };
  ledger: LedgerEntry[];
  redemptions: Redemption[];
};

export default function RewardsScreen() {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { user } = useAuth();
  const tabBarHeight = useBottomTabBarHeight();
  const [data, setData] = useState<RewardsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [redeemEmail, setRedeemEmail] = useState(user?.email ?? "");
  const [redeemSubmitting, setRedeemSubmitting] = useState(false);
  const [redeemError, setRedeemError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/rewards/me");
      setData(res);
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Could not load rewards");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    setLoading(true);
    load();
  }, [load]));

  const submitRedeem = async () => {
    setRedeemError(null);
    if (!redeemEmail.trim()) {
      setRedeemError("Delivery email is required");
      return;
    }
    setRedeemSubmitting(true);
    try {
      await apiFetch("/api/rewards/redeem", {
        method: "POST",
        body: JSON.stringify({ desired_email: redeemEmail.trim().toLowerCase() }),
      });
      setRedeemOpen(false);
      await load();
      Alert.alert(
        "Redemption submitted",
        "Your points have been deducted and Fourbuy will action your voucher shortly.",
      );
    } catch (e: any) {
      setRedeemError(e?.message || "Could not redeem");
    } finally {
      setRedeemSubmitting(false);
    }
  };

  if (loading || !data) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator style={{ marginTop: spacing.xl }} color={colors.primary} />
      </SafeAreaView>
    );
  }

  const progress = Math.min(1, data.balance / data.points_per_voucher);
  const statusStyles = buildStatusStyles(colors);
  const statusTextStyles = buildStatusTextStyles(colors);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: tabBarHeight + spacing.xxl }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />
        }
      >
        <Text style={styles.h1}>{data.label}</Text>
        <Text style={styles.sub}>
          Earn 1 point for every billable valuation. Redeem {data.points_per_voucher} points for a
          R{data.voucher_value_zar} {data.voucher_provider} voucher.
        </Text>

        {/* Voucher preview */}
        <TakealotVoucherCard
          value={data.voucher_value_zar}
          pointsRequired={data.points_per_voucher}
          unlocked={data.can_redeem}
        />

        {/* Balance hero */}
        <View style={styles.hero}>
          <Text style={styles.heroLabel}>YOUR BALANCE</Text>
          <Text testID="rewards-balance" style={styles.heroValue}>
            {data.balance}
            <Text style={styles.heroValueSuffix}> pts</Text>
          </Text>
          <View style={styles.progressWrap}>
            <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
          </View>
          <Text style={styles.progressLabel}>
            {data.can_redeem
              ? `Ready to redeem for a R${data.voucher_value_zar} ${data.voucher_provider} voucher`
              : `${data.points_to_next_voucher} more point${data.points_to_next_voucher === 1 ? "" : "s"} until your next voucher`}
          </Text>
          <TouchableOpacity
            testID="rewards-redeem-btn"
            style={[styles.redeemBtn, !data.can_redeem && styles.redeemBtnDisabled]}
            onPress={() => {
              setRedeemEmail(user?.email ?? "");
              setRedeemError(null);
              setRedeemOpen(true);
            }}
            disabled={!data.can_redeem}
          >
            <Ionicons name="gift-outline" size={18} color={data.can_redeem ? "#000" : colors.textDisabled} />
            <Text style={[styles.redeemBtnText, !data.can_redeem && { color: colors.textDisabled }]}>Redeem voucher</Text>
          </TouchableOpacity>
        </View>

        {/* Stats */}
        <View style={styles.statsRow}>
          <Stat label="EARNED" value={data.totals.earned} />
          <Stat label="SPENT" value={data.totals.spent} />
          <Stat label="REFUNDED" value={data.totals.refunded} />
        </View>

        {/* Redemptions */}
        {data.redemptions.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>Redemptions</Text>
            {data.redemptions.map((r) => (
              <View key={r.id} style={styles.redemptionCard}>
                <View style={styles.redRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.redAmount}>R{r.voucher_value_zar} {r.voucher_provider}</Text>
                    <Text style={styles.redEmail}>→ {r.requested_email}</Text>
                    <Text style={styles.redDate}>{r.requested_at.slice(0, 10)}</Text>
                  </View>
                  <View style={[styles.statusPill, statusStyles[r.status]]}>
                    <Text style={[styles.statusPillText, statusTextStyles[r.status]]}>{r.status.toUpperCase()}</Text>
                  </View>
                </View>
                {r.status === "fulfilled" && r.voucher_code ? (
                  <View style={styles.voucherCodeBox}>
                    <Text style={styles.voucherCodeLabel}>VOUCHER CODE</Text>
                    <Text testID={`voucher-code-${r.id}`} style={styles.voucherCode}>{r.voucher_code}</Text>
                    {r.admin_note ? <Text style={styles.voucherNote}>{r.admin_note}</Text> : null}
                  </View>
                ) : null}
                {r.status === "rejected" && r.admin_note ? (
                  <Text style={styles.rejectNote}>Rejected: {r.admin_note}</Text>
                ) : null}
              </View>
            ))}
          </>
        ) : null}

        {/* Ledger */}
        {data.ledger.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>Points activity</Text>
            {data.ledger.slice(0, 30).map((e) => (
              <View key={e.id} style={styles.ledgerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.ledgerNote}>{e.note || e.type}</Text>
                  <Text style={styles.ledgerDate}>{e.at.slice(0, 10)}</Text>
                </View>
                <Text style={[
                  styles.ledgerDelta,
                  e.delta > 0 && { color: colors.success },
                  e.delta < 0 && { color: colors.danger },
                ]}>
                  {e.delta > 0 ? "+" : ""}{e.delta} pt
                </Text>
              </View>
            ))}
          </>
        ) : (
          <Text style={styles.emptyText}>No activity yet — earn your first point when your next valuation is priced within 24 hours.</Text>
        )}
      </ScrollView>

      {/* Redeem modal */}
      <Modal visible={redeemOpen} transparent animationType="slide" onRequestClose={() => setRedeemOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Redeem R{data.voucher_value_zar} {data.voucher_provider}</Text>
              <TouchableOpacity onPress={() => setRedeemOpen(false)}>
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalHint}>
              {data.points_per_voucher} points will be deducted immediately.
              If Fourbuy is unable to fulfil, your points will be refunded.
            </Text>
            <Text style={styles.modalLabel}>DELIVERY EMAIL</Text>
            <TextInput
              testID="redeem-email-input"
              style={styles.modalInput}
              value={redeemEmail}
              onChangeText={setRedeemEmail}
              placeholder="voucher@example.com"
              placeholderTextColor={colors.textDisabled}
              autoCapitalize="none"
              keyboardType="email-address"
              editable={!redeemSubmitting}
            />
            {redeemError ? <Text style={styles.modalError}>{redeemError}</Text> : null}
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnGhost]}
                onPress={() => setRedeemOpen(false)}
                disabled={redeemSubmitting}
              >
                <Text style={styles.modalBtnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="redeem-submit"
                style={[styles.modalBtn, styles.modalBtnPrimary]}
                onPress={submitRedeem}
                disabled={redeemSubmitting}
              >
                {redeemSubmitting ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.modalBtnPrimaryText}>Confirm</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.statCard}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const buildStatusStyles = (colors: Palette) => ({
  pending: { backgroundColor: colors.warning + "22", borderColor: colors.warning },
  fulfilled: { backgroundColor: colors.success + "22", borderColor: colors.success },
  rejected: { backgroundColor: colors.danger + "22", borderColor: colors.danger },
} as Record<string, any>);
const buildStatusTextStyles = (colors: Palette) => ({
  pending: { color: colors.warning },
  fulfilled: { color: colors.success },
  rejected: { color: colors.danger },
} as Record<string, any>);

const makeStyles = (colors: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.md, gap: spacing.md },
  h1: { color: colors.text, fontSize: 24, fontWeight: "800", letterSpacing: 0.5, fontFamily: fonts.heading },
  sub: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
  hero: {
    backgroundColor: colors.card,
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    gap: 6,
  },
  heroLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: "800", letterSpacing: 1.4 },
  heroValue: { color: colors.text, fontSize: 56, fontWeight: "900", fontFamily: fonts.number, letterSpacing: -1 },
  heroValueSuffix: { fontSize: 20, fontWeight: "700", color: colors.textSecondary },
  progressWrap: { width: "100%", height: 8, backgroundColor: colors.paper, borderRadius: 4, overflow: "hidden", marginTop: 8 },
  progressFill: { height: "100%", backgroundColor: colors.primary },
  progressLabel: { color: colors.textSecondary, fontSize: 12, marginTop: 6, textAlign: "center" },
  redeemBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: spacing.md,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.xl,
    paddingVertical: 12,
    borderRadius: radius.md,
  },
  redeemBtnDisabled: { backgroundColor: colors.border },
  redeemBtnText: { color: colors.onPrimary, fontWeight: "800", letterSpacing: 1 },
  statsRow: { flexDirection: "row", gap: spacing.sm },
  statCard: { flex: 1, backgroundColor: colors.card, padding: spacing.md, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, alignItems: "center" },
  statLabel: { color: colors.textSecondary, fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  statValue: { color: colors.text, fontSize: 18, fontWeight: "800", fontFamily: fonts.number, marginTop: 4 },
  sectionTitle: { color: colors.text, fontSize: 13, fontWeight: "800", letterSpacing: 1, marginTop: spacing.md, marginBottom: 4 },
  redemptionCard: { backgroundColor: colors.card, padding: spacing.md, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, marginBottom: 8 },
  redRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  redAmount: { color: colors.text, fontSize: 15, fontWeight: "800" },
  redEmail: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  redDate: { color: colors.textDisabled, fontSize: 11, marginTop: 2 },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, borderWidth: 1 },
  statusPillText: { fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  voucherCodeBox: { marginTop: spacing.sm, padding: spacing.md, backgroundColor: colors.paper, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.borderLight },
  voucherCodeLabel: { color: colors.textSecondary, fontSize: 10, fontWeight: "800", letterSpacing: 1.2 },
  voucherCode: { color: colors.text, fontFamily: fonts.mono, fontSize: 16, fontWeight: "800", letterSpacing: 1, marginTop: 4 },
  voucherNote: { color: colors.textSecondary, fontSize: 12, marginTop: 4, fontStyle: "italic" },
  rejectNote: { color: colors.danger, fontSize: 12, marginTop: 6, fontStyle: "italic" },
  ledgerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  ledgerNote: { color: colors.text, fontSize: 13 },
  ledgerDate: { color: colors.textDisabled, fontSize: 11, marginTop: 2 },
  ledgerDelta: { color: colors.text, fontFamily: fonts.mono, fontSize: 14, fontWeight: "800" },
  emptyText: { color: colors.textSecondary, fontSize: 12, textAlign: "center", padding: spacing.lg },

  // Modal
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  modalCard: { backgroundColor: colors.bg, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, paddingBottom: spacing.lg },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  modalTitle: { color: colors.text, fontSize: 16, fontWeight: "800", letterSpacing: 0.4, flex: 1 },
  modalHint: { color: colors.textSecondary, fontSize: 12, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  modalLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: "800", letterSpacing: 1, marginBottom: 6, marginHorizontal: spacing.md },
  modalInput: {
    marginHorizontal: spacing.md,
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 14,
  },
  modalError: { color: colors.danger, fontSize: 13, paddingHorizontal: spacing.md, paddingTop: 6 },
  modalActions: { flexDirection: "row", gap: spacing.sm, padding: spacing.md },
  modalBtn: { flex: 1, paddingVertical: 12, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  modalBtnGhost: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  modalBtnGhostText: { color: colors.textSecondary, fontWeight: "700" },
  modalBtnPrimary: { backgroundColor: colors.primary },
  modalBtnPrimaryText: { color: colors.onPrimary, fontWeight: "800", letterSpacing: 1 },
});
