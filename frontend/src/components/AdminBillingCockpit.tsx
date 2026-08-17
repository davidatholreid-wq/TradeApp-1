/**
 * AdminBillingCockpit — Admin Billing management screen (Aug 2026).
 *
 * Two-column layout:
 *  • Left: list of dealerships with wallet balance + suspended pill.
 *  • Right: detail panel for the selected dealership — wallet card,
 *           action buttons and a tabbed ledger (invoices / deposits /
 *           payments / refunds).
 *
 * All wallet mutations go through the backend endpoints introduced in
 * `/app/backend/routes/billing.py` (see the Phase 1 summary for the
 * contract). The screen intentionally keeps every mutation behind a
 * confirmation modal so the admin can never accidentally raise a
 * DEP-NNNNNN or send an invoice.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, TextInput,
  Modal, Pressable, Platform, Linking, Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors } from "@/src/theme/ThemeContext";
import { apiFetch, openAuthedPdf } from "@/src/api";

type Contact = { name?: string | null; phone?: string | null; email?: string | null };

type DealerRow = {
  id: string;
  name: string;
  accounts_contact?: Contact;
  wallet_balance_zar: number;
  wallet_usage_zar: number;
  wallet_credits_zar: number;
  suspended: boolean;
};

type Wallet = {
  balance_zar: number;
  credits_zar: number;
  usage_zar: number;
  refunds_zar: number;
  suspended: boolean;
};

type Invoice = {
  id: string;
  reference: string;
  period_label: string;
  subtotal_cents: number;
  vat_cents: number;
  total_cents: number;
  total_paid_cents: number;
  status: "outstanding" | "partial" | "paid";
  generated_at: string;
  emailed_to?: string | null;
  pdf_url?: string | null;
};

type DepositRequest = {
  id: string;
  reference: string;
  amount_cents: number;
  amount_zar: number;
  notes?: string;
  status: string;
  requested_at: string;
  emailed_to?: string | null;
  pdf_url?: string | null;
};

type Payment = {
  id: string;
  amount_cents: number;
  amount_zar: number;
  payment_date: string;
  bank_reference: string;
  notes?: string;
  invoice_id?: string | null;
  deposit_request_id?: string | null;
  recorded_at: string;
};

type Refund = {
  id: string;
  reference: string;
  amount_cents: number;
  amount_zar: number;
  refund_date: string;
  bank_reference: string;
  notes?: string;
  recorded_at: string;
};

type Summary = {
  dealership: {
    id: string; name: string; address?: string; vat_no?: string;
    company_reg_no?: string; accounts_contact?: Contact;
  };
  wallet: Wallet;
  invoices: Invoice[];
  deposit_requests: DepositRequest[];
  payments: Payment[];
  refunds: Refund[];
};

const rand = (v: number | null | undefined) => {
  const n = Number(v || 0);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n).toFixed(2);
  const [whole, frac] = abs.split(".");
  return `${sign}R ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ")}.${frac}`;
};
const cents = (c: number | null | undefined) => rand(Number(c || 0) / 100);

// ---------------------------------------------------------------------------

export default function AdminBillingCockpit() {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [rows, setRows] = useState<DealerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [tab, setTab] = useState<"invoices" | "deposits" | "payments" | "refunds">("invoices");

  // Modals
  const [depositReqOpen, setDepositReqOpen] = useState(false);
  const [loadPaymentOpen, setLoadPaymentOpen] = useState(false);
  const [invoiceGenOpen, setInvoiceGenOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [companySettingsOpen, setCompanySettingsOpen] = useState(false);
  const [editDealerOpen, setEditDealerOpen] = useState(false);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/api/admin/billing/overview");
      const list = res?.dealerships || [];
      setRows(list);
      if (!selectedId && list.length) setSelectedId(list[0].id);
    } catch (e: any) {
      Alert.alert("Couldn't load billing overview", e?.message || "");
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  const loadSummary = useCallback(async (id: string) => {
    setSummaryLoading(true);
    try {
      const res = await apiFetch(`/api/admin/dealerships/${id}/billing-summary`);
      setSummary(res as Summary);
    } catch (e: any) {
      Alert.alert("Couldn't load summary", e?.message || "");
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  useEffect(() => { loadOverview(); }, [loadOverview]);
  useEffect(() => { if (selectedId) loadSummary(selectedId); }, [selectedId, loadSummary]);

  const refreshAll = useCallback(async () => {
    await loadOverview();
    if (selectedId) await loadSummary(selectedId);
  }, [loadOverview, loadSummary, selectedId]);

  return (
    <View style={styles.root}>
      {/* Header */}
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>BILLING &amp; DEPOSITS</Text>
          <Text style={styles.subtitle}>
            Per-dealer prepaid wallets · deposit requests · monthly invoices · payment allocation
          </Text>
        </View>
        <TouchableOpacity
          testID="billing-company-settings-btn"
          style={styles.secondaryBtn}
          onPress={() => setCompanySettingsOpen(true)}
        >
          <Ionicons name="business-outline" size={14} color={colors.text} />
          <Text style={styles.secondaryBtnText}>Company details</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryBtn} onPress={refreshAll}>
          <Ionicons name="refresh" size={14} color={colors.text} />
          <Text style={styles.secondaryBtnText}>Refresh</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.body}>
        {/* LEFT — dealership list */}
        <View style={styles.leftCol}>
          <Text style={styles.colHeader}>DEALERSHIPS</Text>
          {loading ? (
            <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />
          ) : rows.length === 0 ? (
            <Text style={styles.muted}>No dealerships yet.</Text>
          ) : (
            <ScrollView>
              {rows.map((r) => (
                <TouchableOpacity
                  key={r.id}
                  testID={`billing-row-${r.id}`}
                  style={[
                    styles.dealerRow,
                    selectedId === r.id && styles.dealerRowActive,
                  ]}
                  onPress={() => setSelectedId(r.id)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.dealerRowName}>{r.name}</Text>
                    <Text style={styles.dealerRowMeta}>
                      Balance: {rand(r.wallet_balance_zar)}  · Used: {rand(r.wallet_usage_zar)}
                    </Text>
                  </View>
                  {r.suspended ? (
                    <View style={styles.suspendedPill}>
                      <Text style={styles.suspendedPillText}>SUSPENDED</Text>
                    </View>
                  ) : (
                    <View style={styles.activePill}>
                      <Text style={styles.activePillText}>ACTIVE</Text>
                    </View>
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </View>

        {/* RIGHT — detail panel */}
        <View style={styles.rightCol}>
          {summaryLoading ? (
            <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
          ) : !summary ? (
            <View style={styles.emptyRight}>
              <Ionicons name="cash-outline" size={40} color={colors.borderLight} />
              <Text style={styles.muted}>Select a dealership to manage its billing.</Text>
            </View>
          ) : (
            <ScrollView>
              {/* Wallet card */}
              <View style={styles.walletCard}>
                <View style={{ flex: 1 }}>
                  <View style={styles.walletTitleRow}>
                    <Text style={styles.walletDealer}>{summary.dealership.name}</Text>
                    <TouchableOpacity
                      testID="edit-dealership-btn"
                      style={styles.editDealerBtn}
                      onPress={() => setEditDealerOpen(true)}
                    >
                      <Ionicons name="create-outline" size={13} color={colors.primary} />
                      <Text style={styles.editDealerBtnText}>Edit dealership</Text>
                    </TouchableOpacity>
                  </View>
                  <Text style={styles.walletMeta}>
                    {(summary.dealership.accounts_contact?.email) || "No accounts contact email on file"}
                  </Text>
                  <View style={styles.walletKpiRow}>
                    <WalletKpi label="Balance" value={rand(summary.wallet.balance_zar)} tone={summary.wallet.suspended ? "danger" : "primary"} styles={styles} />
                    <WalletKpi label="Deposits" value={rand(summary.wallet.credits_zar)} styles={styles} />
                    <WalletKpi label="Usage" value={rand(summary.wallet.usage_zar)} styles={styles} />
                    <WalletKpi label="Refunds" value={rand(summary.wallet.refunds_zar)} styles={styles} />
                  </View>
                </View>
              </View>

              {/* Action buttons */}
              <View style={styles.actionRow}>
                <ActionButton icon="mail-outline" label="Request Deposit" onPress={() => setDepositReqOpen(true)} colors={colors} styles={styles} testID="btn-request-deposit" />
                <ActionButton icon="cash-outline" label="Load Payment" onPress={() => setLoadPaymentOpen(true)} colors={colors} styles={styles} testID="btn-load-payment" primary />
                <ActionButton icon="document-text-outline" label="Generate Invoice" onPress={() => setInvoiceGenOpen(true)} colors={colors} styles={styles} testID="btn-generate-invoice" />
                <ActionButton icon="return-up-back-outline" label="Refund" onPress={() => setRefundOpen(true)} colors={colors} styles={styles} testID="btn-refund" />
                <ActionButton
                  icon="print-outline"
                  label="Statement PDF"
                  onPress={() => openAuthedPdf(
                    `/api/admin/dealerships/${summary.dealership.id}/statement.pdf`,
                    `statement_${summary.dealership.name.replace(/\s+/g, "_")}.pdf`,
                  ).catch((e) => Alert.alert("Couldn't open PDF", e?.message || ""))}
                  colors={colors}
                  styles={styles}
                  testID="btn-statement"
                />
              </View>

              {/* Tabs */}
              <View style={styles.tabsRow}>
                {(["invoices", "deposits", "payments", "refunds"] as const).map((t) => (
                  <TouchableOpacity
                    key={t}
                    style={[styles.tabBtn, tab === t && styles.tabBtnActive]}
                    onPress={() => setTab(t)}
                  >
                    <Text style={[styles.tabBtnText, tab === t && styles.tabBtnTextActive]}>
                      {t.toUpperCase()} ({t === "invoices" ? summary.invoices.length : t === "deposits" ? summary.deposit_requests.length : t === "payments" ? summary.payments.length : summary.refunds.length})
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {tab === "invoices" && (
                <LedgerList
                  rows={summary.invoices.map((i) => ({
                    key: i.id,
                    line1: `${i.reference} · ${i.period_label}`,
                    line2: `Emailed: ${i.emailed_to || "not sent"}  · Status: ${i.status}`,
                    amount: cents(i.total_cents),
                    right: i.pdf_url ? { label: "PDF", url: i.pdf_url } : undefined,
                  }))}
                  styles={styles}
                  emptyText="No invoices generated yet."
                />
              )}
              {tab === "deposits" && (
                <LedgerList
                  rows={summary.deposit_requests.map((d) => ({
                    key: d.id,
                    line1: `${d.reference}  · ${d.status.toUpperCase()}`,
                    line2: `${(d.requested_at || "").split("T")[0]}${d.emailed_to ? ` · emailed ${d.emailed_to}` : ""}${d.notes ? ` · ${d.notes}` : ""}`,
                    amount: cents(d.amount_cents),
                    right: d.pdf_url ? { label: "PDF", url: d.pdf_url } : undefined,
                  }))}
                  styles={styles}
                  emptyText="No deposit requests raised yet."
                />
              )}
              {tab === "payments" && (
                <LedgerList
                  rows={summary.payments.map((p) => ({
                    key: p.id,
                    line1: `${p.bank_reference || "(no ref)"} · ${p.invoice_id ? "against invoice" : p.deposit_request_id ? "against deposit" : "unallocated"}`,
                    line2: `${p.payment_date}${p.notes ? ` · ${p.notes}` : ""}`,
                    amount: cents(p.amount_cents),
                  }))}
                  styles={styles}
                  emptyText="No payments recorded yet."
                />
              )}
              {tab === "refunds" && (
                <LedgerList
                  rows={summary.refunds.map((r) => ({
                    key: r.id,
                    line1: `${r.reference} · ${r.bank_reference || "(no ref)"}`,
                    line2: `${r.refund_date}${r.notes ? ` · ${r.notes}` : ""}`,
                    amount: cents(r.amount_cents),
                  }))}
                  styles={styles}
                  emptyText="No refunds recorded yet."
                />
              )}
            </ScrollView>
          )}
        </View>
      </View>

      {/* Modals */}
      {summary && (
        <>
          <DepositRequestModal
            open={depositReqOpen}
            onClose={() => setDepositReqOpen(false)}
            dealership={summary.dealership}
            onSaved={refreshAll}
            colors={colors}
            styles={styles}
          />
          <LoadPaymentModal
            open={loadPaymentOpen}
            onClose={() => setLoadPaymentOpen(false)}
            dealership={summary.dealership}
            depositRequests={summary.deposit_requests}
            invoices={summary.invoices}
            onSaved={refreshAll}
            colors={colors}
            styles={styles}
          />
          <GenerateInvoiceModal
            open={invoiceGenOpen}
            onClose={() => setInvoiceGenOpen(false)}
            dealership={summary.dealership}
            onSaved={refreshAll}
            colors={colors}
            styles={styles}
          />
          <RefundModal
            open={refundOpen}
            onClose={() => setRefundOpen(false)}
            dealership={summary.dealership}
            onSaved={refreshAll}
            colors={colors}
            styles={styles}
          />
          <EditDealershipModal
            open={editDealerOpen}
            onClose={() => setEditDealerOpen(false)}
            dealership={summary.dealership}
            onSaved={refreshAll}
            colors={colors}
            styles={styles}
          />
        </>
      )}
      <CompanySettingsModal
        open={companySettingsOpen}
        onClose={() => setCompanySettingsOpen(false)}
        colors={colors}
        styles={styles}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------
function WalletKpi({ label, value, tone, styles }: { label: string; value: string; tone?: "primary" | "danger"; styles: any }) {
  return (
    <View style={[styles.kpi, tone === "danger" && styles.kpiDanger]}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={[styles.kpiValue, tone === "danger" && styles.kpiValueDanger]}>{value}</Text>
    </View>
  );
}

function ActionButton({ icon, label, onPress, colors, styles, testID, primary }: any) {
  const iconColor = primary ? (colors.onPrimary || "#fff") : colors.text;
  return (
    <TouchableOpacity
      testID={testID}
      style={[styles.actionBtn, primary && styles.actionBtnPrimary]}
      onPress={onPress}
    >
      <Ionicons name={icon} size={14} color={iconColor} />
      <Text style={[styles.actionBtnText, primary && styles.actionBtnTextPrimary]}>{label}</Text>
    </TouchableOpacity>
  );
}

function LedgerList({ rows, styles, emptyText }: { rows: any[]; styles: any; emptyText: string }) {
  if (rows.length === 0) return <Text style={[styles.muted, { marginTop: spacing.md }]}>{emptyText}</Text>;
  return (
    <View style={{ marginTop: spacing.sm }}>
      {rows.map((r) => (
        <View key={r.key} style={styles.ledgerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.ledgerLine1}>{r.line1}</Text>
            <Text style={styles.ledgerLine2}>{r.line2}</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={styles.ledgerAmount}>{r.amount}</Text>
            {r.right ? (
              <TouchableOpacity onPress={() => openPdf(r.right.url)}>
                <Text style={styles.ledgerLink}>{r.right.label}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

function openPdf(url: string) {
  if (!url) return;
  if (Platform.OS === "web" && typeof window !== "undefined") {
    window.open(url, "_blank");
  } else {
    Linking.openURL(url).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Modals — one per action. Each posts to the corresponding backend endpoint.
// ---------------------------------------------------------------------------
function useForm<T extends Record<string, any>>(initial: T) {
  const [values, setValues] = useState<T>(initial);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof T, v: any) => setValues((s) => ({ ...s, [k]: v }));
  return { values, setValues, set, busy, setBusy };
}

function DepositRequestModal({ open, onClose, dealership, onSaved, colors, styles }: any) {
  const { values, setValues, set, busy, setBusy } = useForm({ amount_zar: "", notes: "" });
  useEffect(() => { if (open) setValues({ amount_zar: "", notes: "" }); }, [open, setValues]);
  const save = async () => {
    const amt = parseFloat(values.amount_zar);
    if (!amt || amt <= 0) { Alert.alert("Enter a valid amount"); return; }
    setBusy(true);
    try {
      await apiFetch(`/api/admin/dealerships/${dealership.id}/deposit-request`, {
        method: "POST", body: JSON.stringify({ amount_zar: amt, notes: values.notes }),
      });
      onSaved(); onClose();
      Alert.alert("Deposit request sent", "The document has been generated and (if a contact email is on file) emailed to the accounts contact.");
    } catch (e: any) { Alert.alert("Failed", e?.message || ""); }
    finally { setBusy(false); }
  };
  return (
    <MinimalModal open={open} onClose={onClose} title="Request Deposit" styles={styles}>
      <FormField label="Amount (R)" value={values.amount_zar} onChangeText={(v) => set("amount_zar", v)} keyboardType="decimal-pad" styles={styles} placeholder="e.g. 5000" />
      <FormField label="Notes (optional)" value={values.notes} onChangeText={(v) => set("notes", v)} multiline styles={styles} placeholder="Purpose / period covered / etc." />
      <PrimaryButton testID="deposit-request-submit" label={busy ? "Sending…" : "Create & Email"} onPress={save} disabled={busy} styles={styles} />
    </MinimalModal>
  );
}

function LoadPaymentModal({ open, onClose, dealership, depositRequests, invoices, onSaved, colors, styles }: any) {
  const { values, set, setValues, busy, setBusy } = useForm({
    amount_zar: "", payment_date: new Date().toISOString().slice(0, 10),
    bank_reference: "", notes: "", allocation: "deposit", deposit_request_id: "", invoice_id: "",
  });
  useEffect(() => { if (open) setValues({ amount_zar: "", payment_date: new Date().toISOString().slice(0, 10), bank_reference: "", notes: "", allocation: "deposit", deposit_request_id: "", invoice_id: "" }); }, [open, setValues]);
  const save = async () => {
    const amt = parseFloat(values.amount_zar);
    if (!amt || amt <= 0) { Alert.alert("Enter a valid amount"); return; }
    if (!values.bank_reference) { Alert.alert("Bank reference is required"); return; }
    setBusy(true);
    try {
      const body: any = {
        amount_zar: amt, payment_date: values.payment_date,
        bank_reference: values.bank_reference, notes: values.notes,
      };
      if (values.allocation === "deposit" && values.deposit_request_id) body.deposit_request_id = values.deposit_request_id;
      if (values.allocation === "invoice" && values.invoice_id) body.invoice_id = values.invoice_id;
      await apiFetch(`/api/admin/dealerships/${dealership.id}/deposits`, {
        method: "POST", body: JSON.stringify(body),
      });
      onSaved(); onClose();
    } catch (e: any) { Alert.alert("Failed", e?.message || ""); }
    finally { setBusy(false); }
  };
  return (
    <MinimalModal open={open} onClose={onClose} title="Load Payment (received EFT)" styles={styles}>
      <FormField label="Amount (R)" value={values.amount_zar} onChangeText={(v) => set("amount_zar", v)} keyboardType="decimal-pad" styles={styles} />
      <FormField label="Payment date (YYYY-MM-DD)" value={values.payment_date} onChangeText={(v) => set("payment_date", v)} styles={styles} />
      <FormField label="Bank reference" value={values.bank_reference} onChangeText={(v) => set("bank_reference", v)} styles={styles} placeholder="e.g. FNB EFT-9812" />
      <FormField label="Notes (optional)" value={values.notes} onChangeText={(v) => set("notes", v)} multiline styles={styles} />
      <Text style={styles.formLabel}>Allocate to</Text>
      <View style={styles.pillRow}>
        {["deposit", "invoice", "unallocated"].map((k) => (
          <TouchableOpacity key={k} style={[styles.pill, values.allocation === k && styles.pillActive]} onPress={() => set("allocation", k)}>
            <Text style={[styles.pillText, values.allocation === k && styles.pillTextActive]}>{k.toUpperCase()}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {values.allocation === "deposit" && (
        <ChoiceList
          label="Match to deposit request (optional)"
          items={depositRequests.map((d: any) => ({ id: d.id, label: `${d.reference} — ${cents(d.amount_cents)} — ${d.status}` }))}
          value={values.deposit_request_id}
          onChange={(v) => set("deposit_request_id", v)}
          styles={styles}
        />
      )}
      {values.allocation === "invoice" && (
        <ChoiceList
          label="Match to invoice (required to flip status → paid)"
          items={invoices.map((i: any) => ({ id: i.id, label: `${i.reference} — ${i.period_label} — ${cents(i.total_cents)} — ${i.status}` }))}
          value={values.invoice_id}
          onChange={(v) => set("invoice_id", v)}
          styles={styles}
        />
      )}
      <PrimaryButton testID="load-payment-submit" label={busy ? "Saving…" : "Record Payment"} onPress={save} disabled={busy} styles={styles} />
    </MinimalModal>
  );
}

function GenerateInvoiceModal({ open, onClose, dealership, onSaved, colors, styles }: any) {
  const now = new Date();
  const { values, set, setValues, busy, setBusy } = useForm({
    year: String(now.getFullYear()),
    month: String(now.getMonth() + 1),  // 1..12
  });
  useEffect(() => {
    if (open) {
      const d = new Date();
      setValues({ year: String(d.getFullYear()), month: String(d.getMonth() + 1) });
    }
  }, [open, setValues]);
  const save = async () => {
    const y = parseInt(values.year, 10), m = parseInt(values.month, 10);
    if (!y || m < 1 || m > 12) { Alert.alert("Enter a valid year + month (1-12)"); return; }
    setBusy(true);
    try {
      const res = await apiFetch(`/api/admin/dealerships/${dealership.id}/invoices/generate`, {
        method: "POST", body: JSON.stringify({ year: y, month: m }),
      });
      onSaved(); onClose();
      Alert.alert(
        "Invoice generated",
        `Invoice ${res?.invoice?.reference} created${res?.invoice?.emailed_to ? ` and emailed to ${res.invoice.emailed_to}` : " (no accounts contact email on file)"}.`,
      );
    } catch (e: any) {
      const msg = String(e?.message || "");
      if (msg.includes("No billable activity")) {
        Alert.alert("Nothing to invoice", msg);
      } else {
        Alert.alert("Failed", msg);
      }
    }
    finally { setBusy(false); }
  };
  return (
    <MinimalModal open={open} onClose={onClose} title="Generate Monthly Invoice" styles={styles}>
      <Text style={styles.formHint}>
        The invoice will include every submission with a priced_at inside the calendar month, plus any VIN reports created in that month. Existing invoices are not modified.
      </Text>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <FormField label="Year" value={values.year} onChangeText={(v) => set("year", v)} keyboardType="number-pad" styles={styles} style={{ flex: 1 }} />
        <FormField label="Month (1-12)" value={values.month} onChangeText={(v) => set("month", v)} keyboardType="number-pad" styles={styles} style={{ flex: 1 }} />
      </View>
      <PrimaryButton testID="generate-invoice-submit" label={busy ? "Generating…" : "Generate & Email"} onPress={save} disabled={busy} styles={styles} />
    </MinimalModal>
  );
}

function RefundModal({ open, onClose, dealership, onSaved, colors, styles }: any) {
  const { values, set, setValues, busy, setBusy } = useForm({
    amount_zar: "", refund_date: new Date().toISOString().slice(0, 10), bank_reference: "", notes: "",
  });
  useEffect(() => { if (open) setValues({ amount_zar: "", refund_date: new Date().toISOString().slice(0, 10), bank_reference: "", notes: "" }); }, [open, setValues]);
  const save = async () => {
    const amt = parseFloat(values.amount_zar);
    if (!amt || amt <= 0) { Alert.alert("Enter a valid amount"); return; }
    setBusy(true);
    try {
      await apiFetch(`/api/admin/dealerships/${dealership.id}/deposit-refund`, {
        method: "POST", body: JSON.stringify({ amount_zar: amt, refund_date: values.refund_date, bank_reference: values.bank_reference, notes: values.notes }),
      });
      onSaved(); onClose();
    } catch (e: any) { Alert.alert("Failed", e?.message || ""); }
    finally { setBusy(false); }
  };
  return (
    <MinimalModal open={open} onClose={onClose} title="Refund Deposit" styles={styles}>
      <FormField label="Amount (R)" value={values.amount_zar} onChangeText={(v) => set("amount_zar", v)} keyboardType="decimal-pad" styles={styles} />
      <FormField label="Refund date (YYYY-MM-DD)" value={values.refund_date} onChangeText={(v) => set("refund_date", v)} styles={styles} />
      <FormField label="Bank reference" value={values.bank_reference} onChangeText={(v) => set("bank_reference", v)} styles={styles} />
      <FormField label="Notes (optional)" value={values.notes} onChangeText={(v) => set("notes", v)} multiline styles={styles} />
      <PrimaryButton testID="refund-submit" label={busy ? "Saving…" : "Record Refund"} onPress={save} disabled={busy} styles={styles} />
    </MinimalModal>
  );
}

function EditDealershipModal({ open, onClose, dealership, onSaved, colors, styles }: any) {
  const [values, setValues] = useState<any>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    // Prefill from the summary payload. The admin can edit every
    // dealership-level field including the accounts_contact block.
    const c = dealership?.accounts_contact || {};
    setValues({
      name: dealership?.name || "",
      address: dealership?.address || "",
      company_reg_no: dealership?.company_reg_no || "",
      vat_no: dealership?.vat_no || "",
      accounts_contact_name: c.name || "",
      accounts_contact_phone: c.phone || "",
      accounts_contact_email: c.email || "",
    });
  }, [open, dealership]);
  const set = (k: string, v: any) => setValues((s: any) => ({ ...s, [k]: v }));
  const save = async () => {
    if (!values.name?.trim()) { Alert.alert("Name is required"); return; }
    setBusy(true);
    try {
      await apiFetch(`/api/admin/dealerships/${dealership.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: values.name.trim(),
          address: values.address?.trim(),
          company_reg_no: values.company_reg_no?.trim() || null,
          vat_no: values.vat_no?.trim() || null,
          accounts_contact_name: values.accounts_contact_name?.trim() || null,
          accounts_contact_phone: values.accounts_contact_phone?.trim() || null,
          accounts_contact_email: values.accounts_contact_email?.trim() || null,
        }),
      });
      onSaved();
      onClose();
      Alert.alert("Saved", "Dealership details updated.");
    } catch (e: any) {
      Alert.alert("Failed", e?.message || "");
    } finally {
      setBusy(false);
    }
  };
  return (
    <MinimalModal open={open} onClose={onClose} title="Edit Dealership Details" styles={styles} wide>
      <Text style={styles.formHint}>
        These details appear on every invoice, deposit request and statement PDF for this dealership. The accounts contact receives all billing email correspondence.
      </Text>
      <FormField label="Dealership name" value={values.name} onChangeText={(v: string) => set("name", v)} styles={styles} />
      <FormField label="Address" value={values.address} onChangeText={(v: string) => set("address", v)} multiline styles={styles} />
      <View style={{ flexDirection: "row", gap: 10 }}>
        <FormField label="Company reg no." value={values.company_reg_no} onChangeText={(v: string) => set("company_reg_no", v)} styles={styles} style={{ flex: 1 }} />
        <FormField label="VAT no." value={values.vat_no} onChangeText={(v: string) => set("vat_no", v)} styles={styles} style={{ flex: 1 }} />
      </View>
      <Text style={[styles.formLabel, { marginTop: spacing.md }]}>ACCOUNTS CONTACT</Text>
      <FormField label="Full name" value={values.accounts_contact_name} onChangeText={(v: string) => set("accounts_contact_name", v)} styles={styles} placeholder="e.g. Jane Smith" />
      <View style={{ flexDirection: "row", gap: 10 }}>
        <FormField label="Phone" value={values.accounts_contact_phone} onChangeText={(v: string) => set("accounts_contact_phone", v)} keyboardType="phone-pad" styles={styles} style={{ flex: 1 }} placeholder="+27 82 …" />
        <FormField label="Email" value={values.accounts_contact_email} onChangeText={(v: string) => set("accounts_contact_email", v)} keyboardType="email-address" styles={styles} style={{ flex: 1 }} placeholder="accounts@…" />
      </View>
      <PrimaryButton testID="edit-dealership-submit" label={busy ? "Saving…" : "Save"} onPress={save} disabled={busy} styles={styles} />
    </MinimalModal>
  );
}


function CompanySettingsModal({ open, onClose, colors, styles }: any) {
  const [values, setValues] = useState<any>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const res = await apiFetch("/api/admin/company-settings");
        setValues(res?.settings || {});
      } catch (e: any) { Alert.alert("Couldn't load", e?.message || ""); }
    })();
  }, [open]);
  const set = (k: string, v: any) => setValues((s: any) => ({ ...s, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      await apiFetch("/api/admin/company-settings", { method: "PUT", body: JSON.stringify(values) });
      onClose();
      Alert.alert("Saved", "Company details updated. New invoices and deposit requests will use these details.");
    } catch (e: any) { Alert.alert("Failed", e?.message || ""); }
    finally { setBusy(false); }
  };  return (
    <MinimalModal open={open} onClose={onClose} title="Company Details (invoice issuer)" styles={styles} wide>
      <Text style={styles.formHint}>
        These details appear on every deposit request, invoice and statement PDF. Bank details are printed in the footer for EFT payments.
      </Text>
      <FormField label="Trading name" value={values.trading_name} onChangeText={(v) => set("trading_name", v)} styles={styles} />
      <FormField label="Legal name" value={values.legal_name} onChangeText={(v) => set("legal_name", v)} styles={styles} />
      <View style={{ flexDirection: "row", gap: 10 }}>
        <FormField label="Registration No." value={values.registration_number} onChangeText={(v) => set("registration_number", v)} styles={styles} style={{ flex: 1 }} />
        <FormField label="VAT No." value={values.vat_number} onChangeText={(v) => set("vat_number", v)} styles={styles} style={{ flex: 1 }} />
      </View>
      <FormField label="Address line 1" value={values.address_line1} onChangeText={(v) => set("address_line1", v)} styles={styles} />
      <FormField label="Address line 2" value={values.address_line2} onChangeText={(v) => set("address_line2", v)} styles={styles} />
      <View style={{ flexDirection: "row", gap: 10 }}>
        <FormField label="City" value={values.city} onChangeText={(v) => set("city", v)} styles={styles} style={{ flex: 1 }} />
        <FormField label="Postal code" value={values.postal_code} onChangeText={(v) => set("postal_code", v)} styles={styles} style={{ flex: 1 }} />
        <FormField label="Country" value={values.country} onChangeText={(v) => set("country", v)} styles={styles} style={{ flex: 1 }} />
      </View>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <FormField label="Email" value={values.email} onChangeText={(v) => set("email", v)} styles={styles} style={{ flex: 1 }} />
        <FormField label="Phone" value={values.phone} onChangeText={(v) => set("phone", v)} styles={styles} style={{ flex: 1 }} />
        <FormField label="Website" value={values.website} onChangeText={(v) => set("website", v)} styles={styles} style={{ flex: 1 }} />
      </View>
      <Text style={[styles.formLabel, { marginTop: spacing.md }]}>BANKING DETAILS</Text>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <FormField label="Bank" value={values.bank_name} onChangeText={(v) => set("bank_name", v)} styles={styles} style={{ flex: 1 }} />
        <FormField label="Account name" value={values.bank_account_name} onChangeText={(v) => set("bank_account_name", v)} styles={styles} style={{ flex: 1 }} />
      </View>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <FormField label="Account No." value={values.bank_account_number} onChangeText={(v) => set("bank_account_number", v)} styles={styles} style={{ flex: 1 }} />
        <FormField label="Branch code" value={values.bank_branch_code} onChangeText={(v) => set("bank_branch_code", v)} styles={styles} style={{ flex: 1 }} />
        <FormField label="SWIFT" value={values.bank_swift} onChangeText={(v) => set("bank_swift", v)} styles={styles} style={{ flex: 1 }} />
      </View>
      <FormField label="VAT rate (%)" value={String(values.vat_rate_percent ?? 15)} onChangeText={(v) => set("vat_rate_percent", parseFloat(v) || 0)} keyboardType="decimal-pad" styles={styles} />
      <PrimaryButton testID="company-settings-submit" label={busy ? "Saving…" : "Save"} onPress={save} disabled={busy} styles={styles} />
    </MinimalModal>
  );
}

// ---------------------------------------------------------------------------
// Modal & form primitives
// ---------------------------------------------------------------------------
function MinimalModal({ open, onClose, title, children, styles, wide }: any) {
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBg} onPress={onClose}>
        <Pressable style={[styles.modalCard, wide && { width: "min(720px, 92vw)" as any }]} onPress={(e: any) => e.stopPropagation && e.stopPropagation()}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{title}</Text>
            <TouchableOpacity onPress={onClose}><Ionicons name="close" size={18} /></TouchableOpacity>
          </View>
          <ScrollView>{children}</ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function FormField({ label, value, onChangeText, keyboardType, multiline, placeholder, styles, style }: any) {
  return (
    <View style={[{ marginBottom: 10 }, style]}>
      <Text style={styles.formLabel}>{label}</Text>
      <TextInput
        style={[styles.formInput, multiline && { minHeight: 60, textAlignVertical: "top" }]}
        value={value == null ? "" : String(value)}
        onChangeText={onChangeText}
        keyboardType={keyboardType || "default"}
        placeholder={placeholder}
        placeholderTextColor="#94A3B8"
        multiline={!!multiline}
      />
    </View>
  );
}

function ChoiceList({ label, items, value, onChange, styles }: any) {
  return (
    <View style={{ marginTop: 6 }}>
      <Text style={styles.formLabel}>{label}</Text>
      <ScrollView style={{ maxHeight: 160 }}>
        {items.length === 0 ? (
          <Text style={styles.muted}>Nothing to match.</Text>
        ) : items.map((it: any) => (
          <TouchableOpacity
            key={it.id}
            style={[styles.choiceRow, value === it.id && styles.choiceRowActive]}
            onPress={() => onChange(value === it.id ? "" : it.id)}
          >
            <Ionicons name={value === it.id ? "radio-button-on" : "radio-button-off"} size={14} />
            <Text style={styles.choiceRowText}>{it.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

function PrimaryButton({ label, onPress, disabled, styles, testID }: any) {
  return (
    <TouchableOpacity
      testID={testID}
      style={[styles.primaryBtn, disabled && { opacity: 0.6 }]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.primaryBtnText}>{label}</Text>
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
const makeStyles = (colors: any) =>
  StyleSheet.create({
    root: { flex: 1, padding: spacing.md, backgroundColor: colors.background },
    headerRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.md },
    title: { color: colors.text, fontSize: 16, fontWeight: "800", letterSpacing: 0.5, fontFamily: fonts.body },
    subtitle: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
    secondaryBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderLight, backgroundColor: colors.card },
    secondaryBtnText: { color: colors.text, fontSize: 12, fontWeight: "700" },
    body: { flex: 1, flexDirection: "row", gap: spacing.md },
    leftCol: { width: 320, backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.md, borderWidth: 1, borderColor: colors.borderLight },
    rightCol: { flex: 1, backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.md, borderWidth: 1, borderColor: colors.borderLight },
    colHeader: { color: colors.textSecondary, fontSize: 10, fontWeight: "800", letterSpacing: 0.8, marginBottom: spacing.sm },
    dealerRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: 10, borderRadius: radius.md, marginBottom: 6 },
    dealerRowActive: { backgroundColor: colors.primary + "18" },
    dealerRowName: { color: colors.text, fontSize: 13, fontWeight: "700" },
    dealerRowMeta: { color: colors.textSecondary, fontSize: 11, marginTop: 1 },
    suspendedPill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: "#FEE2E2", borderWidth: 1, borderColor: "#B91C1C" },
    suspendedPillText: { color: "#B91C1C", fontSize: 9, fontWeight: "800", letterSpacing: 0.4 },
    activePill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: "#DCFCE7", borderWidth: 1, borderColor: "#166534" },
    activePillText: { color: "#166534", fontSize: 9, fontWeight: "800", letterSpacing: 0.4 },
    muted: { color: colors.textSecondary, fontSize: 12 },
    emptyRight: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
    walletCard: { flexDirection: "row", padding: spacing.md, backgroundColor: colors.background, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderLight, marginBottom: spacing.md },
    walletTitleRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: spacing.sm,
    },
    editDealerBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingVertical: 4,
      paddingHorizontal: 8,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.primary + "55",
      backgroundColor: colors.primary + "10",
    },
    editDealerBtnText: {
      color: colors.primary,
      fontSize: 11,
      fontWeight: "800",
      letterSpacing: 0.3,
    },
    walletDealer: { color: colors.text, fontSize: 15, fontWeight: "800" },
    walletMeta: { color: colors.textSecondary, fontSize: 12, marginTop: 2, marginBottom: spacing.md },
    walletKpiRow: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
    kpi: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderLight, backgroundColor: colors.card, minWidth: 130 },
    kpiDanger: { borderColor: "#B91C1C", backgroundColor: "#FEE2E2" },
    kpiLabel: { color: colors.textSecondary, fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
    kpiValue: { color: colors.text, fontSize: 16, fontWeight: "800", marginTop: 2 },
    kpiValueDanger: { color: "#B91C1C" },
    actionRow: { flexDirection: "row", gap: 8, flexWrap: "wrap", marginBottom: spacing.md },
    actionBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 9, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderLight, backgroundColor: colors.background },
    actionBtnPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
    actionBtnText: { color: colors.text, fontSize: 12, fontWeight: "700" },
    // Use the theme-provided `onPrimary` so the label stays readable
    // regardless of whether the brand colour is dark red / neon lime /
    // etc. Was hard-coded to #fff which failed WCAG AA on light
    // primaries.
    actionBtnTextPrimary: { color: colors.onPrimary || "#fff" },
    tabsRow: {
      flexDirection: "row",
      gap: 6,
      marginTop: spacing.sm,
      marginBottom: 10,
      borderBottomWidth: 1,
      borderBottomColor: colors.borderLight,
      paddingBottom: 6,
    },
    tabBtn: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: radius.md },
    tabBtnActive: { backgroundColor: colors.primary + "18" },
    tabBtnText: { color: colors.textSecondary, fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
    tabBtnTextActive: { color: colors.primary },
    ledgerRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
    ledgerLine1: { color: colors.text, fontSize: 13, fontWeight: "700" },
    ledgerLine2: { color: colors.textSecondary, fontSize: 11, marginTop: 1 },
    ledgerAmount: { color: colors.text, fontSize: 13, fontWeight: "800" },
    ledgerLink: { color: colors.primary, fontSize: 11, fontWeight: "700", marginTop: 2 },
    modalBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", alignItems: "center", justifyContent: "center", padding: spacing.md },
    modalCard: { width: "min(520px, 92vw)" as any, maxHeight: "85vh" as any, backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.md, borderWidth: 1, borderColor: colors.borderLight },
    modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.sm },
    modalTitle: { color: colors.text, fontSize: 15, fontWeight: "800", letterSpacing: 0.4 },
    formLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: "700", letterSpacing: 0.4, marginBottom: 3 },
    formInput: { color: colors.text, fontSize: 13, paddingVertical: 8, paddingHorizontal: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderLight, backgroundColor: colors.background },
    formHint: { color: colors.textSecondary, fontSize: 11, lineHeight: 16, marginBottom: spacing.sm, fontStyle: "italic" },
    pillRow: { flexDirection: "row", gap: 6, marginBottom: 8 },
    pill: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.borderLight, backgroundColor: colors.background },
    pillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
    pillText: { fontSize: 10, fontWeight: "800", letterSpacing: 0.4, color: colors.textSecondary },
    pillTextActive: { color: "#fff" },
    choiceRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, paddingHorizontal: 8, borderRadius: radius.md },
    choiceRowActive: { backgroundColor: colors.primary + "12" },
    choiceRowText: { color: colors.text, fontSize: 12, flex: 1 },
    primaryBtn: { marginTop: spacing.md, alignItems: "center", justifyContent: "center", paddingVertical: 12, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.primary },
    // Uses onPrimary so the label stays legible whether the brand
    // colour is dark red, neon lime or anything in between — was
    // hard-coded to #fff which failed WCAG AA on lighter primaries.
    primaryBtnText: { color: colors.onPrimary || "#fff", fontSize: 14, fontWeight: "800", letterSpacing: 0.3 },
  });
