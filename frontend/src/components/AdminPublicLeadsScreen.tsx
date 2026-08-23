// -----------------------------------------------------------------------------
// AdminPublicLeadsScreen — admin cockpit tab for the Public Valuation Portal.
//
// Three buckets across a tabbed header: Pending → Priced → Delivered.
// Selecting a lead opens a detail pane with photos + a two-stage action flow:
//   1. If pending: inline "Price this lead" (amount + notes) → POST /price
//   2. If priced (not delivered): "Deliver" modal — editable WhatsApp text
//      (with {{pdf_url}} substitution), editable email subject/body, per-
//      channel toggles → POST /deliver → opens a new tab to wa.me and the
//      tokenised PDF URL, and records delivery via Emergent Resend.
//
// Endpoints:
//   GET  /api/admin/public-submissions?bucket=pending|priced|delivered
//   GET  /api/admin/public-submissions/{id}
//   POST /api/admin/public-submissions/{id}/price   {price, price_notes}
//   POST /api/admin/public-submissions/{id}/deliver {whatsapp_message, email_subject, email_body, channels}
// -----------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
  TextInput,
  ActivityIndicator,
  Modal,
  Pressable,
  useWindowDimensions,
  Platform,
  Linking,
  Alert,
} from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import { spacing, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { apiFetch } from "@/src/api";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------
type Bucket = "pending" | "priced" | "delivered" | "deleted";

type PublicSubmission = {
  id: string;
  reference: string;
  status: "pending" | "priced";
  seller: {
    full_name: string;
    phone: string;
    email: string;
    consent_accepted_at?: string;
    consent_ip?: string;
  };
  vehicle: {
    year: number;
    make: string;
    model: string;
    derivative?: string | null;
    vin?: string | null;
    mileage: number;
    colour?: string | null;
    transmission?: string | null;
    fuel_type?: string | null;
    date_of_test?: string | null;
    license_disk_data?: string | null;
  };
  condition: {
    overall: string;
    accident_damage: boolean;
    damage_notes?: string | null;
    service_history: string;
  };
  photos: Record<string, string | null>;
  price?: number | null;
  price_notes?: string | null;
  priced_at?: string | null;
  delivered_email_at?: string | null;
  delivered_whatsapp_at?: string | null;
  last_whatsapp_message?: string | null;
  last_email_subject?: string | null;
  last_email_body?: string | null;
  // Soft-delete markers — populated when an admin has moved this lead
  // into the Deleted silo. Nullable so pending / priced / delivered
  // rows stay untouched.
  deleted_at?: string | null;
  deleted_by?: string | null;
  deleted_by_email?: string | null;
  created_at: string;
  ip_address?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  market_values?: {
    status?: string;
    fetched_at?: string;
    trade_price_zar?: number | null;
    retail_price_zar?: number | null;
    adjusted_trade_zar?: number | null;
    adjusted_retail_zar?: number | null;
    market_price_zar?: number | null;
    new_price_zar?: number | null;
    mm_code?: string | null;
  } | null;
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const fmtZAR = (n?: number | null) =>
  n === null || n === undefined
    ? "—"
    : "R" + Number(n).toLocaleString("en-ZA", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const fmtDateTime = (iso?: string | null) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-ZA", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
};

const fmtDate = (iso?: string | null) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
};

const fmtKm = (n?: number) => (n ? n.toLocaleString("en-ZA") + " km" : "—");

const parseIntSafe = (s: string) => {
  const n = parseInt(s.replace(/\s|,/g, ""), 10);
  return Number.isFinite(n) ? n : NaN;
};

const defaultWaTemplate = (sub: PublicSubmission) => {
  const y = sub.vehicle.year;
  const mk = sub.vehicle.make;
  const md = sub.vehicle.model;
  const price = fmtZAR(sub.price || 0);
  return (
    `Hi ${sub.seller.full_name.split(" ")[0] || "there"} 👋

Thanks for requesting a valuation from TRADE AI powered by FOURBUY

For your ${y} ${mk} ${md} we're offering:
${price}

Full valuation PDF (valid 30 days):
{{pdf_url}}

If you'd like to accept, just reply to this WhatsApp. We'll come to you, pay you on the spot and take care of all the admin.

Ref: ${sub.reference}
— TRADE AI powered by FOURBUY`
  );
};

const defaultEmailSubject = (sub: PublicSubmission) =>
  `Your Fourbuy valuation for the ${sub.vehicle.year} ${sub.vehicle.make} ${sub.vehicle.model} — ${sub.reference}`;

const defaultEmailBody = (sub: PublicSubmission) => {
  return (
    `Hi ${sub.seller.full_name},

Thank you for requesting a valuation from TRADE AI powered by FOURBUY

Vehicle: ${sub.vehicle.year} ${sub.vehicle.make} ${sub.vehicle.model}${sub.vehicle.derivative ? " " + sub.vehicle.derivative : ""}
Mileage: ${fmtKm(sub.vehicle.mileage)}

Our valuation: ${fmtZAR(sub.price || 0)}

The full valuation (with our reconditioning breakdown) is attached to this email as a PDF.

If you'd like to accept our offer, simply reply to this email and we'll be in touch to arrange collection at a time and place that suits you.

Kind regards,
The Fourbuy Team`
  );
};

// -----------------------------------------------------------------------------
// Screen
// -----------------------------------------------------------------------------
export default function AdminPublicLeadsScreen() {
  const colors = useThemeColors();
  const { width } = useWindowDimensions();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const isWide = width >= 900;

  const [bucket, setBucket] = useState<Bucket>("pending");
  const [rows, setRows] = useState<PublicSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<PublicSubmission | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);

  const [priceInput, setPriceInput] = useState("");
  const [priceNotes, setPriceNotes] = useState("");
  const [pricing, setPricing] = useState(false);

  const [deliverOpen, setDeliverOpen] = useState(false);
  const [waMsg, setWaMsg] = useState("");
  const [emSubject, setEmSubject] = useState("");
  const [emBody, setEmBody] = useState("");
  const [waOn, setWaOn] = useState(true);
  const [emOn, setEmOn] = useState(true);
  const [delivering, setDelivering] = useState(false);

  const [photoZoom, setPhotoZoom] = useState<string | null>(null);
  const [waFallbackUrl, setWaFallbackUrl] = useState<string | null>(null);

  // Kredo market values
  const [kredoLoading, setKredoLoading] = useState(false);

  const fetchKredoValues = async () => {
    if (!selected || kredoLoading) return;
    setKredoLoading(true);
    try {
      const res = await apiFetch(`/api/admin/public-submissions/${selected.id}/market-values`, {
        method: "POST",
      });
      if (res?.market_values) {
        setSelected({ ...selected, market_values: res.market_values } as any);
      }
    } catch (e: any) {
      Alert.alert("Kredo lookup failed", e?.message || "Please try again in a moment.");
    } finally {
      setKredoLoading(false);
    }
  };

  // ---------- data ----------
  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/admin/public-submissions?bucket=${bucket}`);
      setRows(res.submissions || []);
    } catch (e: any) {
      Alert.alert("Load failed", e?.message || "Could not load public leads.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [bucket]);

  const loadSelected = useCallback(async () => {
    if (!selectedId) return;
    setSelectedLoading(true);
    try {
      const res = await apiFetch(`/api/admin/public-submissions/${selectedId}`);
      setSelected(res.submission);
      setPriceInput(res.submission?.price ? String(res.submission.price) : "");
      setPriceNotes(res.submission?.price_notes || "");
    } catch (e: any) {
      Alert.alert("Load failed", e?.message || "Could not load lead.");
      setSelected(null);
    } finally {
      setSelectedLoading(false);
    }
  }, [selectedId]);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { loadSelected(); }, [loadSelected]);

  // ---------- actions ----------

  // Soft-delete a Pending or Priced lead. Delivered leads are guarded
  // server-side (409) so this button is also hidden in the UI for that
  // silo. Uses a native confirm dialog on web (Alert.alert on web only
  // renders a button-less banner) and Alert.alert on native.
  const confirmDelete = useCallback(async (row: PublicSubmission) => {
    const label = `${row.reference} — ${row.vehicle.year} ${row.vehicle.make} ${row.vehicle.model}`;
    const proceed = await new Promise<boolean>((resolve) => {
      if (Platform.OS === "web") {
        const w = (globalThis as any).window;
        resolve(w && typeof w.confirm === "function" ? w.confirm(`Delete this lead?\n\n${label}\n\nThe lead will move to the Deleted silo. Delivered leads can never be deleted.`) : true);
      } else {
        Alert.alert(
          "Delete this lead?",
          `${label}\n\nIt will move to the Deleted silo. Delivered leads can never be deleted.`,
          [
            { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
            { text: "Delete", style: "destructive", onPress: () => resolve(true) },
          ],
        );
      }
    });
    if (!proceed) return;
    try {
      await apiFetch(`/api/admin/public-submissions/${row.id}`, { method: "DELETE" });
      // If the currently-selected lead was the one we deleted, clear
      // the detail pane so it doesn't show a "ghost" state.
      if (selectedId === row.id) {
        setSelectedId(null);
        setSelected(null);
      }
      await loadList();
    } catch (e: any) {
      Alert.alert("Delete failed", e?.message || "Could not delete lead.");
    }
  }, [selectedId, loadList]);

  // Restore a soft-deleted lead back to its previous silo (Pending or
  // Priced, depending on where it was before deletion — the server
  // preserves `price` / `priced_at` across deletions).
  const restoreLead = useCallback(async (row: PublicSubmission) => {
    try {
      await apiFetch(`/api/admin/public-submissions/${row.id}/restore`, { method: "POST" });
      if (selectedId === row.id) {
        setSelectedId(null);
        setSelected(null);
      }
      await loadList();
    } catch (e: any) {
      Alert.alert("Restore failed", e?.message || "Could not restore lead.");
    }
  }, [selectedId, loadList]);

  const handlePrice = async () => {
    if (!selected) return;
    const p = parseIntSafe(priceInput);
    if (!(p > 0 && p <= 100_000_000)) {
      Alert.alert("Invalid price", "Please enter a valid amount in Rand (e.g. 285000).");
      return;
    }
    setPricing(true);
    try {
      await apiFetch(`/api/admin/public-submissions/${selected.id}/price`, {
        method: "POST",
        body: JSON.stringify({ price: p, price_notes: priceNotes || null }),
      });
      Alert.alert("Priced", `${selected.reference} is now ready to deliver.`);
      await loadSelected();
      await loadList();
    } catch (e: any) {
      Alert.alert("Failed", e?.message || "Could not save price.");
    } finally {
      setPricing(false);
    }
  };

  const openDeliver = () => {
    if (!selected) return;
    setWaMsg(selected.last_whatsapp_message || defaultWaTemplate(selected));
    setEmSubject(selected.last_email_subject || defaultEmailSubject(selected));
    setEmBody(selected.last_email_body || defaultEmailBody(selected));
    setWaOn(true);
    setEmOn(true);
    setDeliverOpen(true);
  };

  const handleDeliver = async () => {
    if (!selected) return;
    if (!waOn && !emOn) {
      Alert.alert("Choose a channel", "Please enable at least one delivery channel.");
      return;
    }
    if (waOn && !waMsg.includes("{{pdf_url}}")) {
      Alert.alert(
        "Missing link placeholder",
        "The WhatsApp message must contain {{pdf_url}} so the tokenised PDF link can be inserted.",
      );
      return;
    }
    // ---- Popup-blocker workaround ----
    // Browsers only allow `window.open(...)` when it's the direct
    // synchronous result of a user gesture. Because we `await` the
    // deliver call before calling wa.me, Safari (and most modern
    // browsers) will silently block a fresh window.open() from an
    // async callback. So pre-open a blank tab synchronously here and
    // fill in the URL once we have it.
    let waTab: Window | null = null;
    if (Platform.OS === "web" && waOn) {
      try { waTab = window.open("about:blank", "_blank"); } catch { waTab = null; }
    }

    setDelivering(true);
    try {
      const channels: string[] = [];
      if (waOn) channels.push("whatsapp");
      if (emOn) channels.push("email");
      const res = await apiFetch(`/api/admin/public-submissions/${selected.id}/deliver`, {
        method: "POST",
        body: JSON.stringify({
          whatsapp_message: waMsg,
          email_subject: emSubject,
          email_body: emBody,
          channels,
        }),
      });
      // Redirect the pre-opened tab (or fall back to a manual link).
      let waUrl: string | null = null;
      if (waOn && res?.wa_number && res?.whatsapp_message) {
        waUrl = `https://wa.me/${res.wa_number}?text=${encodeURIComponent(res.whatsapp_message)}`;
        if (Platform.OS === "web") {
          if (waTab && !waTab.closed) {
            try { waTab.location.href = waUrl; } catch { /* cross-origin, ignore */ }
          } else {
            // Popup was blocked — try one more direct open, then show
            // the manual fallback modal below if that also fails.
            try {
              const late = window.open(waUrl, "_blank");
              if (!late) throw new Error("blocked");
            } catch {
              // Store the URL so we render a "Tap to open WhatsApp"
              // fallback link the admin can click manually.
              setWaFallbackUrl(waUrl);
            }
          }
        } else {
          Linking.openURL(waUrl).catch(() => {});
        }
      } else if (waOn && waTab) {
        try { waTab.close(); } catch {}
      }

      setDeliverOpen(false);
      await loadSelected();
      await loadList();

      // Success feedback — with a manual link if we couldn't open the tab.
      if (waOn && Platform.OS === "web" && !waTab && waUrl) {
        // Fallback banner already set above; no alert.
      } else {
        Alert.alert(
          "Delivered",
          `${selected.reference} has been marked as delivered.`,
        );
      }
    } catch (e: any) {
      // Close the blank pre-opened tab so we don't leave the admin with
      // an empty tab if delivery fails.
      try { waTab?.close(); } catch {}
      Alert.alert("Failed", e?.message || "Could not deliver valuation.");
    } finally {
      setDelivering(false);
    }
  };

  // ---------- render ----------
  const bucketCounts = useMemo(() => rows.length, [rows]);

  return (
    <View style={styles.root}>
      {/* Sticky header with bucket tabs */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Ionicons name="people-circle-outline" size={22} color={colors.text} />
          <Text style={styles.headerTitle}>Public Leads</Text>
          <View style={styles.chip}>
            <Text style={styles.chipText}>{bucketCounts}</Text>
          </View>
        </View>
        <View style={styles.tabsRow}>
          {(["pending", "priced", "delivered", "deleted"] as Bucket[]).map((b) => (
            <TouchableOpacity
              key={b}
              testID={`public-leads-tab-${b}`}
              style={[styles.tab, bucket === b && styles.tabOn]}
              onPress={() => { setBucket(b); setSelectedId(null); setSelected(null); }}
            >
              <Text style={[styles.tabText, bucket === b && styles.tabTextOn]}>
                {b.charAt(0).toUpperCase() + b.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity onPress={loadList} style={styles.refreshBtn}>
            <Ionicons name="refresh" size={16} color={colors.text} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Body: split-pane on wide, stacked on narrow */}
      <View style={[styles.body, !isWide && { flexDirection: "column" }]}>
        {/* Left — list */}
        <View style={[styles.leftPane, !isWide && { width: "100%", maxHeight: selected ? 220 : undefined }]}>
          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={colors.primary} />
              <Text style={styles.dim}>Loading leads…</Text>
            </View>
          ) : rows.length === 0 ? (
            <View style={styles.center}>
              <Ionicons name="mail-open-outline" size={44} color={colors.textDisabled} />
              <Text style={styles.dim}>No {bucket} leads.</Text>
              <Text style={styles.dimSmall}>Public submissions arrive at /get-valuation.</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={{ padding: spacing.sm }}>
              {rows.map((r) => (
                <View key={r.id} style={styles.rowWrap}>
                  <TouchableOpacity
                    testID={`public-lead-row-${r.reference}`}
                    style={[styles.row, selectedId === r.id && styles.rowActive]}
                    onPress={() => setSelectedId(r.id)}
                    activeOpacity={0.85}
                  >
                    <View style={styles.rowHead}>
                      <Text style={styles.rowRef}>{r.reference}</Text>
                      <Text style={styles.rowDate}>
                        {bucket === "deleted" && r.deleted_at
                          ? `Deleted ${fmtDate(r.deleted_at)}`
                          : fmtDate(r.created_at)}
                      </Text>
                    </View>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {r.vehicle.year} {r.vehicle.make} {r.vehicle.model}
                      {r.vehicle.derivative ? ` ${r.vehicle.derivative}` : ""}
                    </Text>
                    <View style={styles.rowMetaRow}>
                      <Text style={styles.rowMeta}>{fmtKm(r.vehicle.mileage)}</Text>
                      <Text style={styles.rowMeta}>•</Text>
                      <Text style={styles.rowMeta} numberOfLines={1}>{r.seller.full_name}</Text>
                    </View>
                    {r.status === "priced" ? (
                      <View style={styles.rowPrice}>
                        <Text style={styles.rowPriceText}>{fmtZAR(r.price)}</Text>
                      </View>
                    ) : null}
                  </TouchableOpacity>
                  {/* Row action rail — a small trash / restore button
                      lives on top of the row so it's reachable without
                      opening the detail pane. Delivered leads never
                      show this rail (they're protected server-side). */}
                  {bucket === "pending" || bucket === "priced" ? (
                    <TouchableOpacity
                      testID={`public-lead-delete-${r.reference}`}
                      style={styles.rowAction}
                      onPress={() => confirmDelete(r)}
                      accessibilityRole="button"
                      accessibilityLabel={`Delete ${r.reference}`}
                    >
                      <Ionicons name="trash-outline" size={16} color={colors.danger} />
                    </TouchableOpacity>
                  ) : null}
                  {bucket === "deleted" ? (
                    <TouchableOpacity
                      testID={`public-lead-restore-${r.reference}`}
                      style={styles.rowAction}
                      onPress={() => restoreLead(r)}
                      accessibilityRole="button"
                      accessibilityLabel={`Restore ${r.reference}`}
                    >
                      <Ionicons name="refresh" size={16} color={colors.primary} />
                    </TouchableOpacity>
                  ) : null}
                </View>
              ))}
            </ScrollView>
          )}
        </View>

        {/* Right — detail */}
        <View style={styles.rightPane}>
          {selectedLoading ? (
            <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
          ) : !selected ? (
            <View style={styles.center}>
              <Ionicons name="finger-print-outline" size={44} color={colors.textDisabled} />
              <Text style={styles.dim}>Pick a lead to see the details.</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
              {/* WhatsApp popup-blocker fallback — shown when the browser
                  refuses to auto-open the wa.me tab. Admin taps this to
                  launch WhatsApp manually. */}
              {waFallbackUrl ? (
                <View style={{
                  padding: 12,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: "#25D366",
                  backgroundColor: "#25D36612",
                  marginBottom: 14,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                }}>
                  <Ionicons name="logo-whatsapp" size={24} color="#25D366" />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.text, fontSize: 13, fontWeight: "600" }}>
                      WhatsApp tab blocked by browser
                    </Text>
                    <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                      Tap below to open WhatsApp manually.
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => {
                      if (Platform.OS === "web") window.open(waFallbackUrl!, "_blank");
                      else Linking.openURL(waFallbackUrl!);
                      setWaFallbackUrl(null);
                    }}
                    style={{
                      backgroundColor: "#25D366",
                      paddingHorizontal: 14,
                      paddingVertical: 10,
                      borderRadius: 8,
                    }}
                  >
                    <Text style={{ color: "#FFFFFF", fontWeight: "700", fontSize: 13 }}>Open</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setWaFallbackUrl(null)}>
                    <Ionicons name="close" size={20} color={colors.textSecondary} />
                  </TouchableOpacity>
                </View>
              ) : null}
              {/* Title bar */}
              <View style={styles.detailHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.detailRef}>{selected.reference}</Text>
                  <Text style={styles.detailTitle}>
                    {selected.vehicle.year} {selected.vehicle.make} {selected.vehicle.model}
                    {selected.vehicle.derivative ? ` ${selected.vehicle.derivative}` : ""}
                  </Text>
                  <Text style={styles.detailSub}>
                    {fmtKm(selected.vehicle.mileage)} • {selected.vehicle.colour || "—"} • {selected.vehicle.transmission || "—"} • {selected.vehicle.fuel_type || "—"}
                  </Text>
                </View>
                <StatusBadge sub={selected} colors={colors} />
              </View>

              {/* Contact */}
              <SectionTitle title="Contact" colors={colors} />
              <View style={styles.grid}>
                <KV label="Name" value={selected.seller.full_name}  colors={colors} />
                <KV label="Phone" value={selected.seller.phone}  colors={colors} />
                <KV label="Email" value={selected.seller.email}  colors={colors} />
                <KV label="Consent IP" value={selected.seller.consent_ip || "—"}  colors={colors} />
                <KV label="Received" value={fmtDateTime(selected.created_at)}  colors={colors} />
                {selected.utm_source ? <KV label="UTM source" value={selected.utm_source}  colors={colors} /> : null}
              </View>

              {/* Kredo Market Values — always available, powers the pricing decision */}
              <SectionTitle title="Kredo Market Values" colors={colors} />
              <View style={{
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 12,
                padding: 14,
                backgroundColor: colors.card,
                marginBottom: 12,
              }}>
                {selected.market_values && selected.market_values.status === "ok" ? (
                  <>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
                      <KredoBox label="Trade" value={selected.market_values.trade_price_zar} colors={colors} accent={colors.success} />
                      <KredoBox label="Retail" value={selected.market_values.retail_price_zar} colors={colors} accent={colors.primary} />
                      <KredoBox label="Adj. Trade" value={selected.market_values.adjusted_trade_zar} colors={colors} />
                      <KredoBox label="Adj. Retail" value={selected.market_values.adjusted_retail_zar} colors={colors} />
                      <KredoBox label="Market" value={selected.market_values.market_price_zar} colors={colors} />
                      <KredoBox label="New List" value={selected.market_values.new_price_zar} colors={colors} />
                    </View>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
                      <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
                        {selected.market_values.mm_code ? `M&M ${selected.market_values.mm_code} • ` : ""}
                        Fetched {fmtDateTime(selected.market_values.fetched_at)}
                      </Text>
                      <TouchableOpacity onPress={fetchKredoValues} disabled={kredoLoading}>
                        <Text style={{ color: colors.primary, fontSize: 12, fontWeight: "700", textDecorationLine: "underline" }}>
                          {kredoLoading ? "Refreshing…" : "Refresh"}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </>
                ) : selected.market_values && selected.market_values.status === "error" ? (
                  <View style={{ alignItems: "center", paddingVertical: 12 }}>
                    <Ionicons name="warning-outline" size={28} color={colors.warning} />
                    <Text style={{ color: colors.text, fontSize: 13, fontWeight: "600", marginTop: 6, textAlign: "center" }}>
                      Kredo lookup failed
                    </Text>
                    <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 4, marginBottom: 12, textAlign: "center", paddingHorizontal: 12 }}>
                      {(selected.market_values as any).error || "Unknown error."}
                    </Text>
                    <TouchableOpacity
                      onPress={fetchKredoValues}
                      disabled={kredoLoading}
                      style={[styles.secondaryBtn, kredoLoading && { opacity: 0.6 }]}
                    >
                      {kredoLoading ? (
                        <ActivityIndicator color={colors.text} />
                      ) : (
                        <>
                          <Ionicons name="refresh" size={13} color={colors.text} />
                          <Text style={styles.secondaryBtnText}>Try again</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  </View>
                ) : (
                  <View style={{ alignItems: "center", paddingVertical: 12 }}>
                    <Ionicons name="cash-outline" size={30} color={colors.textSecondary} />
                    <Text style={{ color: colors.textSecondary, fontSize: 13, marginTop: 6, marginBottom: 12, textAlign: "center" }}>
                      Fetch live Kredo Trade & Retail values to inform your pricing.
                    </Text>
                    <TouchableOpacity
                      testID="fetch-kredo-values-btn"
                      onPress={fetchKredoValues}
                      disabled={kredoLoading}
                      style={[styles.primaryBtn, { paddingHorizontal: 18 }, kredoLoading && { opacity: 0.6 }]}
                    >
                      {kredoLoading ? (
                        <ActivityIndicator color={colors.onPrimary} />
                      ) : (
                        <>
                          <Ionicons name="cloud-download-outline" size={14} color={colors.onPrimary} />
                          <Text style={styles.primaryBtnText}>Fetch Kredo values</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  </View>
                )}
              </View>

              {/* Vehicle */}
              <SectionTitle title="Vehicle" colors={colors} />
              <View style={styles.grid}>
                <KV label="Fuel" value={selected.vehicle.fuel_type || "—"}  colors={colors} />
                <KV label="Transmission" value={selected.vehicle.transmission || "—"}  colors={colors} />
                <KV label="Year of production" value={(selected.vehicle as any).year_of_production || "—"} colors={colors} />
                <KV label="Year registered" value={(selected.vehicle as any).year_registered || selected.vehicle.year || "—"} colors={colors} />
                <KV label="VIN" value={selected.vehicle.vin || "—"} mono colors={colors} />
                <KV label="Colour" value={selected.vehicle.colour || "—"}  colors={colors} />
                <KV label="Roadworthy" value={selected.vehicle.date_of_test || "—"}  colors={colors} />
              </View>

              {/* Condition */}
              <SectionTitle title="Condition" colors={colors} />
              <View style={styles.grid}>
                <KV label="Overall" value={selected.condition.overall}  colors={colors} />
                <KV label="Service history" value={selected.condition.service_history}  colors={colors} />
                <KV label="Accident / damage" value={selected.condition.accident_damage ? "Yes" : "No"} colors={colors} />
                {selected.condition.damage_notes ? (
                  <KV label="Damage notes" value={selected.condition.damage_notes} wide  colors={colors} />
                ) : null}
              </View>

              {/* Photos */}
              <SectionTitle title="Photos" colors={colors} />
              <View style={styles.photoRow}>
                {["front", "rear", "left", "right", "interior", "dash"].map((slot) => {
                  const uri = selected.photos?.[slot];
                  return (
                    <TouchableOpacity
                      key={slot}
                      style={styles.photo}
                      disabled={!uri}
                      onPress={() => uri && setPhotoZoom(uri)}
                      activeOpacity={0.85}
                    >
                      {uri ? (
                        <Image source={{ uri }} style={StyleSheet.absoluteFill as any} />
                      ) : (
                        <Ionicons name="image-outline" size={22} color={colors.textDisabled} />
                      )}
                      <View style={styles.photoTag}>
                        <Text style={styles.photoTagText}>{slot}</Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Price / Deliver actions */}
              {selected.status === "pending" ? (
                <View style={styles.priceCard}>
                  <Text style={styles.priceHeader}>Price this lead</Text>
                  <View style={styles.priceRow}>
                    <View style={styles.rInput}>
                      <Text style={styles.rSymbol}>R</Text>
                      <TextInput
                        testID="public-lead-price-input"
                        style={styles.priceInput}
                        value={priceInput}
                        onChangeText={(t) => setPriceInput(t.replace(/[^\d\s]/g, ""))}
                        placeholder="285 000"
                        placeholderTextColor={colors.textDisabled}
                        keyboardType="number-pad"
                      />
                    </View>
                    <TouchableOpacity
                      testID="public-lead-price-btn"
                      style={[styles.primaryBtn, pricing && { opacity: 0.6 }]}
                      onPress={handlePrice}
                      disabled={pricing}
                    >
                      {pricing ? <ActivityIndicator color={colors.onPrimary} /> : (
                        <>
                          <Ionicons name="pricetag" size={14} color={colors.onPrimary} />
                          <Text style={styles.primaryBtnText}>Save price</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  </View>
                  <TextInput
                    testID="public-lead-notes-input"
                    style={styles.notesInput}
                    value={priceNotes}
                    onChangeText={setPriceNotes}
                    placeholder="Internal notes (optional) — customer sees these on the PDF"
                    placeholderTextColor={colors.textDisabled}
                    multiline
                    numberOfLines={3}
                  />
                </View>
              ) : (
                <View style={styles.deliverCard}>
                  <View style={styles.deliverPricedHead}>
                    <Text style={styles.deliverPricedLabel}>Priced</Text>
                    <Text style={styles.deliverPricedValue}>{fmtZAR(selected.price)}</Text>
                  </View>
                  {selected.price_notes ? (
                    <Text style={styles.deliverNotes}>{selected.price_notes}</Text>
                  ) : null}
                  <View style={{ flexDirection: "row", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                    <TouchableOpacity
                      testID="public-lead-deliver-btn"
                      style={styles.primaryBtn}
                      onPress={openDeliver}
                    >
                      <Ionicons name="paper-plane" size={14} color={colors.onPrimary} />
                      <Text style={styles.primaryBtnText}>
                        {(selected.delivered_email_at || selected.delivered_whatsapp_at) ? "Re-deliver" : "Deliver valuation"}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      testID="public-lead-repricing-btn"
                      style={styles.secondaryBtn}
                      onPress={() => {
                        Alert.alert(
                          "Edit price?",
                          "Updating the price will move this lead back to the Priced silo and clear any prior delivery timestamps so you can send a fresh valuation.",
                          [
                            { text: "Cancel", style: "cancel" },
                            {
                              text: "Edit price",
                              onPress: () => {
                                setPriceInput(String(selected.price || ""));
                                setPriceNotes(selected.price_notes || "");
                                // Flip status locally so the price form re-renders.
                                setSelected({ ...selected, status: "pending" });
                              },
                            },
                          ],
                        );
                      }}
                    >
                      <Ionicons name="create-outline" size={14} color={colors.text} />
                      <Text style={styles.secondaryBtnText}>Edit price</Text>
                    </TouchableOpacity>
                  </View>
                  {(selected.delivered_email_at || selected.delivered_whatsapp_at) ? (
                    <View style={styles.deliveredBox}>
                      <Text style={styles.deliveredHead}>Delivery log</Text>
                      {selected.delivered_whatsapp_at ? (
                        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginVertical: 3 }}>
                          <Text style={styles.deliveredLine}>
                            <Ionicons name="logo-whatsapp" size={11} color="#25D366" />{" "}
                            WhatsApp • {fmtDateTime(selected.delivered_whatsapp_at)}
                          </Text>
                          <TouchableOpacity
                            testID="reopen-whatsapp-btn"
                            onPress={() => {
                              // Direct synchronous open — this ALWAYS
                              // works because it's fired from the click
                              // event itself. Uses the last persisted
                              // WhatsApp body (already has the tokenised
                              // {{pdf_url}} substituted server-side).
                              const phone = (selected.seller.phone || "").replace(/[^\d]/g, "");
                              const msg = selected.last_whatsapp_message || "";
                              const url = `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
                              if (Platform.OS === "web") window.open(url, "_blank");
                              else Linking.openURL(url);
                            }}
                            style={{
                              backgroundColor: "#25D366",
                              paddingHorizontal: 10,
                              paddingVertical: 5,
                              borderRadius: 6,
                              flexDirection: "row",
                              alignItems: "center",
                              gap: 4,
                            }}
                          >
                            <Ionicons name="open-outline" size={11} color="#FFFFFF" />
                            <Text style={{ color: "#FFFFFF", fontSize: 11, fontWeight: "700" }}>Reopen</Text>
                          </TouchableOpacity>
                        </View>
                      ) : null}
                      {selected.delivered_email_at ? (
                        <Text style={styles.deliveredLine}>
                          <Ionicons name="mail" size={11} color={colors.text} />{" "}
                          Email • {fmtDateTime(selected.delivered_email_at)}
                        </Text>
                      ) : null}
                    </View>
                  ) : null}
                </View>
              )}
            </ScrollView>
          )}
        </View>
      </View>

      {/* Deliver modal */}
      <Modal visible={deliverOpen} transparent animationType="fade" onRequestClose={() => setDeliverOpen(false)}>
        <Pressable style={styles.modalScrim} onPress={() => setDeliverOpen(false)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Deliver valuation</Text>
              <TouchableOpacity onPress={() => setDeliverOpen(false)}>
                <Ionicons name="close" size={22} color={colors.text} />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
              <Text style={styles.modalSub}>
                {selected?.reference} • {selected?.vehicle.year} {selected?.vehicle.make} {selected?.vehicle.model}
              </Text>

              {/* Channels */}
              <SectionTitle title="Channels" colors={colors} />
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                <ChannelToggle
                  active={waOn}
                  onToggle={() => setWaOn((v) => !v)}
                  icon="logo-whatsapp"
                  label="WhatsApp"
                  hint={selected?.seller.phone}
                  colors={colors}
                />
                <ChannelToggle
                  active={emOn}
                  onToggle={() => setEmOn((v) => !v)}
                  icon="mail"
                  label="Email"
                  hint={selected?.seller.email}
                  colors={colors}
                />
              </View>

              {/* WhatsApp text */}
              {waOn ? (
                <>
                  <SectionTitle title="WhatsApp message" colors={colors} />
                  <Text style={styles.modalHint}>
                    The <Text style={styles.mono}>{"{{pdf_url}}"}</Text> placeholder is replaced with a
                    secure link to the valuation PDF (valid for 30 days).
                  </Text>
                  <TextInput
                    testID="deliver-wa-textarea"
                    style={styles.modalTextarea}
                    value={waMsg}
                    onChangeText={setWaMsg}
                    multiline
                    numberOfLines={12}
                    textAlignVertical="top"
                  />
                </>
              ) : null}

              {/* Email fields */}
              {emOn ? (
                <>
                  <SectionTitle title="Email" colors={colors} />
                  <Text style={styles.modalLabel}>Subject</Text>
                  <TextInput
                    testID="deliver-email-subject"
                    style={styles.modalInput}
                    value={emSubject}
                    onChangeText={setEmSubject}
                    maxLength={200}
                  />
                  <Text style={[styles.modalLabel, { marginTop: 12 }]}>Body</Text>
                  <TextInput
                    testID="deliver-email-body"
                    style={styles.modalTextarea}
                    value={emBody}
                    onChangeText={setEmBody}
                    multiline
                    numberOfLines={10}
                    textAlignVertical="top"
                  />
                  <Text style={styles.modalHint}>The valuation PDF is attached automatically to this email.</Text>
                </>
              ) : null}

              <View style={{ flexDirection: "row", gap: 8, marginTop: 20 }}>
                <TouchableOpacity
                  testID="deliver-cancel"
                  style={styles.secondaryBtn}
                  onPress={() => setDeliverOpen(false)}
                  disabled={delivering}
                >
                  <Text style={styles.secondaryBtnText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  testID="deliver-send"
                  style={[styles.primaryBtn, { flex: 1 }, delivering && { opacity: 0.6 }]}
                  onPress={handleDeliver}
                  disabled={delivering}
                >
                  {delivering ? <ActivityIndicator color={colors.onPrimary} /> : (
                    <>
                      <Ionicons name="send" size={14} color={colors.onPrimary} />
                      <Text style={styles.primaryBtnText}>Send now</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Photo zoom modal */}
      <Modal visible={!!photoZoom} transparent animationType="fade" onRequestClose={() => setPhotoZoom(null)}>
        <Pressable style={styles.photoZoomScrim} onPress={() => setPhotoZoom(null)}>
          {photoZoom ? <Image source={{ uri: photoZoom }} style={styles.photoZoomImg} resizeMode="contain" /> : null}
        </Pressable>
      </Modal>
    </View>
  );
}

// -----------------------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------------------
function StatusBadge({ sub, colors }: { sub: PublicSubmission; colors: Palette }) {
  let label = "Pending";
  let bg = colors.warning;
  if (sub.delivered_email_at || sub.delivered_whatsapp_at) {
    label = "Delivered";
    bg = colors.success;
  } else if (sub.status === "priced") {
    label = "Priced";
    bg = colors.primary;
  }
  return (
    <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: bg }}>
      <Text style={{ color: "#FFFFFF", fontSize: 10, letterSpacing: 1.2, fontWeight: "800" }}>
        {label.toUpperCase()}
      </Text>
    </View>
  );
}

function SectionTitle({ title, colors }: { title: string; colors: Palette }) {
  return (
    <Text
      style={{
        fontSize: 11,
        letterSpacing: 1.5,
        fontWeight: "700",
        color: colors.textSecondary,
        marginTop: 20,
        marginBottom: 10,
        textTransform: "uppercase",
      }}
    >
      {title}
    </Text>
  );
}

function KV({
  label,
  value,
  mono,
  wide,
  colors,
}: {
  label: string;
  value?: string | number | null;
  mono?: boolean;
  wide?: boolean;
  colors: Palette;
}) {
  return (
    <View style={[{ width: "50%", paddingRight: 12, marginBottom: 10 }, wide && { width: "100%" }]}>
      <Text style={{ color: colors.textSecondary, fontSize: 11, marginBottom: 2, letterSpacing: 0.5 }}>{label}</Text>
      <Text
        style={[
          { color: colors.text, fontSize: 14, fontWeight: "500" },
          mono && { fontFamily: fonts.number, fontVariant: ["tabular-nums"] as any },
        ]}
      >
        {value ?? "—"}
      </Text>
    </View>
  );
}

function KredoBox({
  label,
  value,
  colors,
  accent,
}: {
  label: string;
  value?: number | null;
  colors: Palette;
  accent?: string;
}) {
  const border = accent || colors.border;
  return (
    <View style={{
      flexBasis: "30%",
      flexGrow: 1,
      minWidth: 90,
      borderWidth: 1,
      borderColor: border,
      borderRadius: 8,
      padding: 10,
      backgroundColor: colors.paper,
    }}>
      <Text style={{
        color: colors.textSecondary,
        fontSize: 10,
        letterSpacing: 1,
        textTransform: "uppercase",
        fontWeight: "700",
      }}>{label}</Text>
      <Text style={{
        color: accent || colors.text,
        fontSize: 15,
        fontWeight: "800",
        marginTop: 4,
        fontFamily: fonts.number,
      }}>{value != null ? fmtZAR(value) : "—"}</Text>
    </View>
  );
}

function ChannelToggle({
  active,
  onToggle,
  icon,
  label,
  hint,
  colors,
}: {
  active: boolean;
  onToggle: () => void;
  icon: any;
  label: string;
  hint?: string;
  colors: Palette;
}) {
  return (
    <TouchableOpacity
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          padding: 12,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 10,
          minWidth: 240,
          flex: 1,
          gap: 10,
          backgroundColor: colors.card,
        },
        active && { borderColor: colors.primary, backgroundColor: colors.primary + "12" },
      ]}
      onPress={onToggle}
      activeOpacity={0.85}
    >
      <View
        style={[
          {
            width: 32,
            height: 32,
            borderRadius: 8,
            backgroundColor: colors.paper,
            alignItems: "center",
            justifyContent: "center",
          },
          active && { backgroundColor: colors.primary },
        ]}
      >
        <Ionicons name={icon} size={16} color={active ? colors.onPrimary : colors.text} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{label}</Text>
        {hint ? (
          <Text style={{ fontSize: 12, color: colors.textSecondary }} numberOfLines={1}>
            {hint}
          </Text>
        ) : null}
      </View>
      <View
        style={[
          {
            width: 20,
            height: 20,
            borderRadius: 6,
            borderWidth: 1.5,
            borderColor: colors.textSecondary,
            alignItems: "center",
            justifyContent: "center",
          },
          active && { backgroundColor: colors.primary, borderColor: colors.primary },
        ]}
      >
        {active ? <Ionicons name="checkmark" size={12} color={colors.onPrimary} /> : null}
      </View>
    </TouchableOpacity>
  );
}

// -----------------------------------------------------------------------------
// Themed styles
// -----------------------------------------------------------------------------
function makeStyles(colors: Palette) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.paper,
      flexWrap: "wrap",
      gap: 12,
    },
    headerLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
    headerTitle: { color: colors.text, fontSize: 16, fontWeight: "700", letterSpacing: 0.5 },
    chip: { backgroundColor: colors.primary, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
    chipText: { color: colors.onPrimary, fontSize: 11, fontWeight: "700", fontFamily: fonts.number },
    tabsRow: { flexDirection: "row", alignItems: "center", gap: 4 },
    tab: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
    },
    tabOn: { backgroundColor: colors.primary, borderColor: colors.primary },
    tabText: { color: colors.text, fontSize: 13, fontWeight: "500" },
    tabTextOn: { color: colors.onPrimary },
    refreshBtn: { padding: 6, marginLeft: 4 },

    body: { flex: 1, flexDirection: "row" },
    leftPane: {
      width: 380,
      borderRightWidth: 1,
      borderRightColor: colors.border,
      backgroundColor: colors.paper,
    },
    rightPane: { flex: 1, backgroundColor: colors.bg },

    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: spacing.xl,
    },
    dim: { color: colors.textSecondary, marginTop: 12 },
    dimSmall: { color: colors.textDisabled, marginTop: 4, fontSize: 12 },

    // Wrap for the row + its trailing action button. `position: relative`
    // so the action floats over the row's top-right corner regardless of
    // row content height.
    rowWrap: { position: "relative" },
    // Trash / restore button — a small floating chip pinned to the row's
    // top-right. Uses a neutral card background so it reads above the
    // row's own tint without dominating.
    rowAction: {
      position: "absolute",
      top: 8,
      right: 8,
      width: 30,
      height: 30,
      borderRadius: 15,
      backgroundColor: colors.paper,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: "center",
      justifyContent: "center",
      zIndex: 2,
      elevation: 2,
    },

    row: {
      padding: 12,
      // Reserve breathing room on the right so the floating action
      // chip never overlaps the reference number.
      paddingRight: 44,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      backgroundColor: colors.card,
      marginBottom: 8,
    },
    rowActive: { borderColor: colors.primary, borderWidth: 2, backgroundColor: colors.cardElev },
    rowHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
    rowRef: { color: colors.text, fontWeight: "800", fontSize: 13, fontFamily: fonts.number, letterSpacing: 0.5 },
    rowDate: { color: colors.textSecondary, fontSize: 11 },
    rowTitle: { color: colors.text, fontSize: 14, fontWeight: "600", marginBottom: 4 },
    rowMetaRow: { flexDirection: "row", gap: 6, alignItems: "center" },
    rowMeta: { color: colors.textSecondary, fontSize: 12 },
    rowPrice: {
      marginTop: 8,
      alignSelf: "flex-start",
      backgroundColor: colors.success + "22",
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
    },
    rowPriceText: { color: colors.success, fontWeight: "800", fontSize: 13, fontFamily: fonts.number },

    detailHeader: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      marginBottom: 8,
      gap: 12,
    },
    detailRef: { color: colors.textSecondary, fontSize: 12, fontFamily: fonts.number, letterSpacing: 1 },
    detailTitle: { color: colors.text, fontSize: 22, fontWeight: "700", letterSpacing: -0.3, marginTop: 4 },
    detailSub: { color: colors.textSecondary, fontSize: 13, marginTop: 4 },

    grid: { flexDirection: "row", flexWrap: "wrap" },

    photoRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      marginBottom: 8,
    },
    photo: {
      width: 120,
      height: 90,
      borderRadius: 8,
      backgroundColor: colors.paper,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
      borderWidth: 1,
      borderColor: colors.border,
    },
    photoTag: {
      position: "absolute",
      bottom: 4,
      left: 4,
      backgroundColor: "rgba(0,0,0,0.6)",
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
    },
    photoTagText: { color: "#FFFFFF", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 },

    priceCard: {
      marginTop: 20,
      padding: 16,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
    },
    priceHeader: {
      fontSize: 12,
      letterSpacing: 1.5,
      fontWeight: "700",
      color: colors.text,
      marginBottom: 12,
      textTransform: "uppercase",
    },
    priceRow: { flexDirection: "row", gap: 8, alignItems: "stretch" },
    rInput: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      backgroundColor: colors.inputBg,
    },
    rSymbol: {
      color: colors.textSecondary,
      fontSize: 15,
      fontWeight: "700",
      marginRight: 6,
    },
    priceInput: {
      flex: 1,
      color: colors.text,
      fontSize: 16,
      fontWeight: "700",
      fontFamily: fonts.number,
      paddingVertical: Platform.OS === "web" ? 10 : 12,
    },
    notesInput: {
      marginTop: 10,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      padding: 12,
      minHeight: 70,
      color: colors.text,
      backgroundColor: colors.inputBg,
    },

    deliverCard: {
      marginTop: 20,
      padding: 16,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
    },
    deliverPricedHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    deliverPricedLabel: {
      color: colors.textSecondary,
      fontSize: 11,
      letterSpacing: 1.5,
      fontWeight: "700",
      textTransform: "uppercase",
    },
    deliverPricedValue: { color: colors.success, fontSize: 24, fontWeight: "800", fontFamily: fonts.number },
    deliverNotes: { color: colors.textSecondary, fontSize: 13, marginTop: 6, fontStyle: "italic" },
    deliveredBox: {
      marginTop: 16,
      padding: 12,
      borderRadius: 8,
      backgroundColor: colors.paper,
      borderWidth: 1,
      borderColor: colors.border,
    },
    deliveredHead: {
      fontSize: 10,
      letterSpacing: 1.5,
      color: colors.textSecondary,
      textTransform: "uppercase",
      marginBottom: 6,
      fontWeight: "700",
    },
    deliveredLine: { color: colors.text, fontSize: 12, marginVertical: 2 },

    primaryBtn: {
      backgroundColor: colors.primary,
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderRadius: 10,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
    },
    primaryBtnText: { color: colors.onPrimary, fontWeight: "700", fontSize: 13 },
    secondaryBtn: {
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderRadius: 10,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: colors.card,
    },
    secondaryBtnText: { color: colors.text, fontWeight: "600", fontSize: 13 },

    // Modal
    modalScrim: {
      flex: 1,
      backgroundColor: colors.overlay,
      alignItems: "center",
      justifyContent: "center",
      padding: spacing.lg,
    },
    modalCard: {
      width: "100%",
      maxWidth: 640,
      maxHeight: "90%",
      backgroundColor: colors.bg,
      borderRadius: 16,
      overflow: "hidden",
    },
    modalHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      padding: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    modalTitle: { color: colors.text, fontSize: 18, fontWeight: "700" },
    modalSub: { color: colors.textSecondary, fontSize: 12, marginBottom: 4 },
    modalLabel: {
      fontSize: 11,
      letterSpacing: 1.5,
      fontWeight: "700",
      color: colors.textSecondary,
      textTransform: "uppercase",
      marginBottom: 6,
    },
    modalHint: { color: colors.textSecondary, fontSize: 12, marginBottom: 8, marginTop: 4 },
    modalInput: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      padding: 12,
      color: colors.text,
      backgroundColor: colors.inputBg,
    },
    modalTextarea: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      padding: 12,
      minHeight: 160,
      color: colors.text,
      backgroundColor: colors.inputBg,
      fontSize: 13,
      lineHeight: 19,
    },

    photoZoomScrim: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.92)",
      alignItems: "center",
      justifyContent: "center",
    },
    photoZoomImg: { width: "94%", height: "80%" },
  });
}
