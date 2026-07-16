import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Image,
  TextInput,
  useWindowDimensions,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius, fonts, BRAND } from "@/src/theme";
import { apiFetch } from "@/src/api";
import { buildWhatsappUrl, buildDealerMessage } from "@/src/utils/whatsapp";
import BillingScreen from "@/app/(app)/billing";

type Submission = {
  id: string;
  reference?: string;
  dealer_name?: string;
  company_name?: string;
  make_name: string;
  model_name: string;
  derivative_name: string;
  year: number;
  mileage: number;
  colour: string;
  condition: number;
  status: "pending" | "priced";
  bucket?: "incoming" | "priced" | "archived";
  price: number | null;
  priced_at?: string | null;
  created_at: string;
  factory_warranty?: boolean;
  accident_damage?: boolean;
};

type SubmissionFull = Submission & {
  photos?: Record<string, string>;
  dealer_email?: string;
  dealer_phone?: string;
  dealer_first_name?: string;
  license_disk_data?: string;
  price_notes?: string | null;
  market_analysis?: {
    analysis: {
      estimated_market_range_zar?: { low: number; high: number; typical: number };
      trade_price_estimate_zar?: number;
      retail_price_estimate_zar?: number;
      listings_summary?: string;
      key_factors?: string[];
      confidence?: string;
      disclaimer?: string;
    };
    generated_at: string;
  } | null;
};

type Bucket = "incoming" | "priced" | "archived";
type CockpitView = "submissions" | "billing";

