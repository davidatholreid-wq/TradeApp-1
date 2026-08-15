/**
 * AdminPartnerApiScreen — manage the Fourbuy VIN Data API (Kredo-style
 * reseller) partner clients and their billing.
 *
 * Renders inside the admin cockpit. Uses the same backend endpoints
 * documented in `/app/backend/routes/partner_api.py`:
 *   • GET  /api/admin/partner-clients
 *   • POST /api/admin/partner-clients
 *   • POST /api/admin/partner-clients/{id}/rotate-key
 *   • POST /api/admin/partner-clients/{id}/revoke
 *   • GET  /api/admin/partner-clients/{id}/usage?month=YYYY-MM
 *
 * Layout:
 *   1. Header with "Add new partner" CTA
 *   2. Grid of client cards — each shows name, key prefix, rate, active,
 *      current-month billing, and action buttons (view usage / rotate / revoke)
 *   3. Modal for creating a new client (returns the one-time raw key)
 *   4. Modal for viewing a client's monthly usage with a month picker
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, TextInput, Alert, Modal, Platform } from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch } from "@/src/api";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { spacing, radius } from "@/src/theme";

type PartnerClient = {
  id: string;
  name: string;
  api_key_prefix?: string;
  cost_zar_per_lookup: number;
  contact_email?: string | null;
  ip_allowlist?: string[];
  active?: boolean;
  notes?: string | null;
  created_at?: string;
  key_rotated_at?: string;
  revoked_at?: string;
};

type UsageResp = {
  client: { id: string; name: string; cost_zar_per_lookup: number };
  month: string;
  stats: {
    successful_lookups: number;
    failed_lookups: number;
    served_from_cache: number;
    outvin_credits_burned: number;
    amount_zar: number;
  };
  recent_calls: Array<{
    vin: string;
    status_code: number;
    served_from_cache: boolean;
    cost_billed_zar: number;
    outvin_hit: boolean;
    started_at: string;
    error?: string | null;
  }>;
};

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function AdminPartnerApiScreen() {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [clients, setClients] = useState<PartnerClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newKeyOverlay, setNewKeyOverlay] = useState<{ key: string; name: string } | null>(null);
  const [usageOpen, setUsageOpen] = useState<PartnerClient | null>(null);
  const [usage, setUsage] = useState<UsageResp | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [month, setMonth] = useState<string>(currentMonthKey());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch("/api/admin/partner-clients");
      setClients(Array.isArray(r?.clients) ? r.clients : []);
    } catch (e) {
      console.warn("partner clients load:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openUsage = useCallback(async (client: PartnerClient, monthKey: string) => {
    setUsageOpen(client);
    setUsageLoading(true);
    setUsage(null);
    try {
      const r = await apiFetch(`/api/admin/partner-clients/${client.id}/usage?month=${monthKey}`);
      setUsage(r);
    } catch (e) {
      Alert.alert("Usage load failed", String((e as any)?.message || e));
    } finally {
      setUsageLoading(false);
    }
  }, []);

  const rotate = useCallback(async (client: PartnerClient) => {
    const confirmed = Platform.OS === "web"
      ? (globalThis as any).confirm?.(`Rotate ${client.name}'s API key? The old key stops working immediately.`)
      : await new Promise<boolean>((resolve) => Alert.alert(
          "Rotate API key?",
          `${client.name}'s old key will stop working immediately. Continue?`,
          [
            { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
            { text: "Rotate", style: "destructive", onPress: () => resolve(true) },
          ]
        ));
    if (!confirmed) return;
    try {
      const r = await apiFetch(`/api/admin/partner-clients/${client.id}/rotate-key`, { method: "POST" });
      if (r?.api_key) setNewKeyOverlay({ key: r.api_key, name: client.name });
      await load();
    } catch (e) {
      Alert.alert("Rotate failed", String((e as any)?.message || e));
    }
  }, [load]);

  const revoke = useCallback(async (client: PartnerClient) => {
    const confirmed = Platform.OS === "web"
      ? (globalThis as any).confirm?.(`Revoke ${client.name}'s access? They will get HTTP 401 on every call.`)
      : await new Promise<boolean>((resolve) => Alert.alert(
          "Revoke access?",
          `${client.name} will lose API access. Continue?`,
          [
            { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
            { text: "Revoke", style: "destructive", onPress: () => resolve(true) },
          ]
        ));
    if (!confirmed) return;
    try {
      await apiFetch(`/api/admin/partner-clients/${client.id}/revoke`, { method: "POST" });
      await load();
    } catch (e) {
      Alert.alert("Revoke failed", String((e as any)?.message || e));
    }
  }, [load]);

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  return (
    <ScrollView contentContainerStyle={{ padding: spacing.md, paddingBottom: 120 }}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Partner API</Text>
          <Text style={styles.subtitle}>
            Manage API keys, IP allowlists and monthly billing for third-party partners
            querying the Fourbuy VIN Data API.
          </Text>
        </View>
        <TouchableOpacity style={styles.newBtn} onPress={() => setCreateOpen(true)} activeOpacity={0.85} testID="partner-api-new">
          <Ionicons name="add-circle" size={18} color={colors.onPrimary} />
          <Text style={styles.newBtnTxt}>Add Partner</Text>
        </TouchableOpacity>
      </View>

      {/* Docs shortcut */}
      <View style={[styles.docsRow, { borderColor: colors.border, backgroundColor: colors.card }]}>
        <Ionicons name="document-text-outline" size={18} color={colors.primary} />
        <Text style={{ color: colors.text, fontSize: 13, flex: 1 }}>
          Live partner docs page:
          {"  "}
          <Text style={{ color: colors.primary, fontWeight: "800" }}>/kredo-api/docs</Text>
        </Text>
        <TouchableOpacity
          onPress={() => {
            if (Platform.OS === "web") window.open("/kredo-api/docs", "_blank");
          }}
          style={styles.docsBtn}
        >
          <Text style={{ color: colors.primary, fontSize: 12, fontWeight: "800" }}>Open</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
      ) : clients.length === 0 ? (
        <View style={[styles.emptyBox, { borderColor: colors.border }]}>
          <Ionicons name="cube-outline" size={30} color={colors.textDisabled} />
          <Text style={{ color: colors.text, fontSize: 15, fontWeight: "800", marginTop: 6 }}>
            No partner clients yet
          </Text>
          <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 4, textAlign: "center" }}>
            Tap "Add Partner" to onboard your first API consumer (e.g. Kredo).
          </Text>
        </View>
      ) : (
        <View style={styles.grid}>
          {clients.map((c) => (
            <View key={c.id} style={[styles.clientCard, { borderColor: c.active === false ? colors.danger + "55" : colors.border }]}>
              <View style={styles.clientHead}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.clientName}>{c.name}</Text>
                  <Text style={styles.clientKey}>{c.api_key_prefix || "—"}</Text>
                </View>
                <View style={[styles.statusPill, {
                  backgroundColor: (c.active === false ? colors.danger : colors.success) + "22",
                  borderColor: (c.active === false ? colors.danger : colors.success) + "77",
                }]}>
                  <Text style={[styles.statusPillTxt, { color: c.active === false ? colors.danger : colors.success }]}>
                    {c.active === false ? "REVOKED" : "ACTIVE"}
                  </Text>
                </View>
              </View>
              <View style={styles.kv}>
                <Text style={styles.kvLabel}>Rate</Text>
                <Text style={styles.kvValue}>R{c.cost_zar_per_lookup} / lookup</Text>
              </View>
              {c.contact_email ? (
                <View style={styles.kv}>
                  <Text style={styles.kvLabel}>Contact</Text>
                  <Text style={styles.kvValue}>{c.contact_email}</Text>
                </View>
              ) : null}
              {c.ip_allowlist && c.ip_allowlist.length > 0 ? (
                <View style={styles.kv}>
                  <Text style={styles.kvLabel}>IP allowlist</Text>
                  <Text style={styles.kvValue}>{c.ip_allowlist.join(", ")}</Text>
                </View>
              ) : null}
              <View style={styles.actionsRow}>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: colors.primary }]}
                  onPress={() => openUsage(c, currentMonthKey())}
                  activeOpacity={0.85}
                >
                  <Ionicons name="cash-outline" size={14} color={colors.onPrimary} />
                  <Text style={[styles.actionBtnTxt, { color: colors.onPrimary }]}>Usage & Billing</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtnGhost, { borderColor: colors.warning }]}
                  onPress={() => rotate(c)}
                  activeOpacity={0.85}
                >
                  <Ionicons name="refresh" size={14} color={colors.warning} />
                  <Text style={[styles.actionBtnTxt, { color: colors.warning }]}>Rotate Key</Text>
                </TouchableOpacity>
                {c.active !== false ? (
                  <TouchableOpacity
                    style={[styles.actionBtnGhost, { borderColor: colors.danger }]}
                    onPress={() => revoke(c)}
                    activeOpacity={0.85}
                  >
                    <Ionicons name="close-circle" size={14} color={colors.danger} />
                    <Text style={[styles.actionBtnTxt, { color: colors.danger }]}>Revoke</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      )}

      {/* ----- Create partner modal ----- */}
      <CreatePartnerModal
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(key, name) => {
          setNewKeyOverlay({ key, name });
          setCreateOpen(false);
          load();
        }}
      />

      {/* ----- New-key overlay (one-time display) ----- */}
      {newKeyOverlay ? (
        <Modal transparent visible animationType="fade">
          <View style={styles.backdrop}>
            <View style={[styles.card, { backgroundColor: colors.paper }]}>
              <Text style={styles.cardTitle}>{newKeyOverlay.name} — new API key</Text>
              <Text style={{ color: colors.warning, fontSize: 12, marginBottom: 10 }}>
                ⚠ Save this key now. It will NOT be shown again.
              </Text>
              <View style={styles.keyBox}>
                <Text style={styles.keyText} selectable>{newKeyOverlay.key}</Text>
              </View>
              <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
                <TouchableOpacity
                  style={[styles.actionBtnGhost, { borderColor: colors.primary, flex: 1 }]}
                  onPress={() => {
                    if (Platform.OS === "web") (navigator as any).clipboard?.writeText?.(newKeyOverlay.key);
                    Alert.alert("Copied", "API key copied to clipboard.");
                  }}
                >
                  <Ionicons name="copy-outline" size={14} color={colors.primary} />
                  <Text style={[styles.actionBtnTxt, { color: colors.primary }]}>Copy</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: colors.primary, flex: 1 }]}
                  onPress={() => setNewKeyOverlay(null)}
                >
                  <Text style={[styles.actionBtnTxt, { color: colors.onPrimary }]}>Done</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      ) : null}

      {/* ----- Usage modal ----- */}
      {usageOpen ? (
        <Modal transparent visible animationType="slide" onRequestClose={() => setUsageOpen(null)}>
          <View style={styles.backdrop}>
            <View style={[styles.usageSheet, { backgroundColor: colors.paper }]}>
              <View style={styles.usageHead}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>{usageOpen.name} — Usage & Billing</Text>
                  <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                    Rate: R{usageOpen.cost_zar_per_lookup} per successful lookup
                  </Text>
                </View>
                <TouchableOpacity onPress={() => setUsageOpen(null)} style={styles.closeBtn}>
                  <Ionicons name="close" size={20} color={colors.text} />
                </TouchableOpacity>
              </View>

              {/* Month picker */}
              <View style={styles.monthRow}>
                <Text style={styles.kvLabel}>Month</Text>
                <TextInput
                  style={styles.monthInput}
                  value={month}
                  onChangeText={setMonth}
                  placeholder="YYYY-MM"
                  placeholderTextColor={colors.textDisabled}
                />
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: colors.primary }]}
                  onPress={() => openUsage(usageOpen, month)}
                >
                  <Text style={[styles.actionBtnTxt, { color: colors.onPrimary }]}>Reload</Text>
                </TouchableOpacity>
              </View>

              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md }}>
                {usageLoading ? (
                  <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.lg }} />
                ) : usage ? (
                  <>
                    <View style={styles.statGrid}>
                      <StatTile label="Successful" value={String(usage.stats.successful_lookups)} tint={colors.success} />
                      <StatTile label="Failed" value={String(usage.stats.failed_lookups)} tint={colors.danger} />
                      <StatTile label="From cache" value={String(usage.stats.served_from_cache)} tint={colors.primary} />
                      <StatTile label="Outvin credits" value={String(usage.stats.outvin_credits_burned)} tint={colors.warning} />
                      <StatTile
                        label="Amount billable"
                        value={`R${usage.stats.amount_zar.toLocaleString()}`}
                        tint={colors.success}
                        big
                      />
                    </View>

                    <Text style={[styles.h3, { marginTop: spacing.md }]}>Recent calls</Text>
                    {usage.recent_calls.length === 0 ? (
                      <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 6 }}>No calls this period.</Text>
                    ) : (
                      <View style={styles.tbl}>
                        <View style={[styles.tblRow, styles.tblHead]}>
                          <Text style={[styles.tblCell, styles.tblCellHead, { flex: 1.8 }]}>VIN</Text>
                          <Text style={[styles.tblCell, styles.tblCellHead, { flex: 0.8 }]}>Status</Text>
                          <Text style={[styles.tblCell, styles.tblCellHead, { flex: 0.9 }]}>Cache</Text>
                          <Text style={[styles.tblCell, styles.tblCellHead, { flex: 0.9 }]}>Billed</Text>
                          <Text style={[styles.tblCell, styles.tblCellHead, { flex: 1.6 }]}>When</Text>
                        </View>
                        {usage.recent_calls.map((r, i) => (
                          <View key={i} style={styles.tblRow}>
                            <Text style={[styles.tblCell, { flex: 1.8 }]} numberOfLines={1}>{r.vin}</Text>
                            <Text style={[styles.tblCell, { flex: 0.8, color: r.status_code === 200 ? colors.success : colors.danger }]}>{r.status_code}</Text>
                            <Text style={[styles.tblCell, { flex: 0.9 }]}>{r.served_from_cache ? "cached" : (r.outvin_hit ? "Outvin" : "—")}</Text>
                            <Text style={[styles.tblCell, { flex: 0.9 }]}>R{r.cost_billed_zar}</Text>
                            <Text style={[styles.tblCell, { flex: 1.6 }]} numberOfLines={1}>{String(r.started_at).slice(0, 19).replace("T", " ")}</Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </>
                ) : (
                  <Text style={{ color: colors.textSecondary, textAlign: "center", marginTop: spacing.md }}>No data.</Text>
                )}
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Create partner modal
// ---------------------------------------------------------------------------
function CreatePartnerModal({
  visible, onClose, onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: (key: string, name: string) => void;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [name, setName] = useState("");
  const [rate, setRate] = useState("10");
  const [contact, setContact] = useState("");
  const [ips, setIps] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = () => { setName(""); setRate("10"); setContact(""); setIps(""); setNotes(""); };

  const submit = async () => {
    if (!name.trim()) { Alert.alert("Name required"); return; }
    setBusy(true);
    try {
      const r = await apiFetch("/api/admin/partner-clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          cost_zar_per_lookup: parseInt(rate, 10) || 0,
          ip_allowlist: ips.split(",").map((s) => s.trim()).filter(Boolean),
          contact_email: contact.trim() || undefined,
          notes: notes.trim() || undefined,
        }),
      });
      if (r?.api_key) {
        onCreated(r.api_key, name.trim());
        reset();
      }
    } catch (e) {
      Alert.alert("Create failed", String((e as any)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: colors.paper }]}>
          <Text style={styles.cardTitle}>Add partner</Text>
          <Text style={styles.formLbl}>Name *</Text>
          <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Kredo" placeholderTextColor={colors.textDisabled} />
          <Text style={styles.formLbl}>Rate (R per lookup) *</Text>
          <TextInput style={styles.input} value={rate} onChangeText={setRate} keyboardType="number-pad" />
          <Text style={styles.formLbl}>Contact email</Text>
          <TextInput style={styles.input} value={contact} onChangeText={setContact} placeholder="integrations@partner.com" placeholderTextColor={colors.textDisabled} autoCapitalize="none" />
          <Text style={styles.formLbl}>IP allowlist (comma-separated, optional)</Text>
          <TextInput style={styles.input} value={ips} onChangeText={setIps} placeholder="203.0.113.10, 203.0.113.11" placeholderTextColor={colors.textDisabled} autoCapitalize="none" />
          <Text style={styles.formLbl}>Notes</Text>
          <TextInput style={[styles.input, { minHeight: 60 }]} value={notes} onChangeText={setNotes} multiline placeholder="Internal notes" placeholderTextColor={colors.textDisabled} />
          <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
            <TouchableOpacity style={[styles.actionBtnGhost, { borderColor: colors.border, flex: 1 }]} onPress={() => { reset(); onClose(); }}>
              <Text style={[styles.actionBtnTxt, { color: colors.text }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionBtn, { backgroundColor: colors.primary, flex: 1 }]} onPress={submit} disabled={busy}>
              {busy ? <ActivityIndicator color={colors.onPrimary} /> : (
                <Text style={[styles.actionBtnTxt, { color: colors.onPrimary }]}>Create & Generate Key</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function StatTile({ label, value, tint, big }: { label: string; value: string; tint: string; big?: boolean }) {
  const colors = useThemeColors();
  return (
    <View style={{
      backgroundColor: tint + "18",
      borderWidth: 1,
      borderColor: tint + "55",
      borderRadius: radius.md,
      padding: 12,
      minWidth: big ? 200 : 130,
      flexGrow: big ? 2 : 1,
    }}>
      <Text style={{ color: tint, fontSize: 11, fontWeight: "800", letterSpacing: 0.5, textTransform: "uppercase" as const }}>{label}</Text>
      <Text style={{ color: colors.text, fontSize: big ? 22 : 18, fontWeight: "800", marginTop: 4 }}>{value}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const makeStyles = (colors: Palette) => StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: spacing.md },
  title: { color: colors.text, fontSize: 22, fontWeight: "800", letterSpacing: -0.3 },
  subtitle: { color: colors.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 2 },
  newBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.primary, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 10 },
  newBtnTxt: { color: colors.onPrimary, fontSize: 14, fontWeight: "800" },
  docsRow: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderRadius: radius.md, padding: 12, marginBottom: spacing.md },
  docsBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: colors.primary + "77" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  clientCard: { flexBasis: 340, flexGrow: 1, borderWidth: 1, borderRadius: radius.md, padding: 14, backgroundColor: colors.card },
  clientHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  clientName: { color: colors.text, fontSize: 17, fontWeight: "800" },
  clientKey: { color: colors.textSecondary, fontSize: 12, fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) as any, marginTop: 2 },
  statusPill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, borderWidth: 1 },
  statusPillTxt: { fontSize: 10, fontWeight: "800", letterSpacing: 0.4 },
  kv: { flexDirection: "row", justifyContent: "space-between", marginTop: 8, gap: 8 },
  kvLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: "800", letterSpacing: 0.5, textTransform: "uppercase" as const },
  kvValue: { color: colors.text, fontSize: 13, fontWeight: "700", flexShrink: 1, textAlign: "right" as const },
  actionsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 12 },
  actionBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 8 },
  actionBtnGhost: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1 },
  actionBtnTxt: { fontSize: 12, fontWeight: "800", letterSpacing: 0.3 },
  emptyBox: { borderStyle: "dashed" as const, borderWidth: 1, borderRadius: radius.md, padding: spacing.lg, alignItems: "center", gap: 4, marginTop: spacing.md },

  // ----- overlays -----
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center", padding: spacing.md },
  card: { width: "100%" as const, maxWidth: 500 as any, borderRadius: radius.lg, padding: spacing.md },
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: "800", marginBottom: 6 },
  formLbl: { color: colors.textSecondary, fontSize: 11, fontWeight: "800", letterSpacing: 0.5, textTransform: "uppercase" as const, marginTop: 10, marginBottom: 4 },
  input: { backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 8, color: colors.text, fontSize: 13 },
  keyBox: { backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: 10 },
  keyText: { color: colors.primary, fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) as any, fontSize: 12 },
  usageSheet: { width: "100%" as const, maxWidth: 900 as any, maxHeight: "92%" as any, borderRadius: radius.lg, overflow: "hidden" as const },
  usageHead: { flexDirection: "row", alignItems: "center", padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 8 },
  closeBtn: { width: 30, height: 30, alignItems: "center", justifyContent: "center", borderRadius: 15, backgroundColor: colors.card },
  monthRow: { flexDirection: "row", alignItems: "center", gap: 8, padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  monthInput: { flex: 1, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 10, paddingVertical: 6, color: colors.text, fontSize: 13 },
  statGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  h3: { color: colors.text, fontSize: 14, fontWeight: "800", letterSpacing: 0.3, textTransform: "uppercase" as const },
  tbl: { marginTop: 8, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, overflow: "hidden" as const },
  tblHead: { backgroundColor: colors.card },
  tblRow: { flexDirection: "row", paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  tblCell: { color: colors.text, fontSize: 12, paddingHorizontal: 4 },
  tblCellHead: { color: colors.textSecondary, fontSize: 11, fontWeight: "800", letterSpacing: 0.5, textTransform: "uppercase" as const },
});
