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
  Modal,
  ScrollView,
  TextInput,
  Switch,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { colors, spacing, radius, fonts } from "@/src/theme";
import { apiFetch } from "@/src/api";

type Dealer = {
  id: string;
  email: string;
  active?: boolean;
  archived_at?: string | null;
  agreement_accepted_at?: string | null;
  dealer_info: { first_name: string; last_name: string; phone: string };
  company_info: { company_name: string; company_address: string };
  submission_count: number;
  billable_count?: number;
  billable_total_zar?: number;
  created_at: string;
};

export default function Dealers() {
  const tabBarHeight = useBottomTabBarHeight();
  const [dealers, setDealers] = useState<Dealer[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<Dealer | null>(null);
  const [savingActiveId, setSavingActiveId] = useState<string | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(
    async (withArchived: boolean) => {
      try {
        const data = await apiFetch(
          `/api/admin/dealers${withArchived ? "?include_archived=true" : ""}`
        );
        setDealers(data.dealers || []);
      } catch (e) {
        console.log(e);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    []
  );

  useFocusEffect(
    useCallback(() => {
      load(showArchived);
    }, [load, showArchived])
  );

  const showError = (msg: string) => {
    if (Platform.OS === "web" && typeof (globalThis as any).alert === "function") {
      (globalThis as any).alert(msg);
      return;
    }
    Alert.alert("Error", msg);
  };

  // Alert.alert doesn't render on react-native-web, so on web we fall back to
  // window.confirm which produces a native browser dialog. Same signature as
  // Alert.alert with a destructive/OK-style callback.
  const confirmAction = (
    title: string,
    message: string,
    okLabel: string,
    onOk: () => void | Promise<void>
  ) => {
    if (Platform.OS === "web" && typeof (globalThis as any).confirm === "function") {
      const ok = (globalThis as any).confirm(`${title}\n\n${message}`);
      if (ok) onOk();
      return;
    }
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: okLabel, style: "destructive", onPress: () => onOk() },
    ]);
  };

  const removeDealer = (dealer: Dealer) => {
    const n = dealer.submission_count || 0;
    if (n > 0) {
      confirmAction(
        "Archive dealer",
        `${dealer.dealer_info.first_name} ${dealer.dealer_info.last_name} has ${n} submission${n === 1 ? "" : "s"}. They'll be archived so all data and billing history are preserved. They will no longer appear in the active dealers list and won't be able to log in. Proceed?`,
        "Archive",
        async () => {
          setBusyId(dealer.id);
          try {
            await apiFetch(`/api/admin/dealers/${dealer.id}/archive`, { method: "POST" });
            await load(showArchived);
          } catch (e: any) {
            showError(e.message || "Failed to archive");
          } finally {
            setBusyId(null);
          }
        }
      );
      return;
    }
    confirmAction(
      "Remove dealer",
      `Permanently remove ${dealer.dealer_info.first_name} ${dealer.dealer_info.last_name}? This dealer has no submissions so nothing is lost.`,
      "Remove",
      async () => {
        setBusyId(dealer.id);
        try {
          await apiFetch(`/api/admin/dealers/${dealer.id}`, { method: "DELETE" });
          setDealers((prev) => prev.filter((d) => d.id !== dealer.id));
        } catch (e: any) {
          showError(e.message || "Failed to remove");
        } finally {
          setBusyId(null);
        }
      }
    );
  };

  const restoreDealer = (dealer: Dealer) => {
    confirmAction(
      "Restore dealer",
      `Restore ${dealer.dealer_info.first_name} ${dealer.dealer_info.last_name} to the active dealer list?`,
      "Restore",
      async () => {
        setBusyId(dealer.id);
        try {
          await apiFetch(`/api/admin/dealers/${dealer.id}/restore`, { method: "POST" });
          await load(showArchived);
        } catch (e: any) {
          showError(e.message || "Failed to restore");
        } finally {
          setBusyId(null);
        }
      }
    );
  };

  const toggleActive = async (dealer: Dealer, next: boolean) => {
    setSavingActiveId(dealer.id);
    try {
      await apiFetch(`/api/admin/dealers/${dealer.id}/active`, {
        method: "POST",
        body: JSON.stringify({ active: next }),
      });
      setDealers((prev) => prev.map((d) => (d.id === dealer.id ? { ...d, active: next } : d)));
    } catch (e: any) {
      showError(e.message || "Could not update status");
    } finally {
      setSavingActiveId(null);
    }
  };

  const promptResetPassword = (dealer: Dealer) => {
    // Cross-platform prompt: on web `Alert.prompt` doesn't exist so use window.prompt
    // We'll just call the API with a generated password if no prompt is available.
    const doReset = async (pw: string) => {
      if (!pw || pw.length < 6) {
        showError("Password must be at least 6 characters");
        return;
      }
      setResettingId(dealer.id);
      try {
        await apiFetch(`/api/admin/dealers/${dealer.id}/password`, {
          method: "POST",
          body: JSON.stringify({ new_password: pw }),
        });
        const msg = `New password for ${dealer.email}:\n\n${pw}\n\nShare this securely with the dealer.`;
        if (Platform.OS === "web" && typeof (globalThis as any).alert === "function") {
          (globalThis as any).alert(msg);
        } else {
          Alert.alert("Password reset", msg);
        }
      } catch (e: any) {
        showError(e.message || "Could not reset password");
      } finally {
        setResettingId(null);
      }
    };

    if (Platform.OS === "web" && typeof (globalThis as any).prompt === "function") {
      const pw = (globalThis as any).prompt(
        `Enter a new password for ${dealer.email} (min 6 chars):`,
        ""
      );
      if (pw !== null && pw !== undefined) doReset(pw);
      return;
    }
    if ((Alert as any).prompt) {
      (Alert as any).prompt(
        "Reset password",
        `Enter a new password for ${dealer.email} (min 6 chars).`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Reset", onPress: (v: string) => doReset(v) },
        ],
        "plain-text",
        ""
      );
    } else {
      const auto = "Fourbuy" + Math.floor(1000 + Math.random() * 9000);
      Alert.alert(
        "Confirm password reset",
        `Generate a new password for ${dealer.email}?\n\nSuggested: ${auto}`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Reset", onPress: () => doReset(auto) },
        ]
      );
    }
  };

  const renderItem = ({ item }: { item: Dealer }) => {
    const isArchived = !!item.archived_at;
    const isActive = !isArchived && item.active !== false;
    const statusColor = isArchived
      ? colors.textDisabled
      : isActive
      ? colors.primary
      : colors.danger;
    return (
      <View style={[styles.card, isArchived && styles.cardArchived]} testID={`dealer-card-${item.id}`}>
        <View style={styles.cardTop}>
          <View style={[styles.avatar, { borderColor: statusColor + "55" }]}>
            <Ionicons name="person" size={22} color={statusColor} />
          </View>
          <View style={{ flex: 1 }}>
            <View style={styles.nameRow}>
              <Text style={[styles.name, isArchived && { color: colors.textSecondary }]}>
                {item.dealer_info.first_name} {item.dealer_info.last_name}
              </Text>
              {isArchived ? (
                <View style={styles.archivedPill}>
                  <Text style={styles.archivedPillText}>ARCHIVED</Text>
                </View>
              ) : !isActive ? (
                <View style={styles.suspendPill}>
                  <Text style={styles.suspendPillText}>SUSPENDED</Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.company}>{item.company_info.company_name}</Text>
          </View>
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
          {(item.billable_count || 0) > 0 ? (
            <View style={styles.metaItem}>
              <Ionicons name="cash-outline" size={13} color={colors.neon} />
              <Text style={[styles.metaText, { color: colors.neon }]}>
                {item.billable_count} billable · R{item.billable_total_zar?.toFixed(2)}
              </Text>
            </View>
          ) : null}
          {isArchived && item.archived_at ? (
            <View style={styles.metaItem}>
              <Ionicons name="archive-outline" size={13} color={colors.textSecondary} />
              <Text style={styles.metaText}>
                Archived {new Date(item.archived_at).toLocaleDateString()}
              </Text>
            </View>
          ) : null}
        </View>

        <View style={styles.actionsRow}>
          {isArchived ? (
            <TouchableOpacity
              testID={`dealer-restore-${item.id}`}
              style={[styles.actionBtn, styles.restoreBtn]}
              onPress={() => restoreDealer(item)}
              disabled={busyId === item.id}
            >
              {busyId === item.id ? (
                <ActivityIndicator size="small" color={colors.neon} />
              ) : (
                <>
                  <Ionicons name="refresh" size={16} color={colors.neon} />
                  <Text style={[styles.actionBtnText, { color: colors.neon }]}>Restore</Text>
                </>
              )}
            </TouchableOpacity>
          ) : (
            <>
              <View style={styles.activeCol}>
                <Text style={styles.activeLabel}>{isActive ? "ACTIVE" : "SUSPENDED"}</Text>
                {savingActiveId === item.id ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <Switch
                    testID={`dealer-active-toggle-${item.id}`}
                    value={isActive}
                    onValueChange={(v) => toggleActive(item, v)}
                    trackColor={{ false: colors.border, true: colors.neon }}
                    thumbColor={isActive ? "#000" : colors.textSecondary}
                  />
                )}
              </View>
              <View style={{ flex: 1 }} />
              <TouchableOpacity
                testID={`dealer-edit-${item.id}`}
                style={styles.actionBtn}
                onPress={() => setEditing(item)}
              >
                <Ionicons name="create-outline" size={16} color={colors.text} />
                <Text style={styles.actionBtnText}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID={`dealer-reset-pw-${item.id}`}
                style={styles.actionBtn}
                onPress={() => promptResetPassword(item)}
                disabled={resettingId === item.id}
              >
                {resettingId === item.id ? (
                  <ActivityIndicator size="small" color={colors.text} />
                ) : (
                  <>
                    <Ionicons name="key-outline" size={16} color={colors.text} />
                    <Text style={styles.actionBtnText}>Reset PW</Text>
                  </>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                testID={`remove-dealer-${item.id}`}
                style={[styles.actionBtn, styles.dangerBtn]}
                onPress={() => removeDealer(item)}
                disabled={busyId === item.id}
              >
                {busyId === item.id ? (
                  <ActivityIndicator size="small" color={colors.danger} />
                ) : (
                  <Ionicons
                    name={item.submission_count > 0 ? "archive-outline" : "trash-outline"}
                    size={16}
                    color={colors.danger}
                  />
                )}
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    );
  };

  const activeCount = dealers.filter((d) => !d.archived_at && d.active !== false).length;
  const suspendedCount = dealers.filter((d) => !d.archived_at && d.active === false).length;
  const archivedCount = dealers.filter((d) => !!d.archived_at).length;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Manage Dealers</Text>
        <Text style={styles.headerSub}>
          {dealers.length - archivedCount} registered · {activeCount} active
          {suspendedCount > 0 ? ` · ${suspendedCount} suspended` : ""}
          {showArchived && archivedCount > 0 ? ` · ${archivedCount} archived` : ""}
        </Text>
        <View style={styles.headerActions}>
          <TouchableOpacity
            testID="dealers-toggle-archived"
            onPress={() => {
              setLoading(true);
              setShowArchived((v) => !v);
            }}
            style={[styles.archTgl, showArchived && styles.archTglActive]}
          >
            <Ionicons
              name={showArchived ? "eye" : "eye-off"}
              size={14}
              color={showArchived ? "#000" : colors.textSecondary}
            />
            <Text style={[styles.archTglText, showArchived && styles.archTglTextActive]}>
              {showArchived ? "Showing archived" : "Show archived"}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : dealers.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="people-outline" size={64} color={colors.textDisabled} />
          <Text style={styles.emptyTitle}>
            {showArchived ? "No archived dealers" : "No dealers yet"}
          </Text>
          <Text style={styles.emptyText}>
            {showArchived
              ? "Nothing archived. All your dealers are active."
              : "Dealers will appear here once they register"}
          </Text>
        </View>
      ) : (
        <FlatList
          data={dealers}
          keyExtractor={(i) => i.id}
          renderItem={renderItem}
          contentContainerStyle={[styles.list, { paddingBottom: tabBarHeight + spacing.md }]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load(showArchived);
              }}
              tintColor={colors.primary}
            />
          }
        />
      )}

      <EditDealerModal
        dealer={editing}
        onClose={() => setEditing(null)}
        onSaved={(fresh) => {
          setDealers((prev) => prev.map((d) => (d.id === fresh.id ? { ...d, ...fresh } : d)));
          setEditing(null);
        }}
      />
    </SafeAreaView>
  );
}

