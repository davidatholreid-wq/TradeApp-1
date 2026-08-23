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
import EditDealershipDetailsModal from "@/src/components/EditDealershipDetailsModal";

type Contact = { name?: string | null; phone?: string | null; email?: string | null };

type DealerRow = {
  id: string;
  name: string;
  accounts_contact?: Contact;
  wallet_balance_zar: number;
  wallet_usage_zar: number;
  wallet_credits_zar: number;
  suspended: boolean;
  pay_in_arrears?: boolean;
};

type Wallet = {
  balance_zar: number;
  credits_zar: number;
  usage_zar: number;
  refunds_zar: number;
  suspended: boolean;
  pay_in_arrears?: boolean;
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

type Payment = {
  id: string;
  amount_cents: number;
  amount_zar: number;
  payment_date: string;
  bank_reference: string;
  notes?: string;
  invoice_id?: string | null;
  is_deposit?: boolean;
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
    pay_in_arrears?: boolean;
  };
  wallet: Wallet;
  invoices: Invoice[];
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
  const [tab, setTab] = useState<"invoices" | "payments" | "refunds">("invoices");

  // Modals
  const [loadPaymentOpen, setLoadPaymentOpen] = useState(false);
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
          Per-dealer prepaid wallets · auto-generated monthly invoices · strict payment allocation
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
        <TouchableOpacity
          testID="billing-debtors-report-btn"
          style={styles.secondaryBtn}
          onPress={() => openAuthedPdf(
            "/api/admin/billing/debtors-report.pdf",
            `debtors_report_${new Date().toISOString().slice(0, 10)}.pdf`,
          ).catch((e) => Alert.alert("Couldn't open Debtors Report", e?.message || ""))}
        >
          <Ionicons name="podium-outline" size={14} color={colors.text} />
          <Text style={styles.secondaryBtnText}>Debtors Report</Text>
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
                  ) : r.pay_in_arrears ? (
                    <View style={styles.creditPill}>
                      <Text style={styles.creditPillText}>CREDIT</Text>
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
                    <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <ArrearsToggle
                        dealershipId={summary.dealership.id}
                        value={!!summary.dealership.pay_in_arrears}
                        onChanged={refreshAll}
                        styles={styles}
                        colors={colors}
                      />
                      <TouchableOpacity
                        testID="edit-dealership-btn"
                        style={styles.editDealerBtn}
                        onPress={() => setEditDealerOpen(true)}
                      >
                        <Ionicons name="create-outline" size={13} color={colors.primary} />
                        <Text style={styles.editDealerBtnText}>Edit dealership</Text>
                      </TouchableOpacity>
                    </View>
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
                  {summary.dealership.pay_in_arrears ? (
                    <View style={styles.arrearsBanner}>
                      <Ionicons name="hourglass-outline" size={13} color="#0369A1" />
                      <Text style={styles.arrearsBannerText}>
                        Credit terms — this dealer can operate without a positive balance and is billed monthly in arrears.
                      </Text>
                    </View>
                  ) : null}
                </View>
              </View>

              {/* Action buttons */}
              <View style={styles.actionRow}>
                <ActionButton icon="cash-outline" label="Record Payment" onPress={() => setLoadPaymentOpen(true)} colors={colors} styles={styles} testID="btn-load-payment" primary />
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

              <Text style={styles.autoInvoiceHint}>
                Invoices are generated automatically on the 1st of every month for the prior month&apos;s billable activity.
              </Text>

              {/* Tabs */}
              <View style={styles.tabsRow}>
                {(["invoices", "payments", "refunds"] as const).map((t) => (
                  <TouchableOpacity
                    key={t}
                    style={[styles.tabBtn, tab === t && styles.tabBtnActive]}
                    onPress={() => setTab(t)}
                  >
                    <Text style={[styles.tabBtnText, tab === t && styles.tabBtnTextActive]}>
                      {t.toUpperCase()} ({t === "invoices" ? summary.invoices.length : t === "payments" ? summary.payments.length : summary.refunds.length})
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {tab === "invoices" && (
                <InvoiceLedger
                  invoices={summary.invoices}
                  dealershipId={summary.dealership.id}
                  onResent={refreshAll}
                  styles={styles}
                  colors={colors}
                />
              )}
              {tab === "payments" && (
                <LedgerList
                  rows={summary.payments.map((p) => ({
                    key: p.id,
                    line1: `${p.bank_reference || "(no ref)"} · ${p.invoice_id ? "Invoice payment" : "Deposit top-up"}`,
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
          <LoadPaymentModal
            open={loadPaymentOpen}
            onClose={() => setLoadPaymentOpen(false)}
            dealership={summary.dealership}
            invoices={summary.invoices}
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
          <EditDealershipDetailsModal
            open={editDealerOpen}
            onClose={() => setEditDealerOpen(false)}
            dealership={summary.dealership as any}
            onSaved={refreshAll}
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

function ArrearsToggle({ dealershipId, value, onChanged, styles, colors }: {
  dealershipId: string; value: boolean; onChanged: () => void; styles: any; colors: any;
}) {
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState(value);
  useEffect(() => { setLocal(value); }, [value]);
  const flip = async () => {
    if (busy) return;
    const target = !local;
    // Ask before granting credit terms — this is a business/finance
    // decision, not a UI convenience toggle.
    const confirmMsg = target
      ? "Grant credit terms? This dealer will be able to submit valuations and order VIN reports without a positive balance. They will be invoiced in arrears at month-end."
      : "Revoke credit terms? Once revoked, the dealer must maintain a positive wallet balance again to keep operating.";
    if (Platform.OS === "web" && typeof window !== "undefined") {
      if (!window.confirm(confirmMsg)) return;
    }
    setBusy(true);
    setLocal(target);
    try {
      await apiFetch(`/api/admin/dealerships/${dealershipId}/billing-terms`, {
        method: "PATCH",
        body: JSON.stringify({ pay_in_arrears: target }),
      });
      onChanged();
    } catch (e: any) {
      setLocal(!target);
      Alert.alert("Couldn't update terms", e?.message || "");
    } finally {
      setBusy(false);
    }
  };
  return (
    <TouchableOpacity
      testID="arrears-toggle"
      onPress={flip}
      disabled={busy}
      style={[styles.arrearsToggle, local && styles.arrearsToggleOn, busy && { opacity: 0.5 }]}
    >
      <View style={[styles.arrearsKnob, local && styles.arrearsKnobOn]} />
      <Text style={[styles.arrearsToggleText, local && styles.arrearsToggleTextOn]}>
        {local ? "PAY IN ARREARS · ON" : "PAY IN ARREARS · OFF"}
      </Text>
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
function InvoiceLedger({ invoices, dealershipId, onResent, styles, colors }: {
  invoices: Invoice[]; dealershipId: string; onResent: () => void; styles: any; colors: any;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const resend = async (inv: Invoice) => {
    setBusyId(inv.id);
    try {
      const res = await apiFetch(
        `/api/admin/dealerships/${dealershipId}/invoices/${inv.id}/resend-email`,
        { method: "POST", body: "{}" },
      );
      Alert.alert("Invoice email sent", `Emailed to ${res?.emailed_to || "accounts contact"}.`);
      onResent();
    } catch (e: any) {
      Alert.alert("Couldn't resend", e?.message || "");
    } finally {
      setBusyId(null);
    }
  };
  if (invoices.length === 0) {
    return <Text style={[styles.muted, { marginTop: spacing.md }]}>No invoices generated yet. They will appear here automatically on the 1st of each month.</Text>;
  }
  return (
    <View style={{ marginTop: spacing.sm }}>
      {invoices.map((i) => (
        <View key={i.id} style={styles.ledgerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.ledgerLine1}>{i.reference} · {i.period_label}</Text>
            <Text style={styles.ledgerLine2}>
              Emailed: {i.emailed_to || "not sent"} · Status: {i.status}
              {i.total_paid_cents ? `  · Paid: ${cents(i.total_paid_cents)}` : ""}
            </Text>
          </View>
          <View style={{ alignItems: "flex-end", gap: 4 }}>
            <Text style={styles.ledgerAmount}>{cents(i.total_cents)}</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <TouchableOpacity
                testID={`invoice-pdf-${i.reference}`}
                onPress={() => openAuthedPdf(
                  `/api/admin/dealerships/${dealershipId}/invoices/${i.id}.pdf`,
                  `invoice_${i.reference}.pdf`,
                ).catch((e) => Alert.alert("Couldn't open PDF", e?.message || ""))}
              >
                <Text style={styles.ledgerLink}>PDF</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID={`resend-invoice-${i.reference}`}
                onPress={() => resend(i)}
                disabled={busyId === i.id}
              >
                <Text style={[styles.ledgerLink, busyId === i.id && { opacity: 0.4 }]}>
                  {busyId === i.id ? "Sending…" : "Resend email"}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}

function useForm<T extends Record<string, any>>(initial: T) {
  const [values, setValues] = useState<T>(initial);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof T, v: any) => setValues((s) => ({ ...s, [k]: v }));
  return { values, setValues, set, busy, setBusy };
}

function LoadPaymentModal({ open, onClose, dealership, invoices, onSaved, colors, styles }: any) {
  // "invoice" allocation is the default because in the new billing
  // model an admin is almost always recording a payment against a
  // specific auto-generated invoice. Top-ups happen but are rarer.
  const outstanding = (invoices as Invoice[]).filter((i) => i.status !== "paid");
  const { values, set, setValues, busy, setBusy } = useForm({
    amount_zar: "", payment_date: new Date().toISOString().slice(0, 10),
    bank_reference: "", notes: "",
    allocation: (outstanding.length > 0 ? "invoice" : "deposit") as "invoice" | "deposit",
    invoice_id: outstanding[0]?.id || "",
  });
  useEffect(() => {
    if (open) {
      const first = outstanding[0]?.id || "";
      setValues({
        amount_zar: "", payment_date: new Date().toISOString().slice(0, 10),
        bank_reference: "", notes: "",
        allocation: first ? "invoice" : "deposit",
        invoice_id: first,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const save = async () => {
    const amt = parseFloat(values.amount_zar);
    if (!amt || amt <= 0) { Alert.alert("Enter a valid amount"); return; }
    if (!values.bank_reference) { Alert.alert("Bank reference is required"); return; }
    if (values.allocation === "invoice" && !values.invoice_id) {
      Alert.alert("Pick the invoice this payment settles, or switch to 'Top-up Deposit'.");
      return;
    }
    setBusy(true);
    try {
      const body: any = {
        amount_zar: amt,
        payment_date: values.payment_date,
        bank_reference: values.bank_reference,
        notes: values.notes,
      };
      if (values.allocation === "invoice") body.invoice_id = values.invoice_id;
      else body.is_deposit = true;
      await apiFetch(`/api/admin/dealerships/${dealership.id}/payments`, {
        method: "POST", body: JSON.stringify(body),
      });
      onSaved(); onClose();
      Alert.alert(
        "Payment recorded",
        values.allocation === "invoice"
          ? "The invoice has been updated and the dealer emailed an updated statement."
          : "Deposit top-up applied to the wallet.",
      );
    } catch (e: any) { Alert.alert("Failed", e?.message || ""); }
    finally { setBusy(false); }
  };
  return (
    <MinimalModal open={open} onClose={onClose} title="Record Payment (received EFT)" styles={styles}>
      <Text style={styles.formHint}>
        Every payment must be allocated. Either settle an existing invoice, or record it as a standalone deposit top-up against the wallet.
      </Text>
      <FormField label="Amount (R)" value={values.amount_zar} onChangeText={(v) => set("amount_zar", v)} keyboardType="decimal-pad" styles={styles} />
      <FormField label="Payment date (YYYY-MM-DD)" value={values.payment_date} onChangeText={(v) => set("payment_date", v)} styles={styles} />
      <FormField label="Bank reference" value={values.bank_reference} onChangeText={(v) => set("bank_reference", v)} styles={styles} placeholder="e.g. FNB EFT-9812" />
      <FormField label="Notes (optional)" value={values.notes} onChangeText={(v) => set("notes", v)} multiline styles={styles} />
      <Text style={styles.formLabel}>Allocate to</Text>
      <View style={styles.pillRow}>
        <TouchableOpacity
          testID="allocation-invoice"
          style={[styles.pill, values.allocation === "invoice" && styles.pillActive]}
          onPress={() => set("allocation", "invoice")}
        >
          <Text style={[styles.pillText, values.allocation === "invoice" && styles.pillTextActive]}>INVOICE</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="allocation-deposit"
          style={[styles.pill, values.allocation === "deposit" && styles.pillActive]}
          onPress={() => set("allocation", "deposit")}
        >
          <Text style={[styles.pillText, values.allocation === "deposit" && styles.pillTextActive]}>TOP-UP DEPOSIT</Text>
        </TouchableOpacity>
      </View>
      {values.allocation === "invoice" && (
        <ChoiceList
          label="Select the invoice this payment settles"
          items={outstanding.length === 0
            ? []
            : outstanding.map((i) => ({ id: i.id, label: `${i.reference} — ${i.period_label} — ${cents(i.total_cents)} — ${i.status}${i.total_paid_cents ? ` (paid ${cents(i.total_paid_cents)})` : ""}` }))
          }
          value={values.invoice_id}
          onChange={(v) => set("invoice_id", v)}
          styles={styles}
        />
      )}
      {values.allocation === "deposit" && (
        <Text style={[styles.formHint, { marginTop: 4 }]}>
          This payment will credit the dealership wallet as a top-up. Use this only if the dealer is pre-funding ahead of the month-end invoice.
        </Text>
      )}
      <PrimaryButton testID="load-payment-submit" label={busy ? "Saving…" : "Record Payment"} onPress={save} disabled={busy} styles={styles} />
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
    creditPill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: "#E0F2FE", borderWidth: 1, borderColor: "#0369A1" },
    creditPillText: { color: "#0369A1", fontSize: 9, fontWeight: "800", letterSpacing: 0.4 },
    arrearsToggle: {
      flexDirection: "row", alignItems: "center", gap: 6,
      paddingVertical: 4, paddingHorizontal: 8,
      borderRadius: radius.pill, borderWidth: 1,
      borderColor: colors.borderLight, backgroundColor: colors.card,
    },
    arrearsToggleOn: { borderColor: "#0369A1", backgroundColor: "#E0F2FE" },
    arrearsToggleText: { color: colors.textSecondary, fontSize: 10, fontWeight: "800", letterSpacing: 0.4 },
    arrearsToggleTextOn: { color: "#0369A1" },
    arrearsKnob: {
      width: 10, height: 10, borderRadius: 5,
      backgroundColor: colors.textSecondary,
    },
    arrearsKnobOn: { backgroundColor: "#0369A1" },
    arrearsBanner: {
      flexDirection: "row", alignItems: "flex-start", gap: 6,
      marginTop: spacing.sm, padding: 8,
      borderRadius: radius.md, borderWidth: 1,
      borderColor: "#0369A1", backgroundColor: "#E0F2FE",
    },
    arrearsBannerText: { flex: 1, color: "#0C4A6E", fontSize: 11, lineHeight: 15, fontWeight: "600" },
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
    autoInvoiceHint: {
      color: colors.textSecondary,
      fontSize: 11,
      fontStyle: "italic",
      marginTop: -6,
      marginBottom: spacing.sm,
      lineHeight: 16,
    },
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