export default function WebAdminDashboard({ onLogout }: { onLogout: () => void }) {
  const { width } = useWindowDimensions();
  const [view, setView] = useState<CockpitView>("submissions");
  const [subs, setSubs] = useState<Submission[]>([]);
  const [counts, setCounts] = useState<Record<Bucket, number>>({ incoming: 0, priced: 0, archived: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<SubmissionFull | null>(null);
  const [loading, setLoading] = useState(true);
  const [bucket, setBucket] = useState<Bucket>("incoming");
  const [search, setSearch] = useState("");
  const [priceInput, setPriceInput] = useState("");
  const [notesInput, setNotesInput] = useState("");
  const [priceSubmitting, setPriceSubmitting] = useState(false);
  const [analysing, setAnalysing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadList = useCallback(async () => {
    try {
      const data = await apiFetch("/api/admin/submissions");
      const items: Submission[] = data.submissions || [];
      setSubs(items);
      if (data.counts) {
        setCounts(data.counts);
      } else {
        const c: Record<Bucket, number> = { incoming: 0, priced: 0, archived: 0 };
        items.forEach((s) => {
          const b = (s.bucket || (s.status === "priced" ? "priced" : "incoming")) as Bucket;
          c[b] = (c[b] || 0) + 1;
        });
        setCounts(c);
      }
    } catch (e) {
      console.log(e);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSelected = useCallback(async () => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    try {
      const data = await apiFetch(`/api/submissions/${selectedId}`);
      setSelected(data.submission);
      setPriceInput(data.submission.price ? String(data.submission.price) : "");
      setNotesInput(data.submission.price_notes || "");
    } catch (e) {
      console.log(e);
    }
  }, [selectedId]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    loadSelected();
  }, [loadSelected]);

  const filtered = subs.filter((s) => {
    const b = (s.bucket || (s.status === "priced" ? "priced" : "incoming")) as Bucket;
    if (b !== bucket) return false;
    if (search) {
      const q = search.toLowerCase();
      const hay = `${s.reference ?? ""} ${s.make_name} ${s.model_name} ${s.derivative_name} ${
        s.dealer_name ?? ""
      } ${s.company_name ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const handlePrice = async () => {
    if (!selected) return;
    const price = parseFloat(priceInput.replace(/[^0-9.]/g, ""));
    if (isNaN(price) || price <= 0) {
      alert("Enter a valid price");
      return;
    }
    setPriceSubmitting(true);
    try {
      await apiFetch(`/api/admin/submissions/${selected.id}/price`, {
        method: "POST",
        body: JSON.stringify({ price, notes: notesInput.trim() || null }),
      });
      await loadList();
      await loadSelected();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setPriceSubmitting(false);
    }
  };

  const handleAnalyse = async () => {
    if (!selected) return;
    setAnalysing(true);
    try {
      const data = await apiFetch(`/api/submissions/${selected.id}/market-analysis`, {
        method: "POST",
      });
      setSelected({ ...selected, market_analysis: data });
    } catch (e: any) {
      alert(e.message);
    } finally {
      setAnalysing(false);
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    if (!confirm(`Delete ${selected.reference ?? "this vehicle"}? Cannot be undone.`)) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/admin/submissions/${selected.id}`, { method: "DELETE" });
      setSelectedId(null);
      setSelected(null);
      await loadList();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setDeleting(false);
    }
  };

  const exportCsv = () => {
    const rows = [
      [
        "Reference",
        "Status",
        "Price",
        "Year",
        "Make",
        "Model",
        "Derivative",
        "Mileage",
        "Colour",
        "Condition",
        "Dealer",
        "Company",
        "Submitted",
      ],
      ...filtered.map((s) => [
        s.reference ?? "",
        s.status,
        s.price ?? "",
        s.year,
        s.make_name,
        s.model_name,
        s.derivative_name,
        s.mileage,
        s.colour,
        s.condition,
        s.dealer_name ?? "",
        s.company_name ?? "",
        s.created_at,
      ]),
    ];
    const csv = rows
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    // @ts-ignore - web-only
    const blob = new Blob([csv], { type: "text/csv" });
    // @ts-ignore
    const url = URL.createObjectURL(blob);
    // @ts-ignore
    const a = document.createElement("a");
    a.href = url;
    a.download = `fourbuy-submissions-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    // @ts-ignore
    URL.revokeObjectURL(url);
  };

  const pendingCount = counts.incoming;
  const pricedCount = counts.priced;
  const archivedCount = counts.archived;

  return (
    <View style={styles.root}>
      {/* Top bar */}
      <View style={styles.topbar}>
        <View style={styles.topbarLeft}>
          <Image
            source={{ uri: BRAND.logoUrl }}
            style={styles.logo}
            resizeMode="contain"
          />
          <View style={styles.divider} />
          <Text style={styles.topbarSub}>ADMIN COCKPIT</Text>
          <View style={{ width: 12 }} />
          <View style={styles.viewSwitch}>
            <TouchableOpacity
              testID="cockpit-view-submissions"
              style={[styles.viewBtn, view === "submissions" && styles.viewBtnActive]}
              onPress={() => setView("submissions")}
            >
              <Ionicons name="list" size={14} color={view === "submissions" ? "#000" : colors.text} />
              <Text style={[styles.viewBtnText, view === "submissions" && styles.viewBtnTextActive]}>
                Submissions
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="cockpit-view-billing"
              style={[styles.viewBtn, view === "billing" && styles.viewBtnActive]}
              onPress={() => setView("billing")}
            >
              <Ionicons name="cash" size={14} color={view === "billing" ? "#000" : colors.text} />
              <Text style={[styles.viewBtnText, view === "billing" && styles.viewBtnTextActive]}>
                Billing
              </Text>
            </TouchableOpacity>
          </View>
        </View>
        <View style={styles.topbarRight}>
          <View style={styles.statPill}>
            <Text style={styles.statPillLabel}>INCOMING</Text>
            <Text style={[styles.statPillValue, { color: colors.warning }]}>{pendingCount}</Text>
          </View>
          <View style={styles.statPill}>
            <Text style={styles.statPillLabel}>PRICED</Text>
            <Text style={[styles.statPillValue, { color: colors.success }]}>{pricedCount}</Text>
          </View>
          <View style={styles.statPill}>
            <Text style={styles.statPillLabel}>ARCHIVED</Text>
            <Text style={[styles.statPillValue, { color: colors.textSecondary }]}>{archivedCount}</Text>
          </View>
          <TouchableOpacity testID="admin-export-csv" style={styles.iconBtn} onPress={exportCsv}>
            <Ionicons name="download-outline" size={18} color={colors.text} />
            <Text style={styles.iconBtnText}>Export CSV</Text>
          </TouchableOpacity>
          <TouchableOpacity testID="admin-logout" style={styles.iconBtn} onPress={onLogout}>
            <Ionicons name="log-out-outline" size={18} color={colors.danger} />
          </TouchableOpacity>
        </View>
      </View>

      {view === "billing" ? (
        <View style={{ flex: 1 }}>
          <BillingScreen />
        </View>
      ) : (
      <View style={styles.body}>
        {/* Left: list */}
        <View style={[styles.leftPane, { width: Math.max(360, Math.min(480, width * 0.32)) }]}>
          <View style={styles.filterRow}>
            <View style={styles.searchBox}>
              <Ionicons name="search" size={14} color={colors.textSecondary} />
              <TextInput
                testID="admin-search-input"
                style={styles.searchInput}
                value={search}
                onChangeText={setSearch}
                placeholder="Search ref / make / dealer..."
                placeholderTextColor={colors.textDisabled}
              />
            </View>
          </View>
          <View style={styles.chipsRow}>
            {(["incoming", "priced", "archived"] as Bucket[]).map((b) => {
              const active = bucket === b;
              const label = b === "incoming" ? "Incoming" : b === "priced" ? "Priced" : "Archived";
              const n = counts[b] || 0;
              return (
                <TouchableOpacity
                  key={b}
                  testID={`admin-filter-${b}`}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => setBucket(b)}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {label.toUpperCase()}
                  </Text>
                  <View style={[styles.chipBadge, active && styles.chipBadgeActive]}>
                    <Text style={[styles.chipBadgeText, active && styles.chipBadgeTextActive]}>
                      {n}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          {loading ? (
            <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
          ) : filtered.length === 0 ? (
            <Text style={styles.emptyList}>
              {bucket === "archived"
                ? "Archive is empty — vehicles priced over 14 days ago will land here"
                : bucket === "priced"
                ? "Nothing priced in the last 14 days"
                : "No incoming submissions"}
            </Text>
          ) : (
            <ScrollView>
              {filtered.map((s) => {
                const active = s.id === selectedId;
                return (
                  <TouchableOpacity
                    key={s.id}
                    testID={`admin-row-${s.id}`}
                    style={[styles.row, active && styles.rowActive]}
                    onPress={() => setSelectedId(s.id)}
                  >
                    <View style={styles.rowHeader}>
                      <Text style={styles.rowRef}>{s.reference ?? "—"}</Text>
                      <View
                        style={[
                          styles.rowBadge,
                          {
                            backgroundColor:
                              s.status === "priced" ? colors.success + "22" : colors.warning + "22",
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.rowBadgeText,
                            { color: s.status === "priced" ? colors.success : colors.warning },
                          ]}
                        >
                          {s.status.toUpperCase()}
                        </Text>
                      </View>
                    </View>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {s.year} {s.make_name} {s.model_name}
                    </Text>
                    <Text style={styles.rowSub} numberOfLines={1}>
                      {s.derivative_name} · {s.mileage.toLocaleString()} km · {s.colour}
                    </Text>
                    <Text style={styles.rowDealer} numberOfLines={1}>
                      {s.dealer_name} — {s.company_name}
                    </Text>
                    {s.price !== null && s.price !== undefined ? (
                      <Text style={styles.rowPrice}>R {s.price.toLocaleString()}</Text>
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
        </View>

        {/* Right: detail */}
        <View style={styles.rightPane}>
          {!selected ? (
            <View style={styles.detailEmpty}>
              <Ionicons name="car-outline" size={64} color={colors.textDisabled} />
              <Text style={styles.detailEmptyText}>Select a submission on the left</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.detailScroll}>
              <View style={styles.detailHeader}>
                <View>
                  <Text style={styles.detailRef}>{selected.reference ?? "—"}</Text>
                  <Text style={styles.detailTitle}>
                    {selected.year} {selected.make_name} {selected.model_name}
                  </Text>
                  <Text style={styles.detailSub}>{selected.derivative_name}</Text>
                </View>
                <TouchableOpacity
                  testID="admin-delete-button"
                  style={styles.deleteBtn}
                  onPress={handleDelete}
                  disabled={deleting}
                >
                  {deleting ? (
                    <ActivityIndicator size="small" color={colors.danger} />
                  ) : (
                    <>
                      <Ionicons name="trash-outline" size={16} color={colors.danger} />
                      <Text style={styles.deleteBtnText}>Delete</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>

              {/* Specs */}
              <View style={styles.specsGrid}>
                <SpecCell label="Mileage" value={`${selected.mileage.toLocaleString()} km`} />
                <SpecCell label="Colour" value={selected.colour} />
                <SpecCell label="Condition" value={`${selected.condition}/10`} />
                <SpecCell
                  label="Warranty"
                  value={selected.factory_warranty ? "Yes" : "No"}
                  color={selected.factory_warranty ? colors.success : colors.textSecondary}
                />
                <SpecCell
                  label="Accident"
                  value={selected.accident_damage ? "Yes" : "None"}
                  color={selected.accident_damage ? colors.danger : colors.success}
                />
                <SpecCell label="Year" value={String(selected.year)} />
              </View>

              {/* Photos */}
              {selected.photos ? (
                <View style={styles.photoRow}>
                  {["front", "side_right", "rear", "side_left", "interior"].map((slot) =>
                    selected.photos?.[slot] ? (
                      <Image
                        key={slot}
                        source={{ uri: selected.photos[slot] }}
                        style={styles.photo}
                        resizeMode="cover"
                      />
                    ) : (
                      <View key={slot} style={[styles.photo, styles.photoPlaceholder]}>
                        <Ionicons name="image-outline" size={20} color={colors.textDisabled} />
                      </View>
                    )
                  )}
                </View>
              ) : null}

              {/* Dealer */}
              <View style={styles.dealerBox}>
                <Text style={styles.boxTitle}>SUBMITTED BY</Text>
                <View style={styles.dealerRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.dealerName}>{selected.dealer_name}</Text>
                    <Text style={styles.dealerMeta}>{selected.company_name}</Text>
                    <Text style={styles.dealerMeta}>{selected.dealer_email}</Text>
                    {selected.dealer_phone ? (
                      <Text style={styles.dealerMeta}>{selected.dealer_phone}</Text>
                    ) : null}
                  </View>
                  {selected.dealer_phone ? (
                    <TouchableOpacity
                      testID="admin-whatsapp-button"
                      style={styles.whatsappBtn}
                      onPress={() => {
                        const url = buildWhatsappUrl(
                          selected.dealer_phone!,
                          buildDealerMessage({
                            dealerFirstName: selected.dealer_first_name,
                            reference: selected.reference,
                            year: selected.year,
                            make: selected.make_name,
                            model: selected.model_name,
                            derivative: selected.derivative_name,
                            price: selected.price,
                            priceNotes: selected.price_notes,
                          })
                        );
                        // @ts-ignore web-only
                        window.open(url, "_blank");
                      }}
                    >
                      <Ionicons name="logo-whatsapp" size={18} color="#25D366" />
                      <Text style={styles.whatsappBtnText}>WhatsApp</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              </View>

              {/* Pricing */}
              <View style={styles.priceBox}>
                <View style={styles.priceBoxHeader}>
                  <Text style={styles.boxTitle}>PRICE OFFER</Text>
                  {selected.status === "priced" && selected.price !== null ? (
                    <Text style={styles.priceBadge}>R {selected.price?.toLocaleString()}</Text>
                  ) : null}
                </View>
                <View style={styles.priceInputRow}>
                  <View style={styles.priceInputWrap}>
                    <Text style={styles.currencyLabel}>R</Text>
                    <TextInput
                      testID="admin-price-input"
                      style={styles.priceInput}
                      value={priceInput}
                      onChangeText={setPriceInput}
                      placeholder="Enter price"
                      placeholderTextColor={colors.textDisabled}
                      keyboardType="numeric"
                    />
                  </View>
                  <TouchableOpacity
                    testID="admin-send-offer-button"
                    style={[styles.sendBtn, priceSubmitting && { opacity: 0.6 }]}
                    onPress={handlePrice}
                    disabled={priceSubmitting}
                  >
                    {priceSubmitting ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Text style={styles.sendBtnText}>SEND OFFER</Text>
                    )}
                  </TouchableOpacity>
                </View>
                <TextInput
                  testID="admin-notes-input"
                  style={styles.notesInput}
                  value={notesInput}
                  onChangeText={setNotesInput}
                  placeholder="Notes for dealer (optional)"
                  placeholderTextColor={colors.textDisabled}
                  multiline
                />
              </View>

              {/* Market analysis */}
              <View style={styles.analysisBox}>
                <View style={styles.priceBoxHeader}>
                  <Text style={styles.boxTitle}>AI MARKET ANALYSIS</Text>
                  <TouchableOpacity
                    testID="admin-analyse-button"
                    style={[styles.analyseBtn, analysing && { opacity: 0.6 }]}
                    onPress={handleAnalyse}
                    disabled={analysing}
                  >
                    {analysing ? (
                      <ActivityIndicator size="small" color={colors.primary} />
                    ) : (
                      <>
                        <Ionicons name="sparkles" size={13} color={colors.primary} />
                        <Text style={styles.analyseBtnText}>
                          {selected.market_analysis ? "REFRESH" : "ANALYSE"}
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>

                {selected.market_analysis?.analysis ? (
                  <>
                    {selected.market_analysis.analysis.estimated_market_range_zar ? (
                      <View style={styles.rangeBox}>
                        {(["low", "typical", "high"] as const).map((k, i) => (
                          <View
                            key={k}
                            style={[
                              styles.rangeCell,
                              i === 1 && { backgroundColor: colors.accent + "18" },
                            ]}
                          >
                            <Text style={styles.rangeLabel}>{k.toUpperCase()}</Text>
                            <Text
                              style={[
                                styles.rangeValue,
                                i === 1 && { color: colors.accent },
                              ]}
                            >
                              R{" "}
                              {selected.market_analysis!.analysis.estimated_market_range_zar![
                                k
                              ].toLocaleString()}
                            </Text>
                          </View>
                        ))}
                      </View>
                    ) : null}
                    <View style={styles.tradeSplit}>
                      {selected.market_analysis.analysis.trade_price_estimate_zar ? (
                        <View style={styles.tradeCell}>
                          <Text style={styles.rangeLabel}>TRADE</Text>
                          <Text style={[styles.rangeValue, { color: colors.success }]}>
                            R{" "}
                            {selected.market_analysis.analysis.trade_price_estimate_zar.toLocaleString()}
                          </Text>
                        </View>
                      ) : null}
                      {selected.market_analysis.analysis.retail_price_estimate_zar ? (
                        <View style={styles.tradeCell}>
                          <Text style={styles.rangeLabel}>RETAIL</Text>
                          <Text style={[styles.rangeValue, { color: colors.success }]}>
                            R{" "}
                            {selected.market_analysis.analysis.retail_price_estimate_zar.toLocaleString()}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    {selected.market_analysis.analysis.listings_summary ? (
                      <Text style={styles.summary}>
                        {selected.market_analysis.analysis.listings_summary}
                      </Text>
                    ) : null}
                    {selected.market_analysis.analysis.key_factors?.length ? (
                      <View style={{ marginTop: spacing.sm, gap: 4 }}>
                        <Text style={styles.factorTitle}>KEY FACTORS</Text>
                        {selected.market_analysis.analysis.key_factors.map((f, i) => (
                          <View key={i} style={styles.factorRow}>
                            <Ionicons name="checkmark-circle" size={13} color={colors.primary} />
                            <Text style={styles.factorText}>{f}</Text>
                          </View>
                        ))}
                      </View>
                    ) : null}
                    {selected.market_analysis.analysis.disclaimer ? (
                      <Text style={styles.disclaimer}>
                        {selected.market_analysis.analysis.disclaimer}
                      </Text>
                    ) : null}
                  </>
                ) : (
                  <Text style={styles.analysisEmpty}>
                    Click ANALYSE for a GPT-5.2 market overview comparing typical listings on
                    autotrader.co.za and cars.co.za.
                  </Text>
                )}
              </View>
            </ScrollView>
          )}
        </View>
      </View>
      )}
    </View>
  );
}

function SpecCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.specCell}>
      <Text style={styles.specLabel}>{label.toUpperCase()}</Text>
      <Text style={[styles.specValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  topbar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.paper,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  topbarLeft: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  topbarRight: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  logo: { width: 140, height: 44 },
  divider: { width: 1, height: 30, backgroundColor: colors.border },
  topbarSub: {
    color: colors.textSecondary,
    fontFamily: fonts.serif,
    letterSpacing: 3,
    fontSize: 13,
    textTransform: "uppercase",
  },
  viewSwitch: {
    flexDirection: "row",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.card,
    overflow: "hidden",
  },
  viewBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  viewBtnActive: { backgroundColor: colors.primary },
  viewBtnText: { color: colors.text, fontSize: 12, fontWeight: "700", letterSpacing: 0.5 },
  viewBtnTextActive: { color: "#000", fontWeight: "800" },
  statPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    alignItems: "center",
    minWidth: 90,
  },
  statPillLabel: { color: colors.textSecondary, fontSize: 10, letterSpacing: 1, fontWeight: "700" },
  statPillValue: { fontSize: 18, fontWeight: "800", fontFamily: fonts.mono },
  iconBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.card,
  },
  iconBtnText: { color: colors.text, fontSize: 12, fontWeight: "700", letterSpacing: 0.5 },
  body: { flex: 1, flexDirection: "row" },
  leftPane: {
    borderRightWidth: 1,
    borderRightColor: colors.border,
    backgroundColor: colors.paper,
  },
  filterRow: { padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  searchInput: { flex: 1, color: colors.text, fontSize: 14, outlineStyle: "none" as any },
  chipsRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.card,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.textSecondary, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  chipTextActive: { color: "#000", fontWeight: "800" },
  chipBadge: {
    minWidth: 22,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.pill,
    backgroundColor: colors.border,
    alignItems: "center",
  },
  chipBadgeActive: { backgroundColor: "#000" },
  chipBadgeText: { color: colors.text, fontSize: 10, fontWeight: "800" },
  chipBadgeTextActive: { color: colors.neon },
  emptyList: { color: colors.textSecondary, textAlign: "center", marginTop: 40 },
  row: {
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.paper,
  },
  rowActive: { backgroundColor: colors.card, borderLeftWidth: 3, borderLeftColor: colors.neon },
  rowHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rowRef: { color: colors.neon, fontSize: 11, fontWeight: "800", fontFamily: fonts.mono, letterSpacing: 1 },
  rowBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.sm },
  rowBadgeText: { fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  rowTitle: { color: colors.text, fontSize: 14, fontWeight: "700", marginTop: 6 },
  rowSub: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  rowDealer: { color: colors.textDisabled, fontSize: 11, marginTop: 4 },
  rowPrice: {
    color: colors.success,
    fontSize: 14,
    fontWeight: "800",
    fontFamily: fonts.mono,
    marginTop: 6,
  },

  rightPane: { flex: 1, backgroundColor: colors.bg },
  detailEmpty: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm },
  detailEmptyText: { color: colors.textSecondary, fontSize: 15 },
  detailScroll: { padding: spacing.xl, maxWidth: 900, gap: spacing.md, alignSelf: "center", width: "100%" },
  detailHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: spacing.md,
  },
  detailRef: { color: colors.neon, fontFamily: fonts.mono, fontSize: 13, fontWeight: "800", letterSpacing: 1.5 },
  detailTitle: { color: colors.text, fontSize: 28, fontWeight: "700", fontFamily: fonts.serif, marginTop: 4 },
  detailSub: { color: colors.textSecondary, fontSize: 14, marginTop: 2 },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.danger + "66",
    borderRadius: radius.sm,
    backgroundColor: colors.danger + "11",
  },
  deleteBtnText: { color: colors.danger, fontWeight: "700", fontSize: 12, letterSpacing: 0.5 },

  specsGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  specCell: {
    flex: 1,
    minWidth: 130,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.card,
  },
  specLabel: { color: colors.textSecondary, fontSize: 10, letterSpacing: 1, fontWeight: "700", marginBottom: 4 },
  specValue: { color: colors.text, fontSize: 15, fontWeight: "700" },

  photoRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  photo: {
    flex: 1,
    aspectRatio: 4 / 3,
    borderRadius: radius.sm,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  photoPlaceholder: { alignItems: "center", justifyContent: "center" },

  dealerBox: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
  },
  boxTitle: { color: colors.textSecondary, fontSize: 11, fontWeight: "800", letterSpacing: 1.5 },
  dealerName: { color: colors.text, fontSize: 15, fontWeight: "700", marginTop: 6 },
  dealerMeta: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  dealerRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  whatsappBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: "#25D366",
    backgroundColor: "#25D36618",
  },
  whatsappBtnText: { color: "#25D366", fontWeight: "800", fontSize: 13, letterSpacing: 0.5 },

  priceBox: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
  },
  priceBoxHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.sm },
  priceBadge: { color: colors.success, fontFamily: fonts.mono, fontSize: 16, fontWeight: "800" },
  priceInputRow: { flexDirection: "row", gap: spacing.sm },
  priceInputWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
  },
  currencyLabel: { color: colors.textSecondary, fontSize: 18, fontFamily: fonts.mono, marginRight: 6 },
  priceInput: {
    flex: 1,
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
    fontFamily: fonts.mono,
    paddingVertical: 12,
    outlineStyle: "none" as any,
  },
  sendBtn: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: radius.sm,
    minWidth: 140,
  },
  sendBtnText: { color: "#000", fontWeight: "800", fontSize: 13, letterSpacing: 1.5 },
  notesInput: {
    marginTop: spacing.sm,
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
    color: colors.text,
    fontSize: 14,
    minHeight: 60,
    outlineStyle: "none" as any,
  },

  analysisBox: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
  },
  analyseBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.sm,
    backgroundColor: colors.primary + "18",
    minWidth: 100,
    justifyContent: "center",
  },
  analyseBtnText: { color: colors.primary, fontWeight: "800", fontSize: 11, letterSpacing: 1 },
  rangeBox: {
    flexDirection: "row",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    overflow: "hidden",
    marginTop: spacing.sm,
  },
  rangeCell: { flex: 1, padding: spacing.md, alignItems: "center", borderRightWidth: 1, borderRightColor: colors.border },
  rangeLabel: { color: colors.textSecondary, fontSize: 10, letterSpacing: 1, fontWeight: "700", marginBottom: 4 },
  rangeValue: { color: colors.text, fontSize: 14, fontWeight: "800", fontFamily: fonts.mono },
  tradeSplit: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
  tradeCell: {
    flex: 1,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.paper,
    alignItems: "center",
  },
  summary: { color: colors.text, fontSize: 13, lineHeight: 20, marginTop: spacing.md },
  factorTitle: { color: colors.textSecondary, fontSize: 10, letterSpacing: 1, fontWeight: "700" },
  factorRow: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  factorText: { color: colors.text, fontSize: 12, flex: 1, lineHeight: 18 },
  disclaimer: { color: colors.textDisabled, fontSize: 11, fontStyle: "italic", marginTop: spacing.sm },
  analysisEmpty: { color: colors.textSecondary, fontSize: 13, marginTop: spacing.sm, lineHeight: 19 },
});
