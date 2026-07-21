/**
 * Admin voucher-redemption inbox. Rendered inside the WebAdminDashboard when
 * `view === "rewards"`. Lists every voucher request across all dealerships
 * with Fulfil / Reject actions.
 */
import { useCallback, useEffect, useState, useMemo } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch } from "@/src/api";
import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";

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

type RewardUser = {
  id: string;
  email: string;
  name: string;
  job_title?: string | null;
  active: boolean;
  dealership_id?: string | null;
  dealership_name?: string | null;
  balance: number;
};

type LeaderRow = {
  id: string;
  name: string;
  email: string;
  dealership_name?: string | null;
  job_title?: string | null;
  balance: number;
  lifetime_earned: number;
  rank: number;
};

type Leaderboard = {
  current: LeaderRow[];
  all_time: LeaderRow[];
  points_per_voucher: number;
};

export default function AdminRewardsScreen() {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const statusStyles = buildStatusStyles(colors);
  const statusTextStyles = buildStatusTextStyles(colors);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"pending" | "fulfilled" | "rejected" | "all">("pending");
  const [actionModal, setActionModal] = useState<{ type: "fulfill" | "reject"; r: Redemption } | null>(null);
  const [voucherCode, setVoucherCode] = useState("");
  const [adminNote, setAdminNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Bonus-points grant state
  const [grantOpen, setGrantOpen] = useState(false);
  const [grantUsers, setGrantUsers] = useState<RewardUser[]>([]);
  const [grantLoading, setGrantLoading] = useState(false);
  const [grantSearch, setGrantSearch] = useState("");
  const [grantSelected, setGrantSelected] = useState<RewardUser | null>(null);
  const [grantPoints, setGrantPoints] = useState("");
  const [grantReason, setGrantReason] = useState("");
  const [grantSubmitting, setGrantSubmitting] = useState(false);

  // Leaderboard
  const [leaderboard, setLeaderboard] = useState<Leaderboard | null>(null);
  const [leaderTab, setLeaderTab] = useState<"current" | "all_time">("current");
  const [leaderLoading, setLeaderLoading] = useState(true);

  const loadLeaderboard = useCallback(async () => {
    setLeaderLoading(true);
    try {
      const res = await apiFetch("/api/admin/rewards/leaderboard?limit=10");
      setLeaderboard(res);
    } catch (e: any) {
      // Non-blocking — leaderboard is secondary to the request inbox.
      console.warn("Leaderboard load failed:", e?.message);
    } finally {
      setLeaderLoading(false);
    }
  }, []);

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
  useEffect(() => { loadLeaderboard(); }, [loadLeaderboard]);

  const openGrant = async () => {
    setGrantOpen(true);
    setGrantSelected(null);
    setGrantPoints("");
    setGrantReason("");
    setGrantSearch("");
    setGrantLoading(true);
    try {
      const res = await apiFetch("/api/admin/rewards/users");
      setGrantUsers(res.users || []);
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Could not load dealer list");
    } finally {
      setGrantLoading(false);
    }
  };
  const submitGrant = async () => {
    if (!grantSelected) return;
    const pts = parseInt(grantPoints, 10);
    if (!pts || Number.isNaN(pts)) {
      Alert.alert("Invalid points", "Enter a non-zero whole number (use a negative to debit).");
      return;
    }
    if (!grantReason.trim()) {
      Alert.alert("Reason required", "Please add a short reason for the adjustment — it's recorded in the audit log.");
      return;
    }
    setGrantSubmitting(true);
    try {
      const res = await apiFetch("/api/admin/rewards/grant", {
        method: "POST",
        body: JSON.stringify({
          user_id: grantSelected.id,
          points: pts,
          reason: grantReason.trim(),
        }),
      });
      Alert.alert(
        "Adjustment applied",
        `${grantSelected.name} · new balance ${res.balance} pt${res.balance === 1 ? "" : "s"}.`,
      );
      setGrantOpen(false);
      loadLeaderboard();
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Grant failed");
    } finally {
      setGrantSubmitting(false);
    }
  };

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
      loadLeaderboard();
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Action failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.h1}>Voucher Requests</Text>
          <Text style={styles.sub}>Fulfil each request by pasting the Takealot voucher code. Rejecting refunds the user&apos;s points.</Text>
        </View>
        <TouchableOpacity testID="grant-bonus-btn" style={styles.grantBtn} onPress={openGrant}>
          <Ionicons name="add-circle-outline" size={16} color={colors.onPrimary} />
          <Text style={styles.grantBtnText}>Grant points</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.tabs}>
        {(["pending", "fulfilled", "rejected", "all"] as const).map((f) => (
          <TouchableOpacity key={f} onPress={() => setFilter(f)} style={[styles.tab, filter === f && styles.tabActive]}>
            <Text style={[styles.tabText, filter === f && styles.tabTextActive]}>{f.toUpperCase()}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Leaderboard */}
      <View style={styles.leaderCard} testID="rewards-leaderboard">
        <View style={styles.leaderHead}>
          <Ionicons name="trophy" size={16} color={colors.text} />
          <Text style={styles.leaderTitle}>Leaderboard</Text>
          <View style={styles.leaderTabs}>
            {(["current", "all_time"] as const).map((t) => (
              <TouchableOpacity
                key={t}
                onPress={() => setLeaderTab(t)}
                style={[styles.leaderTab, leaderTab === t && styles.leaderTabActive]}
                testID={`leader-tab-${t}`}
              >
                <Text style={[styles.leaderTabText, leaderTab === t && styles.leaderTabTextActive]}>
                  {t === "current" ? "CURRENT" : "ALL TIME"}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
        {leaderLoading ? (
          <ActivityIndicator style={{ marginVertical: spacing.md }} color={colors.primary} />
        ) : (() => {
          const rows = (leaderboard?.[leaderTab] || []) as LeaderRow[];
          if (rows.length === 0) {
            return <Text style={styles.leaderEmpty}>No dealers have earned points yet.</Text>;
          }
          return (
            <View>
              {rows.map((r) => {
                const value = leaderTab === "current" ? r.balance : r.lifetime_earned;
                const medal =
                  r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : "";
                return (
                  <View key={r.id} style={styles.leaderRow} testID={`leader-row-${r.id}`}>
                    <View style={styles.leaderRank}>
                      {medal ? (
                        <Text style={styles.leaderMedal}>{medal}</Text>
                      ) : (
                        <Text style={styles.leaderRankNum}>{r.rank}</Text>
                      )}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.leaderName} numberOfLines={1}>
                        {r.name}
                        {r.job_title ? (
                          <Text style={styles.leaderJob}> · {r.job_title}</Text>
                        ) : null}
                      </Text>
                      <Text style={styles.leaderMeta} numberOfLines={1}>
                        {r.dealership_name || r.email}
                      </Text>
                    </View>
                    <Text style={styles.leaderValue}>
                      {value}
                      <Text style={styles.leaderValueUnit}> pts</Text>
                    </Text>
                  </View>
                );
              })}
            </View>
          );
        })()}
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
                    <Ionicons name="checkmark-circle" size={16} color={colors.onPrimary} />
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
                {submitting ? <ActivityIndicator color={colors.onPrimary} /> : (
                  <Text style={actionModal.type === "fulfill" ? styles.modalBtnPrimaryText : styles.modalBtnDangerText}>
                    {actionModal.type === "fulfill" ? "Send" : "Reject"}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : null}

      {grantOpen ? (
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { maxHeight: "90%" }]}>
            <Text style={styles.modalTitle}>Grant bonus points</Text>
            <Text style={styles.modalSub}>
              Credit or debit a dealer&apos;s reward balance. Adjustments are recorded in the audit ledger under your admin account.
            </Text>

            {grantSelected ? (
              <View style={styles.selectedUserBox}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.userName}>{grantSelected.name}</Text>
                  <Text style={styles.userEmail}>{grantSelected.email}</Text>
                  {grantSelected.dealership_name ? (
                    <Text style={styles.userEmail}>{grantSelected.dealership_name}</Text>
                  ) : null}
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={styles.balancePill}>{grantSelected.balance} pts</Text>
                  <TouchableOpacity onPress={() => setGrantSelected(null)}>
                    <Text style={styles.changeUserLink}>Change</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <>
                <Text style={styles.modalLabel}>SELECT DEALER</Text>
                <TextInput
                  style={styles.modalInput}
                  value={grantSearch}
                  onChangeText={setGrantSearch}
                  placeholder="Search by name, email or dealership"
                  placeholderTextColor={colors.textDisabled}
                  autoCapitalize="none"
                />
                <ScrollView style={styles.userList} nestedScrollEnabled>
                  {grantLoading ? (
                    <ActivityIndicator style={{ marginVertical: spacing.md }} color={colors.primary} />
                  ) : (
                    grantUsers
                      .filter((u) => {
                        const q = grantSearch.trim().toLowerCase();
                        if (!q) return true;
                        return (
                          u.name.toLowerCase().includes(q) ||
                          (u.email || "").toLowerCase().includes(q) ||
                          (u.dealership_name || "").toLowerCase().includes(q)
                        );
                      })
                      .slice(0, 40)
                      .map((u) => (
                        <TouchableOpacity
                          key={u.id}
                          testID={`grant-pick-${u.id}`}
                          style={styles.userRow}
                          onPress={() => setGrantSelected(u)}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={styles.userName}>{u.name}</Text>
                            <Text style={styles.userEmail}>
                              {u.email}
                              {u.dealership_name ? ` · ${u.dealership_name}` : ""}
                            </Text>
                          </View>
                          <Text style={styles.balancePill}>{u.balance} pts</Text>
                        </TouchableOpacity>
                      ))
                  )}
                </ScrollView>
              </>
            )}

            {grantSelected ? (
              <>
                <Text style={styles.modalLabel}>POINTS (+ credit, – debit)</Text>
                <TextInput
                  testID="grant-points-input"
                  style={styles.modalInput}
                  value={grantPoints}
                  onChangeText={setGrantPoints}
                  keyboardType="numbers-and-punctuation"
                  placeholder="50"
                  placeholderTextColor={colors.textDisabled}
                  editable={!grantSubmitting}
                />
                <View style={styles.quickRow}>
                  {[10, 25, 50, -10].map((v) => (
                    <TouchableOpacity
                      key={v}
                      style={styles.quickChip}
                      onPress={() => setGrantPoints(String(v))}
                    >
                      <Text style={styles.quickChipText}>{v > 0 ? `+${v}` : v}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.modalLabel}>REASON (audit log)</Text>
                <TextInput
                  testID="grant-reason-input"
                  style={[styles.modalInput, { minHeight: 60 }]}
                  value={grantReason}
                  onChangeText={setGrantReason}
                  multiline
                  placeholder="Bonus for onboarding / correction / verification test…"
                  placeholderTextColor={colors.textDisabled}
                  editable={!grantSubmitting}
                />
              </>
            ) : null}

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnGhost]}
                onPress={() => setGrantOpen(false)}
                disabled={grantSubmitting}
              >
                <Text style={styles.modalBtnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="grant-submit"
                style={[
                  styles.modalBtn,
                  styles.modalBtnPrimary,
                  (!grantSelected || !grantPoints.trim() || !grantReason.trim()) && { opacity: 0.4 },
                ]}
                onPress={submitGrant}
                disabled={grantSubmitting || !grantSelected || !grantPoints.trim() || !grantReason.trim()}
              >
                {grantSubmitting ? (
                  <ActivityIndicator color={colors.onPrimary} />
                ) : (
                  <Text style={styles.modalBtnPrimaryText}>Apply</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : null}
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
  container: { flex: 1, backgroundColor: colors.bg, padding: spacing.md },
  header: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md, marginBottom: spacing.md },
  h1: { color: colors.text, fontSize: 22, fontWeight: "800", letterSpacing: 0.4 },
  sub: { color: colors.textSecondary, fontSize: 13, marginTop: 4 },
  grantBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radius.sm,
  },
  grantBtnText: { color: colors.onPrimary, fontWeight: "800", letterSpacing: 0.4, fontSize: 12 },
  tabs: { flexDirection: "row", gap: 4, marginBottom: spacing.md },
  tab: { paddingHorizontal: spacing.md, paddingVertical: 8, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  tabActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  tabText: { color: colors.textSecondary, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  tabTextActive: { color: colors.onPrimary },
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
  fulfillBtnText: { color: colors.onPrimary, fontWeight: "800", letterSpacing: 0.4 },

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
  modalBtnPrimaryText: { color: colors.onPrimary, fontWeight: "800", letterSpacing: 1 },
  modalBtnDanger: { backgroundColor: colors.danger },
  modalBtnDangerText: { color: "#fff", fontWeight: "800", letterSpacing: 1 },

  // Grant modal specifics
  userList: {
    maxHeight: 220,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.paper,
    marginTop: 4,
  },
  userRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  balancePill: {
    color: colors.text,
    fontFamily: fonts.mono,
    fontSize: 12,
    fontWeight: "800",
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  selectedUserBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.card,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
    marginTop: 4,
  },
  changeUserLink: { color: colors.textSecondary, fontSize: 11, marginTop: 4, textDecorationLine: "underline" },
  quickRow: { flexDirection: "row", gap: 6, marginTop: 6 },
  quickChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.card,
  },
  quickChipText: { color: colors.text, fontSize: 12, fontWeight: "700", fontFamily: fonts.mono },

  // Leaderboard
  leaderCard: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  leaderHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: spacing.sm,
  },
  leaderTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    flex: 1,
  },
  leaderTabs: {
    flexDirection: "row",
    gap: 4,
    backgroundColor: colors.paper,
    borderRadius: 999,
    padding: 3,
    borderWidth: 1,
    borderColor: colors.border,
  },
  leaderTab: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  leaderTabActive: { backgroundColor: colors.primary },
  leaderTabText: { color: colors.textSecondary, fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  leaderTabTextActive: { color: colors.onPrimary },
  leaderEmpty: { color: colors.textSecondary, fontSize: 12, textAlign: "center", paddingVertical: spacing.md },
  leaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  leaderRank: { width: 28, alignItems: "center", justifyContent: "center" },
  leaderMedal: { fontSize: 18 },
  leaderRankNum: { color: colors.textSecondary, fontSize: 12, fontWeight: "800", fontFamily: fonts.mono },
  leaderName: { color: colors.text, fontSize: 13, fontWeight: "700" },
  leaderJob: { color: colors.textSecondary, fontWeight: "500", fontStyle: "italic" },
  leaderMeta: { color: colors.textSecondary, fontSize: 11, marginTop: 1 },
  leaderValue: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "800",
    fontFamily: fonts.number,
  },
  leaderValueUnit: { color: colors.textSecondary, fontSize: 11, fontWeight: "700" },
});
