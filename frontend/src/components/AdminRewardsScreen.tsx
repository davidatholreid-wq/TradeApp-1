/**
 * Admin voucher-redemption inbox. Rendered inside the WebAdminDashboard when
 * `view === "rewards"`. Lists every voucher request across all dealerships
 * with Fulfil / Reject actions.
 */
import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch } from "@/src/api";
import { colors, spacing, radius, fonts } from "@/src/theme";

type Redemption = {
  id: string;
  user_id: string;
  user_name?: string | null;
  user_email?: string;
  user_job_title?: string | null;
  dealership_id?: string | null;
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

export default function AdminRewardsScreen() {
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"pending" | "fulfilled" | "rejected" | "all">("pending");
  const [actionModal, setActionModal] = useState<{ type: "fulfill" | "reject"; r: Redemption } | null>(null);
  const [voucherCode, setVoucherCode] = useState("");
  const [adminNote, setAdminNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const path = filter === "all" ? "/api/admin/reward-redemptions" : `/api/admin/reward-redemptions?status=${filter}`;
      const res = await apiFetch(path);
      setRedemptions(res.redemptions || []);
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Could not load redemptions");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const openFulfill = (r: Redemption) => {
    setActionModal({ type: "fulfill", r });
    setVoucherCode("");
    setAdminNote("");
  };
  const openReject = (r: Redemption) => {
    setActionModal({ type: "reject", r });
    setVoucherCode("");
    setAdminNote("");
  };
  const submit = async () => {
    if (!actionModal) return;
    if (actionModal.type === "fulfill" && !voucherCode.trim()) {
      Alert.alert("Voucher code required", "Paste the Takealot voucher code before sending.");
      return;
    }
    setSubmitting(true);
    try {
      const path = `/api/admin/reward-redemptions/${actionModal.r.id}/${actionModal.type}`;
      await apiFetch(path, {
        method: "POST",
        body: JSON.stringify({
          voucher_code: actionModal.type === "fulfill" ? voucherCode.trim() : undefined,
          admin_note: adminNote.trim() || undefined,
        }),
      });
      setActionModal(null);
      await load();
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Action failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.h1}>Voucher Requests</Text>
        <Text style={styles.sub}>Fulfil each request by pasting the Takealot voucher code. Rejecting refunds the user&apos;s points.</Text>
      </View>

      <View style={styles.tabs}>
        {(["pending", "fulfilled", "rejected", "all"] as const).map((f) => (
          <TouchableOpacity key={f} onPress={() => setFilter(f)} style={[styles.tab, filter === f && styles.tabActive]}>
            <Text style={[styles.tabText, filter === f && styles.tabTextActive]}>{f.toUpperCase()}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: spacing.xl }} color={colors.primary} />
      ) : redemptions.length === 0 ? (
        <Text style={styles.empty}>No redemptions {filter !== "all" ? `with status "${filter}"` : ""}.</Text>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {redemptions.map((r) => (
            <View key={r.id} style={styles.card} testID={`redemption-${r.id}`}>
              <View style={styles.cardTop}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.userName}>
                    {r.user_name || r.user_email}
                    {r.user_job_title ? <Text style={styles.jobTitle}> · {r.user_job_title}</Text> : null}
                  </Text>
                  <Text style={styles.userEmail}>Login: {r.user_email}</Text>
                  <Text style={styles.userEmail}>Send to: <Text style={styles.mono}>{r.requested_email}</Text></Text>
                  <Text style={styles.userEmail}>Requested: {r.requested_at.slice(0, 19).replace("T", " ")}</Text>
                </View>
                <View style={styles.rightCol}>
                  <Text style={styles.amount}>R{r.voucher_value_zar}</Text>
                  <Text style={styles.provider}>{r.voucher_provider}</Text>
                  <View style={[styles.statusPill, statusStyles[r.status]]}>
                    <Text style={[styles.statusPillText, statusTextStyles[r.status]]}>{r.status.toUpperCase()}</Text>
                  </View>
                </View>
              </View>
              {r.status === "fulfilled" && r.voucher_code ? (
                <View style={styles.codeBox}>
                  <Text style={styles.codeLabel}>SENT CODE</Text>
                  <Text style={styles.code}>{r.voucher_code}</Text>
                  {r.admin_note ? <Text style={styles.noteTxt}>{r.admin_note}</Text> : null}
                </View>
              ) : null}
              {r.status === "rejected" && r.admin_note ? (
                <Text style={styles.rejectNote}>Rejected: {r.admin_note}</Text>
              ) : null}
              {r.status === "pending" ? (
                <View style={styles.actionsRow}>
                  <TouchableOpacity
                    testID={`reject-${r.id}`}
                    style={[styles.actionBtn, styles.rejectBtn]}
                    onPress={() => openReject(r)}
                  >
                    <Ionicons name="close-circle-outline" size={16} color={colors.danger} />
                    <Text style={styles.rejectBtnText}>Reject & refund</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    testID={`fulfill-${r.id}`}
                    style={[styles.actionBtn, styles.fulfillBtn]}
                    onPress={() => openFulfill(r)}
                  >
                    <Ionicons name="checkmark-circle" size={16} color="#000" />
                    <Text style={styles.fulfillBtnText}>Fulfil with code</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          ))}
        </ScrollView>
      )}

      {actionModal ? (
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {actionModal.type === "fulfill" ? "Send voucher" : "Reject request"}
            </Text>
            <Text style={styles.modalSub}>
              {actionModal.r.user_name || actionModal.r.user_email} · R{actionModal.r.voucher_value_zar} {actionModal.r.voucher_provider}
            </Text>
            {actionModal.type === "fulfill" ? (
              <>
                <Text style={styles.modalLabel}>VOUCHER CODE</Text>
                <TextInput
                  testID="voucher-code-input"
                  style={styles.modalInput}
                  value={voucherCode}
                  onChangeText={setVoucherCode}
                  placeholder="TAKEALOT-XXXX-XXXX-XXXX"
                  placeholderTextColor={colors.textDisabled}
                  editable={!submitting}
                  autoCapitalize="characters"
                />
                <Text style={styles.modalHint}>
                  Paste the code you&apos;ll email to {actionModal.r.requested_email}. The dealer will see this code in-app once you send.
                </Text>
              </>
            ) : null}
            <Text style={styles.modalLabel}>NOTE {actionModal.type === "reject" ? "(shown to dealer)" : "(optional)"}</Text>
            <TextInput
              testID="admin-note-input"
              style={[styles.modalInput, { minHeight: 60 }]}
              value={adminNote}
              onChangeText={setAdminNote}
              multiline
              placeholder={actionModal.type === "reject" ? "Reason for rejection" : "Any note for the dealer"}
              placeholderTextColor={colors.textDisabled}
              editable={!submitting}
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.modalBtn, styles.modalBtnGhost]} onPress={() => setActionModal(null)} disabled={submitting}>
                <Text style={styles.modalBtnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="modal-submit"
                style={[styles.modalBtn, actionModal.type === "fulfill" ? styles.modalBtnPrimary : styles.modalBtnDanger]}
                onPress={submit}
                disabled={submitting}
              >
                {submitting ? <ActivityIndicator color="#000" /> : (
                  <Text style={actionModal.type === "fulfill" ? styles.modalBtnPrimaryText : styles.modalBtnDangerText}>
                    {actionModal.type === "fulfill" ? "Send" : "Reject"}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const statusStyles: any = {
  pending: { backgroundColor: colors.warning + "22", borderColor: colors.warning },
  fulfilled: { backgroundColor: colors.success + "22", borderColor: colors.success },
  rejected: { backgroundColor: colors.danger + "22", borderColor: colors.danger },
};
const statusTextStyles: any = {
  pending: { color: colors.warning },
  fulfilled: { color: colors.success },
  rejected: { color: colors.danger },
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: spacing.md },
  header: { marginBottom: spacing.md },
  h1: { color: colors.text, fontSize: 22, fontWeight: "800", letterSpacing: 0.4 },
  sub: { color: colors.textSecondary, fontSize: 13, marginTop: 4 },
  tabs: { flexDirection: "row", gap: 4, marginBottom: spacing.md },
  tab: { paddingHorizontal: spacing.md, paddingVertical: 8, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  tabActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  tabText: { color: colors.textSecondary, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  tabTextActive: { color: "#000" },
  empty: { color: colors.textSecondary, textAlign: "center", padding: spacing.xl },
  list: { gap: 8 },
  card: { backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  cardTop: { flexDirection: "row", gap: spacing.md },
  userName: { color: colors.text, fontSize: 14, fontWeight: "700" },
  jobTitle: { color: colors.textSecondary, fontStyle: "italic", fontWeight: "500" },
  userEmail: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  mono: { fontFamily: fonts.mono, color: colors.text },
  rightCol: { alignItems: "flex-end", gap: 4 },
  amount: { color: colors.text, fontSize: 20, fontWeight: "800", fontFamily: fonts.number },
  provider: { color: colors.textSecondary, fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, borderWidth: 1, marginTop: 4 },
  statusPillText: { fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  codeBox: { marginTop: spacing.sm, padding: spacing.sm, backgroundColor: colors.paper, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.borderLight },
  codeLabel: { color: colors.textSecondary, fontSize: 10, fontWeight: "800", letterSpacing: 1.2 },
  code: { color: colors.text, fontFamily: fonts.mono, fontSize: 14, fontWeight: "800", marginTop: 4 },
  noteTxt: { color: colors.textSecondary, fontSize: 12, marginTop: 4, fontStyle: "italic" },
  rejectNote: { color: colors.danger, fontSize: 12, marginTop: 6, fontStyle: "italic" },
  actionsRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
  actionBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: radius.sm, borderWidth: 1 },
  rejectBtn: { borderColor: colors.danger, backgroundColor: colors.danger + "12" },
  rejectBtnText: { color: colors.danger, fontWeight: "700" },
  fulfillBtn: { backgroundColor: colors.primary, borderColor: colors.primary },
  fulfillBtnText: { color: "#000", fontWeight: "800", letterSpacing: 0.4 },

  // Modal (overlays)
  modalBackdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center", padding: spacing.md },
  modalCard: { width: "100%", maxWidth: 480, backgroundColor: colors.bg, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.lg, gap: spacing.sm },
  modalTitle: { color: colors.text, fontSize: 18, fontWeight: "800", letterSpacing: 0.4 },
  modalSub: { color: colors.textSecondary, fontSize: 13 },
  modalLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: "800", letterSpacing: 1, marginTop: 4 },
  modalHint: { color: colors.textSecondary, fontSize: 12, fontStyle: "italic" },
  modalInput: {
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 14,
  },
  modalActions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
  modalBtn: { flex: 1, paddingVertical: 12, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  modalBtnGhost: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  modalBtnGhostText: { color: colors.textSecondary, fontWeight: "700" },
  modalBtnPrimary: { backgroundColor: colors.primary },
  modalBtnPrimaryText: { color: "#000", fontWeight: "800", letterSpacing: 1 },
  modalBtnDanger: { backgroundColor: colors.danger },
  modalBtnDangerText: { color: "#fff", fontWeight: "800", letterSpacing: 1 },
});
