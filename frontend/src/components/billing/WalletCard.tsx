/**
 * Dealer-side billing summary card + suspend banner (Aug 2026).
 *
 * `<WalletCard />` — full card with balance, usage-to-date, past
 *                    invoices (with PDF download) and recorded
 *                    payments. Used at the top of /(app)/billing.
 *
 * `<WalletSuspendBanner />` — thin red bar that self-fetches and
 *                             only renders when the caller's dealership
 *                             wallet has hit zero. Mounted globally
 *                             from the (app) layout so every screen
 *                             surfaces the depleted state.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, Linking, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { useThemeColors } from "@/src/theme/ThemeContext";
import { spacing, radius, fonts } from "@/src/theme";
import { apiFetch } from "@/src/api";
import { useAuth } from "@/src/context/AuthContext";

type Wallet = {
  balance_zar: number;
  credits_zar: number;
  usage_zar: number;
  suspended: boolean;
};
type Invoice = {
  id: string;
  reference: string;
  period_label: string;
  total_cents: number;
  status: string;
  generated_at: string;
  pdf_url?: string | null;
};
type Payment = {
  id: string;
  amount_cents: number;
  bank_reference: string;
  payment_date: string;
  invoice_id?: string | null;
  is_deposit?: boolean;
};
type MySummary = {
  wallet: Wallet;
  invoices: Invoice[];
  payments: Payment[];
};

const rand = (v: number | null | undefined) => {
  const n = Number(v || 0);
  const abs = Math.abs(n).toFixed(2);
  const [w, f] = abs.split(".");
  return `${n < 0 ? "-" : ""}R ${w.replace(/\B(?=(\d{3})+(?!\d))/g, " ")}.${f}`;
};
const cents = (c: number | null | undefined) => rand(Number(c || 0) / 100);

async function fetchMySummary(): Promise<MySummary | null> {
  try {
    return (await apiFetch("/api/billing/my-summary")) as MySummary;
  } catch {
    return null;
  }
}

function openPdf(url?: string | null) {
  if (!url) return;
  if (Platform.OS === "web" && typeof window !== "undefined") {
    window.open(url, "_blank");
  } else {
    Linking.openURL(url).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
export function WalletCard() {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [summary, setSummary] = useState<MySummary | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setSummary(await fetchMySummary());
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  if (loading) return <ActivityIndicator style={{ padding: spacing.md }} color={colors.primary} />;
  if (!summary) return null;

  const w = summary.wallet;
  return (
    <View style={styles.card} testID="wallet-card">
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>DEPOSIT BALANCE</Text>
          <Text style={[styles.balance, w.suspended && { color: "#B91C1C" }]}>{rand(w.balance_zar)}</Text>
          <Text style={styles.meta}>
            Deposits paid to date: {rand(w.credits_zar)}   ·   Usage to date: {rand(w.usage_zar)}
          </Text>
        </View>
        <TouchableOpacity style={styles.refreshBtn} onPress={load}>
          <Ionicons name="refresh" size={14} color={colors.text} />
        </TouchableOpacity>
      </View>
      {w.suspended ? (
        <View style={styles.suspendedInline}>
          <Ionicons name="warning" size={16} color="#B91C1C" />
          <Text style={styles.suspendedText}>
            Your deposit is depleted — new submissions, VIN reports and Get Cover placements are blocked until Fourbuy accounts loads a top-up.
          </Text>
        </View>
      ) : null}

      <Text style={styles.sectionTitle}>MY INVOICES</Text>
      {summary.invoices.length === 0 ? (
        <Text style={styles.muted}>No invoices raised yet.</Text>
      ) : summary.invoices.map((inv) => (
        <View key={inv.id} style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowLine1}>{inv.reference} · {inv.period_label}</Text>
            <Text style={styles.rowLine2}>Status: {inv.status}</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={styles.rowAmount}>{cents(inv.total_cents)}</Text>
            {inv.pdf_url ? (
              <TouchableOpacity onPress={() => openPdf(inv.pdf_url)}>
                <Text style={styles.rowLink}>PDF</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      ))}

      <Text style={styles.sectionTitle}>PAYMENTS RECEIVED</Text>
      {summary.payments.length === 0 ? (
        <Text style={styles.muted}>No payments recorded yet.</Text>
      ) : summary.payments.map((p) => (
        <View key={p.id} style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowLine1}>
              {p.bank_reference || "(no ref)"} · {p.invoice_id ? "Invoice payment" : "Deposit top-up"}
            </Text>
            <Text style={styles.rowLine2}>{p.payment_date}</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={styles.rowAmount}>{cents(p.amount_cents)}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
export function WalletSuspendBanner() {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { user } = useAuth();
  const [suspended, setSuspended] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!user || user.role !== "dealer") { setSuspended(false); return; }
    (async () => {
      const s = await fetchMySummary();
      if (!cancelled) setSuspended(!!s?.wallet?.suspended);
    })();
    return () => { cancelled = true; };
  }, [user]);

  if (!suspended) return null;
  return (
    <View style={styles.suspendBanner} testID="wallet-suspend-banner">
      <Ionicons name="warning" size={14} color="#fff" />
      <Text style={styles.suspendBannerText}>
        Deposit depleted — please contact Fourbuy accounts to top up before submitting.
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
const makeStyles = (colors: any) =>
  StyleSheet.create({
    card: { padding: spacing.md, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderLight, marginBottom: spacing.md },
    headerRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    title: { color: colors.textSecondary, fontSize: 11, fontWeight: "800", letterSpacing: 0.6, fontFamily: fonts.body },
    balance: { color: colors.text, fontSize: 28, fontWeight: "800", marginTop: 4 },
    meta: { color: colors.textSecondary, fontSize: 12, marginTop: 4 },
    refreshBtn: { padding: 8, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderLight },
    suspendedInline: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: spacing.sm, padding: 10, borderRadius: radius.md, backgroundColor: "#FEE2E2", borderWidth: 1, borderColor: "#B91C1C" },
    suspendedText: { flex: 1, color: "#7F1D1D", fontSize: 12, lineHeight: 16 },
    sectionTitle: { color: colors.textSecondary, fontSize: 10, fontWeight: "800", letterSpacing: 0.8, marginTop: spacing.md, marginBottom: 6 },
    muted: { color: colors.textSecondary, fontSize: 12 },
    row: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
    rowLine1: { color: colors.text, fontSize: 13, fontWeight: "700" },
    rowLine2: { color: colors.textSecondary, fontSize: 11, marginTop: 1 },
    rowAmount: { color: colors.text, fontSize: 13, fontWeight: "800" },
    rowLink: { color: colors.primary, fontSize: 11, fontWeight: "700", marginTop: 2 },
    suspendBanner: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, paddingHorizontal: 12, backgroundColor: "#B91C1C" },
    suspendBannerText: { flex: 1, color: "#fff", fontSize: 12, fontWeight: "700" },
  });

export default WalletCard;