// -----------------------------------------------------------------------------
// Edit dealer modal
// -----------------------------------------------------------------------------
function EditDealerModal({
  dealer,
  onClose,
  onSaved,
}: {
  dealer: Dealer | null;
  onClose: () => void;
  onSaved: (fresh: Dealer) => void;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [companyAddress, setCompanyAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset fields whenever a new dealer is opened.
  useFocusEffect(
    useCallback(() => {
      if (!dealer) return;
      setFirstName(dealer.dealer_info.first_name || "");
      setLastName(dealer.dealer_info.last_name || "");
      setPhone(dealer.dealer_info.phone || "");
      setEmail(dealer.email || "");
      setCompanyName(dealer.company_info.company_name || "");
      setCompanyAddress(dealer.company_info.company_address || "");
      setError(null);
    }, [dealer])
  );

  const save = async () => {
    if (!dealer) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/dealers/${dealer.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          phone: phone.trim(),
          email: email.trim().toLowerCase(),
          company_name: companyName.trim(),
          company_address: companyAddress.trim(),
        }),
      });
      onSaved(res.dealer);
    } catch (e: any) {
      setError(e.message || "Could not save changes");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={!!dealer} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Edit Dealer</Text>
            <TouchableOpacity onPress={onClose} testID="edit-dealer-close">
              <Ionicons name="close" size={22} color={colors.text} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}>
            <Field label="First name" value={firstName} onChangeText={setFirstName} testID="edit-first-name" />
            <Field label="Last name" value={lastName} onChangeText={setLastName} testID="edit-last-name" />
            <Field label="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" testID="edit-phone" />
            <Field label="Email (login username)" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" testID="edit-email" />
            <Field label="Company name" value={companyName} onChangeText={setCompanyName} testID="edit-company-name" />
            <Field label="Company address" value={companyAddress} onChangeText={setCompanyAddress} testID="edit-company-address" multiline />
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </ScrollView>

          <View style={styles.modalFooter}>
            <TouchableOpacity onPress={onClose} style={styles.modalCancelBtn}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="edit-dealer-save"
              style={[styles.modalSaveBtn, saving && { opacity: 0.6 }]}
              onPress={save}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator color="#000" />
              ) : (
                <>
                  <Ionicons name="checkmark" size={16} color="#000" />
                  <Text style={styles.modalSaveText}>Save</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function Field({
  label,
  ...rest
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  keyboardType?: any;
  autoCapitalize?: any;
  multiline?: boolean;
  testID?: string;
}) {
  return (
    <View>
      <Text style={styles.fieldLabel}>{label.toUpperCase()}</Text>
      <TextInput
        style={[styles.input, rest.multiline && { minHeight: 80, textAlignVertical: "top" }]}
        placeholderTextColor={colors.textDisabled}
        {...rest}
      />
    </View>
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
  headerTitle: { color: colors.text, fontSize: 22, fontWeight: "800", fontFamily: fonts.heading, letterSpacing: 2, textTransform: "uppercase" },
  headerSub: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  headerActions: { flexDirection: "row", marginTop: spacing.sm },
  archTgl: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  archTglActive: { backgroundColor: colors.neon, borderColor: colors.neon },
  archTglText: { color: colors.textSecondary, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  archTglTextActive: { color: "#000" },
  list: { padding: spacing.md, paddingBottom: spacing.xl },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  cardArchived: { opacity: 0.72, borderStyle: "dashed" },
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
  nameRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { color: colors.text, fontSize: 16, fontWeight: "700" },
  suspendPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.danger + "22",
    borderWidth: 1,
    borderColor: colors.danger + "55",
  },
  suspendPillText: { color: colors.danger, fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  archivedPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.textDisabled + "22",
    borderWidth: 1,
    borderColor: colors.textDisabled + "55",
  },
  archivedPillText: { color: colors.textSecondary, fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  restoreBtn: { borderColor: colors.neon + "55", backgroundColor: colors.neon + "12" },
  company: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  meta: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 4,
  },
  metaItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  metaText: { color: colors.textSecondary, fontSize: 12 },
  actionsRow: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  activeCol: { flexDirection: "row", alignItems: "center", gap: 6 },
  activeLabel: { color: colors.textSecondary, fontSize: 10, fontWeight: "800", letterSpacing: 1.5 },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.paper,
  },
  actionBtnText: { color: colors.text, fontSize: 12, fontWeight: "700" },
  dangerBtn: { borderColor: colors.danger + "55", backgroundColor: colors.danger + "10" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm, padding: spacing.lg },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: "700", marginTop: spacing.sm },
  emptyText: { color: colors.textSecondary, fontSize: 14, textAlign: "center" },

  // Edit modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.85)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.neon + "55",
    maxHeight: "90%",
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalTitle: { color: colors.text, fontSize: 16, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" },
  fieldLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: "800", letterSpacing: 1, marginBottom: 6 },
  input: {
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 14,
  },
  error: { color: colors.danger, fontSize: 13 },
  modalFooter: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.paper,
  },
  modalCancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    backgroundColor: colors.card,
  },
  modalCancelText: { color: colors.textSecondary, fontWeight: "700" },
  modalSaveBtn: {
    flex: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
  },
  modalSaveText: { color: "#000", fontWeight: "800", letterSpacing: 1 },
});
