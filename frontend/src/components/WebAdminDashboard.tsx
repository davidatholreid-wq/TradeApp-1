import { useCallback, useEffect, useMemo, useState } from "react";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { View, Text, StyleSheet, ActivityIndicator, ScrollView, Image, TextInput, useWindowDimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { spacing, radius, fonts, BRAND } from "@/src/theme";
import { useThemeColors, useThemeMode, type Palette } from "@/src/theme/ThemeContext";
import { decodeLicenseDisk } from "@/src/utils/licenseDisk";
import { apiFetch } from "@/src/api";
import { buildWhatsappUrl, buildDealerMessage } from "@/src/utils/whatsapp";
import BillingScreen from "@/app/(app)/billing";
import DealersScreen from "@/app/(app)/dealers";
import KredoTestScreen from "@/app/(app)/kredo-test";
import AdminRewardsScreen from "@/src/components/AdminRewardsScreen";
import PhotoCarousel, { CarouselPhoto } from "@/src/components/PhotoCarousel";
import ConditionRatingInfoModal from "@/src/components/ConditionRatingInfoModal";
import { computeServiceGap, formatMonthsAgo, formatKm } from "@/src/utils/format";

type ReconItem = {
  label: string;
  category?: string | null;
  amount_zar: number;
  photo?: string | null;
  photos?: string[];
};

type Submission = {
  id: string;
  reference?: string;
  dealer_name?: string;
  submitted_by_name?: string | null;
  submitted_by_job_title?: string | null;
  submitted_at?: string | null;
  dealership_id?: string | null;
  company_name?: string;
  make_name: string;
  model_name: string;
  derivative_name: string;
  year: number;
  mileage: number;
  colour: string;
  condition: number;
  status: "pending" | "priced" | "declined";
  bucket?: "incoming" | "priced" | "archived";
  price: number | null;
  priced_at?: string | null;
  created_at: string;
  factory_warranty?: boolean;
  accident_damage?: boolean;
  front_photo?: string | null;
  unseen?: boolean;
};

type SubmissionFull = Submission & {
  photos?: Record<string, string>;
  dealer_email?: string;
  dealer_phone?: string;
  dealer_first_name?: string;
  license_disk_data?: string;
  price_notes?: string | null;
  fuel_type?: string;
  year_of_production?: number;
  transmission?: string;
  year_registered?: number;
  // Legacy fields
  exterior_condition?: number;
  tyre_condition?: number;
  // Four condition pillars
  mechanical_condition?: number;
  cosmetic_condition?: number;
  interior_condition?: number;
  history_condition?: number;
  windscreen_condition?: string;
  service_history?: string;
  last_service_date?: string;
  last_service_mileage?: number | null;
  paint_evidence?: boolean;
  paint_quality?: string | null;
  accident_damage_types?: string[];
  reconditioning_items?: ReconItem[];
  reconditioning_total_zar?: number;
  vin?: string;
  engine_number?: string;
  rim_size?: number | null;
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
  tyre_estimate?: {
    estimate: {
      tyre_spec?: string;
      per_tyre_range_zar?: { low: number; high: number; typical: number };
      set_of_four_zar?: { low: number; high: number; typical: number };
      fitment_and_balance_zar?: number;
      total_replacement_estimate_zar?: number;
      recommended_brands?: string[];
      notes?: string;
      confidence?: string;
      disclaimer?: string;
      raw?: string;
    };
    generated_at: string;
  } | null;

  // Kredo cached vehicle-values snapshot (locked at valuation).
  market_values?: {
    status?: "ok" | "loading" | "error";
    new_list_price_zar?: number | null;
    retail_price_zar?: number | null;
    trade_price_zar?: number | null;
    mm_code?: string | null;
    fetched_at?: string | null;
    error?: string | null;
  } | null;

  // Bimmervin cached factory-order snapshot (BMW/MINI/Rolls/ALPINA only).
  bimmer_spec?: {
    status?: "ok" | "error";
    vin?: string;
    series?: string | null;
    type_key?: string | null;
    colour_code?: string | null;
    fabric_code?: string | null;
    build_date?: string | null;
    options?: { code: string; kind: string; description?: string | null }[];
    captured_at?: string | null;
    error?: string | null;
  } | null;

  // Ordered VIN-linked reports (Lightstone / CarVertical / CarTrust).
  report_orders?: {
    id: string;
    type: string;
    name?: string;
    status?: string;
    ordered_at?: string;
    completed_at?: string | null;
    cost_zar?: number | null;
    pdf_url?: string | null;
  }[];

  // Cached Kredo VIN history (accident / claim history).
  kredo_vin_history?: {
    status?: "ok" | "error" | "loading";
    fetched_at?: string | null;
    data?: any;
    error?: string | null;
  } | null;

  // Full offer history — every price change with timestamp + notes.
  // Field names match the backend `price_history[]` schema.
  price_history?: {
    id?: string;
    action?: "offer" | "update";
    previous_price?: number | null;
    new_price: number;
    previous_notes?: string | null;
    new_notes?: string | null;
    comment?: string | null;
    admin_id?: string | null;
    admin_name?: string | null;
    at?: string;
  }[];
};

const PHOTO_ORDER: { key: string; fallback?: string; label: string }[] = [
  { key: "front", label: "Front" },
  { key: "driver_side", fallback: "side_right", label: "Driver's Side" },
  { key: "passenger_side", fallback: "side_left", label: "Passenger Side" },
  { key: "rear", label: "Rear" },
  { key: "interior", label: "Interior" },
];

function resolvePhoto(photos: Record<string, string> | undefined, key: string, fallback?: string) {
  if (!photos) return "";
  return photos[key] || (fallback ? photos[fallback] : "") || "";
}

/** Format a ZAR amount for the market-value + report cost tiles. */
function fmtZar(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v) || v === 0) return "—";
  return `R ${Number(v).toLocaleString("en-ZA", { maximumFractionDigits: 0 })}`;
}

/** Turn a report_orders type slug into a human title matching the mobile UI. */
function formatReportName(type: string): string {
  const map: Record<string, string> = {
    lightstone: "Lightstone Report",
    carvertical: "CarVertical Report",
    kredo_cartrust: "CarTrust Report",
  };
  return map[type] || type.replace(/_/g, " ");
}

type Bucket = "incoming" | "priced" | "archived";
type CockpitView = "submissions" | "dealers" | "billing" | "rewards" | "kredo";

export default function WebAdminDashboard({ onLogout }: { onLogout: () => void }) {
  const colors = useThemeColors();
  const themeMode = useThemeMode();
  const styles = useMemo(() => makeStyles(colors), [colors]);
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
  const [estimatingTyres, setEstimatingTyres] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [carouselIdx, setCarouselIdx] = useState<number | null>(null);
  const [conditionInfoOpen, setConditionInfoOpen] = useState(false);

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
          const b = (s.bucket || (s.status === "priced" || s.status === "declined" ? "priced" : "incoming")) as Bucket;
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

  const carouselPhotos: CarouselPhoto[] = useMemo(() => {
    if (!selected) return [];
    const main = PHOTO_ORDER.map((p) => ({
      uri: resolvePhoto(selected.photos, p.key, p.fallback),
      label: p.label,
    })).filter((p) => !!p.uri);
    const reconPhotos: CarouselPhoto[] = (selected.reconditioning_items || []).flatMap((r: any) => {
      const label = r?.category || r?.label || "Recon";
      const list: string[] = Array.isArray(r?.photos) && r.photos.length > 0
        ? r.photos.filter((x: any) => typeof x === "string" && x)
        : r?.photo
          ? [r.photo]
          : [];
      return list.map((uri) => ({ uri, label: `Recon · ${label}` }));
    });
    return [...main, ...reconPhotos];
  }, [selected]);

  const averageRating = useMemo(() => {
    if (!selected) return null;
    // Weighted overall condition: Mechanical 30% · Cosmetic 25% · Interior 25% · General 20%.
    const m = selected.mechanical_condition;
    const c = selected.cosmetic_condition;
    const i = selected.interior_condition;
    const h = selected.history_condition;
    if ([m, c, i, h].every((x) => typeof x === "number" && x > 0)) {
      return (m as number) * 0.3 + (c as number) * 0.25 + (i as number) * 0.25 + (h as number) * 0.2;
    }
    const partial: [number, number][] = [
      [m as number, 0.3],
      [c as number, 0.25],
      [i as number, 0.25],
      [h as number, 0.2],
    ].filter(([v]) => typeof v === "number" && v > 0) as [number, number][];
    if (partial.length > 0) {
      const totalW = partial.reduce((s, [, w]) => s + w, 0);
      return partial.reduce((s, [v, w]) => s + v * w, 0) / totalW;
    }
    const legacy = [
      selected.exterior_condition,
      selected.interior_condition,
      selected.tyre_condition,
    ].filter((x): x is number => typeof x === "number" && x > 0);
    if (legacy.length === 0) return null;
    return legacy.reduce((a, b) => a + b, 0) / legacy.length;
  }, [selected]);

  const filtered = subs.filter((s) => {
    const b = (s.bucket || (s.status === "priced" || s.status === "declined" ? "priced" : "incoming")) as Bucket;
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

  const handleTyreEstimate = async () => {
    if (!selected) return;
    setEstimatingTyres(true);
    try {
      const data = await apiFetch(`/api/submissions/${selected.id}/tyre-estimate`, {
        method: "POST",
      });
      setSelected({ ...selected, tyre_estimate: data });
    } catch (e: any) {
      alert(e.message);
    } finally {
      setEstimatingTyres(false);
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
            source={themeMode === "light" ? BRAND.logoLight : BRAND.logo}
            style={styles.logo}
            resizeMode="contain"
            accessibilityLabel="Fourbuy Car Buying Co."
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
              <Ionicons name="list" size={14} color={view === "submissions" ? colors.onPrimary : colors.text} />
              <Text style={[styles.viewBtnText, view === "submissions" && styles.viewBtnTextActive]}>
                Submissions
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="cockpit-view-dealers"
              style={[styles.viewBtn, view === "dealers" && styles.viewBtnActive]}
              onPress={() => setView("dealers")}
            >
              <Ionicons name="people" size={14} color={view === "dealers" ? colors.onPrimary : colors.text} />
              <Text style={[styles.viewBtnText, view === "dealers" && styles.viewBtnTextActive]}>
                Dealers
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="cockpit-view-billing"
              style={[styles.viewBtn, view === "billing" && styles.viewBtnActive]}
              onPress={() => setView("billing")}
            >
              <Ionicons name="cash" size={14} color={view === "billing" ? colors.onPrimary : colors.text} />
              <Text style={[styles.viewBtnText, view === "billing" && styles.viewBtnTextActive]}>
                Billing
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="cockpit-view-rewards"
              style={[styles.viewBtn, view === "rewards" && styles.viewBtnActive]}
              onPress={() => setView("rewards")}
            >
              <Ionicons name="gift" size={14} color={view === "rewards" ? colors.onPrimary : colors.text} />
              <Text style={[styles.viewBtnText, view === "rewards" && styles.viewBtnTextActive]}>
                Rewards
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="cockpit-view-kredo"
              style={[styles.viewBtn, view === "kredo" && styles.viewBtnActive]}
              onPress={() => setView("kredo")}
            >
              <Ionicons name="pricetag" size={14} color={view === "kredo" ? colors.onPrimary : colors.text} />
              <Text style={[styles.viewBtnText, view === "kredo" && styles.viewBtnTextActive]}>
                Kredo
              </Text>
              <View style={styles.betaPill}>
                <Text style={styles.betaPillText}>BETA</Text>
              </View>
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
      ) : view === "dealers" ? (
        <View style={{ flex: 1 }}>
          <DealersScreen />
        </View>
      ) : view === "rewards" ? (
        <View style={{ flex: 1 }}>
          <AdminRewardsScreen />
        </View>
      ) : view === "kredo" ? (
        <View style={{ flex: 1 }}>
          <KredoTestScreen />
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
                    <View style={styles.rowBody}>
                      {/* Front photo thumbnail on the left for quick visual identification. */}
                      <View style={styles.rowThumb}>
                        {s.front_photo ? (
                          <Image source={{ uri: s.front_photo }} style={styles.rowThumbImg} resizeMode="cover" />
                        ) : (
                          <Ionicons name="car-outline" size={22} color={colors.textDisabled} />
                        )}
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <View style={styles.rowHeader}>
                          <Text style={styles.rowRef}>{s.reference ?? "—"}</Text>
                          <View
                            style={[
                              styles.rowBadge,
                              {
                                backgroundColor:
                                  s.status === "priced"
                                    ? colors.success + "22"
                                    : s.status === "declined"
                                    ? colors.danger + "22"
                                    : colors.warning + "22",
                              },
                            ]}
                          >
                            <Text
                              style={[
                                styles.rowBadgeText,
                                {
                                  color:
                                    s.status === "priced"
                                      ? colors.success
                                      : s.status === "declined"
                                      ? colors.danger
                                      : colors.warning,
                                },
                              ]}
                            >
                              {s.status === "declined" ? "NO OFFER" : s.status.toUpperCase()}
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
                        {s.unseen ? (
                          <View style={styles.rowUnseenPill}>
                            <Ionicons name="eye-off" size={10} color="#B3261E" />
                            <Text style={styles.rowUnseenPillText}>UNSEEN · SUBJECT TO VIEW</Text>
                          </View>
                        ) : null}
                        {s.price !== null && s.price !== undefined ? (
                          <Text style={styles.rowPrice}>R {s.price.toLocaleString()}</Text>
                        ) : null}
                      </View>
                    </View>
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
              {selected.unseen ? (
                <View style={styles.detailUnseenBanner} testID="admin-unseen-banner">
                  <Ionicons name="eye-off" size={20} color="#B3261E" />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.detailUnseenTitle}>
                      Vehicle Unseen — Subject to View & Less to Spend
                    </Text>
                    <Text style={styles.detailUnseenHint}>
                      Desktop valuation. Dealer has NOT physically inspected the vehicle. Price this cautiously.
                    </Text>
                  </View>
                </View>
              ) : null}
              <View style={styles.detailHeader}>
                <View>
                  <Text style={styles.detailRef}>{selected.reference ?? "—"}</Text>
                  <Text style={styles.detailTitle}>
                    {selected.year} {selected.make_name} {selected.model_name}
                  </Text>
                  <Text style={styles.detailSub}>{selected.derivative_name}</Text>
                  {selected.submitted_by_name ? (
                    <View style={styles.adminSubmittedBy}>
                      <Ionicons name="person-circle-outline" size={14} color={colors.textSecondary} />
                      <Text style={styles.adminSubmittedByText}>
                        Submitted by <Text style={styles.adminSubmittedByBold}>{selected.submitted_by_name}</Text>
                        {selected.submitted_by_job_title ? ` · ${selected.submitted_by_job_title}` : ""}
                        {selected.submitted_at ? ` · ${(selected.submitted_at || "").slice(0, 10)}` : ""}
                      </Text>
                    </View>
                  ) : null}
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

              {/* Vehicle Details — vertical spec list, easy to scan top-to-bottom */}
              <Text style={styles.groupTitle}>Vehicle Details</Text>
              <View style={styles.detailsList}>
                <DetailRow label="Year Registered" value={String(selected.year_registered ?? selected.year)} />
                <DetailRow label="Make" value={selected.make_name} />
                <DetailRow label="Model" value={selected.model_name} />
                <DetailRow label="Derivative" value={selected.derivative_name} />
                <DetailRow label="Mileage" value={`${selected.mileage.toLocaleString()} km`} />
                <DetailRow label="Transmission" value={selected.transmission ?? "—"} />
                <DetailRow label="Fuel Type" value={selected.fuel_type ?? "—"} />
                <DetailRow label="Colour" value={selected.colour} />
                <DetailRow label="Rim Size" value={selected.rim_size ? `${selected.rim_size}″` : "—"} />
                <DetailRow label="Year of Production" value={String(selected.year_of_production ?? selected.year)} last />
              </View>

              {/* Condition detail — 4 pillars for new submissions, legacy 3 fallback.
                  HIDDEN when the submission is flagged as `unseen` — no
                  physical inspection was performed, so ratings are
                  meaningless. The red banner at the top of the pane
                  already tells the admin to price cautiously. */}
              {!selected.unseen ? (
              <>
              <Text style={styles.groupTitle}>Condition</Text>
              <View style={styles.detailsList}>
                {typeof selected.mechanical_condition === "number" ? (
                  <>
                    <DetailRow label="Mechanical Health" value={`${selected.mechanical_condition} / 10`} />
                    <DetailRow label="Cosmetic Appearance" value={`${selected.cosmetic_condition} / 10`} />
                    <DetailRow label="Interior Condition" value={`${selected.interior_condition} / 10`} />
                    <DetailRow label="General Condition" value={`${selected.history_condition} / 10`} />
                  </>
                ) : (
                  <>
                    <DetailRow label="Exterior" value={selected.exterior_condition ? `${selected.exterior_condition} / 10` : "—"} />
                    <DetailRow label="Interior" value={selected.interior_condition ? `${selected.interior_condition} / 10` : "—"} />
                    <DetailRow label="Tyres" value={selected.tyre_condition ? `${selected.tyre_condition} / 10` : "—"} />
                  </>
                )}
                <DetailRow
                  label="Previous Accident Damage"
                  value={selected.accident_damage ? "Yes" : "None"}
                  color={selected.accident_damage ? colors.danger : colors.text}
                />
                {selected.accident_damage && selected.accident_damage_types && selected.accident_damage_types.length > 0 ? (
                  <DetailRow
                    label="Damage Types"
                    value={selected.accident_damage_types.join(", ")}
                    color={colors.danger}
                  />
                ) : null}
                <DetailRow
                  label="Paint Evidence"
                  value={selected.paint_evidence ? "Yes" : "No"}
                  color={selected.paint_evidence ? colors.danger : colors.text}
                  last={!(selected.paint_evidence && selected.paint_quality)}
                />
                {selected.paint_evidence && selected.paint_quality ? (
                  <DetailRow label="Paint Repair Quality" value={selected.paint_quality} last />
                ) : null}
              </View>
              </>
              ) : null}
              {/* --- end !unseen: Condition + Damage + Paint --- */}

              {/* Service history — hidden when the submission is flagged as unseen. */}
              {!selected.unseen && selected.service_history ? (
                <>
                  <Text style={styles.groupTitle}>Service History</Text>
                  <View style={styles.detailsList}>
                    <DetailRow label="History" value={selected.service_history} />
                    <DetailRow
                      label="Last Service"
                      value={
                        selected.last_service_date && selected.last_service_date !== "TBC"
                          ? selected.last_service_date
                          : "TBC"
                      }
                    />
                    <DetailRow
                      label="Service Mileage"
                      value={
                        selected.last_service_mileage
                          ? `${selected.last_service_mileage.toLocaleString()} km`
                          : "TBC"
                      }
                    />
                    {(() => {
                      // Derived "gap since last service" — mirrors the dealer
                      // valuation view. Amber >12m or >15,000 km; red >24m or
                      // >30,000 km.
                      const gap = computeServiceGap(
                        selected.last_service_date,
                        selected.last_service_mileage,
                        selected.mileage,
                      );
                      if (gap.monthsAgo == null && gap.kmSince == null) return null;
                      const timeColour =
                        gap.monthsAgo != null && gap.monthsAgo >= 24
                          ? colors.danger
                          : gap.monthsAgo != null && gap.monthsAgo >= 12
                          ? colors.warning
                          : colors.success;
                      const kmColour =
                        gap.kmSince != null && gap.kmSince >= 30000
                          ? colors.danger
                          : gap.kmSince != null && gap.kmSince >= 15000
                          ? colors.warning
                          : colors.success;
                      return (
                        <>
                          <DetailRow
                            label="Time Since Service"
                            value={gap.monthsAgo != null ? formatMonthsAgo(gap.monthsAgo) : "—"}
                            color={timeColour}
                          />
                          <DetailRow
                            label="Mileage Since Service"
                            value={gap.kmSince != null ? formatKm(gap.kmSince) : "—"}
                            color={kmColour}
                            last
                          />
                        </>
                      );
                    })()}
                  </View>
                </>
              ) : null}

              {/* Reconditioning */}
              {!selected.unseen && selected.reconditioning_items && selected.reconditioning_items.length > 0 ? (
                <>
                  <Text style={styles.groupTitle}>Reconditioning Estimate</Text>
                  <View style={styles.detailsList}>
                    {selected.reconditioning_items.map((r: any, i) => {
                      const photos: string[] = Array.isArray(r?.photos) && r.photos.length > 0
                        ? r.photos.filter((x: any) => typeof x === "string" && x)
                        : r?.photo
                          ? [r.photo]
                          : [];
                      const heading = r?.category || r?.label || "Reconditioning";
                      return (
                        <View key={i} style={styles.adminReconCard}>
                          <View style={styles.adminReconHeadRow}>
                            <Text style={[styles.detailRowLabel, { flex: 1 }]}>{heading}</Text>
                            <Text style={[styles.detailRowValue, { fontFamily: fonts.mono }]}>
                              R {r.amount_zar.toLocaleString()}
                            </Text>
                          </View>
                          {photos.length > 0 ? (
                            <View style={styles.adminReconPhotoStrip}>
                              {photos.map((uri, pIdx) => (
                                <TouchableOpacity
                                  key={pIdx}
                                  onPress={() => {
                                    const idx = carouselPhotos.findIndex((c) => c.uri === uri);
                                    if (idx >= 0) setCarouselIdx(idx);
                                  }}
                                  style={styles.reconThumbWrap}
                                  testID={`admin-recon-thumb-${i}-${pIdx}`}
                                >
                                  <Image source={{ uri }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
                                </TouchableOpacity>
                              ))}
                            </View>
                          ) : null}
                        </View>
                      );
                    })}
                    <View style={styles.reconTotalRow}>
                      <Text style={styles.detailRowLabel}>Total</Text>
                      <Text style={styles.reconTotal}>
                        R{" "}
                        {(selected.reconditioning_total_zar ??
                          selected.reconditioning_items.reduce(
                            (s, x) => s + (x.amount_zar || 0),
                            0
                          )
                        ).toLocaleString()}
                      </Text>
                    </View>
                  </View>
                </>
              ) : null}

              {/* Identity */}
              <Text style={styles.groupTitle}>Identity</Text>
              <View style={styles.detailsList}>
                <DetailRow label="VIN" value={selected.vin || "TBC"} mono />
                <DetailRow label="Engine No" value={selected.engine_number || "TBC"} mono last />
              </View>

              {/* Photos */}
              <Text style={styles.groupTitle}>Photos <Text style={styles.groupHint}>· tap to expand</Text></Text>
              <View style={styles.photoRow}>
                {PHOTO_ORDER.map((p) => {
                  const uri = resolvePhoto(selected.photos, p.key, p.fallback);
                  return uri ? (
                    <TouchableOpacity
                      key={p.key}
                      style={styles.photo}
                      testID={`admin-photo-${p.key}`}
                      onPress={() => {
                        const idx = carouselPhotos.findIndex((c) => c.uri === uri);
                        if (idx >= 0) setCarouselIdx(idx);
                      }}
                    >
                      <Image source={{ uri }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
                      <View style={styles.photoBadge}>
                        <Text style={styles.photoBadgeText}>{p.label.toUpperCase()}</Text>
                        <Ionicons name="expand-outline" size={12} color="#fff" />
                      </View>
                    </TouchableOpacity>
                  ) : (
                    <View key={p.key} style={[styles.photo, styles.photoPlaceholder]}>
                      <Ionicons name="image-outline" size={20} color={colors.textDisabled} />
                      <Text style={styles.photoLabelDim}>{p.label.toUpperCase()}</Text>
                    </View>
                  );
                })}
              </View>

              {/* Overall condition hero — under Photos, tap to open the guide. */}
              {averageRating !== null ? (
                <TouchableOpacity
                  testID="admin-avg-rating-hero"
                  activeOpacity={0.9}
                  onPress={() => setConditionInfoOpen(true)}
                  style={styles.heroBox}
                >
                  <View style={{ flex: 1 }}>
                    <View style={styles.heroTopRow}>
                      <Text style={styles.heroLabel}>OVERALL CONDITION</Text>
                      <View style={styles.heroInfoBtn}>
                        <Ionicons name="information-circle-outline" size={16} color={colors.textSecondary} />
                        <Text style={styles.heroInfoText}>Guide</Text>
                      </View>
                    </View>
                    <View style={styles.heroRow}>
                      <Text style={styles.heroValue}>{averageRating.toFixed(1)}</Text>
                      <Text style={styles.heroOutOf}>/ 10</Text>
                    </View>
                    <View style={styles.heroBar}>
                      <View style={[styles.heroBarFill, { width: `${(averageRating / 10) * 100}%` }]} />
                    </View>
                  </View>
                  <View style={styles.heroBreakdown}>
                    {typeof selected.mechanical_condition === "number" ? (
                      <>
                        <HeroPill label="MECH" value={selected.mechanical_condition} />
                        <HeroPill label="COSM" value={selected.cosmetic_condition} />
                        <HeroPill label="INT" value={selected.interior_condition} />
                        <HeroPill label="GEN" value={selected.history_condition} />
                      </>
                    ) : (
                      <>
                        <HeroPill label="EXT" value={selected.exterior_condition} />
                        <HeroPill label="INT" value={selected.interior_condition} />
                        <HeroPill label="TYRES" value={selected.tyre_condition} />
                      </>
                    )}
                  </View>
                </TouchableOpacity>
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

              {/* Tyre Replacement Estimate */}
              <View style={styles.analysisBox}>
                <View style={styles.analysisHeader}>
                  <Text style={styles.boxTitle}>TYRE REPLACEMENT ESTIMATE</Text>
                  <TouchableOpacity
                    testID="admin-tyre-estimate-button"
                    style={[styles.analyseBtn, estimatingTyres && { opacity: 0.6 }]}
                    onPress={handleTyreEstimate}
                    disabled={estimatingTyres}
                  >
                    {estimatingTyres ? (
                      <ActivityIndicator color={colors.primary} size="small" />
                    ) : (
                      <>
                        <Ionicons name="disc-outline" size={14} color={colors.primary} />
                        <Text style={styles.analyseBtnText}>
                          {selected.tyre_estimate ? "REFRESH" : "ESTIMATE"}
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>

                {selected.tyre_estimate?.estimate ? (
                  <>
                    <View style={styles.tyreHeaderRow}>
                      <View style={styles.tyreSpecBadge}>
                        <Ionicons name="disc" size={14} color="#fff" />
                        <Text style={styles.tyreSpecText}>
                          {selected.tyre_estimate.estimate.tyre_spec ?? "—"}
                        </Text>
                      </View>
                      {selected.rim_size ? (
                        <Text style={styles.tyreRimText}>Rim: {selected.rim_size}″</Text>
                      ) : null}
                    </View>

                    {selected.tyre_estimate.estimate.total_replacement_estimate_zar ? (
                      <View style={styles.tyreTotalBox}>
                        <Text style={styles.tyreTotalLabel}>Total 4-tyre replacement</Text>
                        <Text style={styles.tyreTotalValue}>
                          R {selected.tyre_estimate.estimate.total_replacement_estimate_zar.toLocaleString()}
                        </Text>
                      </View>
                    ) : null}

                    {selected.tyre_estimate.estimate.set_of_four_zar ? (
                      <View style={styles.rangeBox}>
                        <View style={styles.rangeCell}>
                          <Text style={styles.rangeLabel}>SET LOW</Text>
                          <Text style={styles.rangeValue}>
                            R {selected.tyre_estimate.estimate.set_of_four_zar.low.toLocaleString()}
                          </Text>
                        </View>
                        <View style={[styles.rangeCell, { backgroundColor: colors.accent + "18" }]}>
                          <Text style={styles.rangeLabel}>TYPICAL</Text>
                          <Text style={[styles.rangeValue, { color: colors.accent }]}>
                            R {selected.tyre_estimate.estimate.set_of_four_zar.typical.toLocaleString()}
                          </Text>
                        </View>
                        <View style={styles.rangeCell}>
                          <Text style={styles.rangeLabel}>SET HIGH</Text>
                          <Text style={styles.rangeValue}>
                            R {selected.tyre_estimate.estimate.set_of_four_zar.high.toLocaleString()}
                          </Text>
                        </View>
                      </View>
                    ) : null}

                    <View style={styles.tradeSplit}>
                      {selected.tyre_estimate.estimate.per_tyre_range_zar ? (
                        <View style={styles.tradeCell}>
                          <Text style={styles.rangeLabel}>PER TYRE</Text>
                          <Text style={styles.rangeValue}>
                            R {selected.tyre_estimate.estimate.per_tyre_range_zar.typical.toLocaleString()}
                          </Text>
                        </View>
                      ) : null}
                      {selected.tyre_estimate.estimate.fitment_and_balance_zar ? (
                        <View style={styles.tradeCell}>
                          <Text style={styles.rangeLabel}>FITMENT & BALANCE</Text>
                          <Text style={styles.rangeValue}>
                            R {selected.tyre_estimate.estimate.fitment_and_balance_zar.toLocaleString()}
                          </Text>
                        </View>
                      ) : null}
                    </View>

                    {selected.tyre_estimate.estimate.recommended_brands?.length ? (
                      <View style={{ marginTop: spacing.sm, gap: 4 }}>
                        <Text style={styles.factorTitle}>RECOMMENDED BRANDS</Text>
                        {selected.tyre_estimate.estimate.recommended_brands.map((b, i) => (
                          <View key={i} style={styles.factorRow}>
                            <Ionicons name="checkmark-circle" size={13} color={colors.primary} />
                            <Text style={styles.factorText}>{b}</Text>
                          </View>
                        ))}
                      </View>
                    ) : null}

                    {selected.tyre_estimate.estimate.notes ? (
                      <Text style={styles.summary}>{selected.tyre_estimate.estimate.notes}</Text>
                    ) : null}

                    {selected.tyre_estimate.estimate.raw ? (
                      <Text style={styles.summary}>{selected.tyre_estimate.estimate.raw}</Text>
                    ) : null}

                    {selected.tyre_estimate.estimate.disclaimer ? (
                      <Text style={styles.disclaimer}>
                        {selected.tyre_estimate.estimate.disclaimer}
                      </Text>
                    ) : null}
                  </>
                ) : (
                  <Text style={styles.analysisEmpty}>
                    Click ESTIMATE for a GPT-5.2 tyre-replacement price using this vehicle&apos;s
                    OEM tyre spec and current SA aftermarket pricing.
                  </Text>
                )}
              </View>

              {/* ================= MARKET VALUES (Kredo) ================= */}
              {/* Locked-at-valuation Kredo snapshot: new list + M&M code
                  from the flatfile, trade + retail from Kredo /value.
                  Matches the mobile "Market Values" card 1:1. */}
              <View style={styles.analysisBox}>
                <View style={styles.priceBoxHeader}>
                  <Text style={styles.boxTitle}>MARKET VALUES</Text>
                  {selected.market_values?.status === "ok" ? (
                    <View style={styles.lockedPill}>
                      <Ionicons name="lock-closed" size={11} color={colors.textSecondary} />
                      <Text style={styles.lockedPillText}>LOCKED AT VALUATION</Text>
                    </View>
                  ) : null}
                </View>
                {selected.market_values?.status === "ok" ? (
                  <View style={styles.mvGrid}>
                    <View style={styles.mvBox}>
                      <Text style={styles.mvLabel}>NEW LIST PRICE</Text>
                      <Text style={styles.mvValue}>{fmtZar(selected.market_values.new_list_price_zar)}</Text>
                    </View>
                    <View style={styles.mvBox}>
                      <Text style={styles.mvLabel}>M&M CODE</Text>
                      <Text style={[styles.mvValue, styles.mvMono]}>{selected.market_values.mm_code || "—"}</Text>
                    </View>
                    <View style={styles.mvBox}>
                      <Text style={styles.mvLabel}>TRADE VALUE</Text>
                      <Text style={styles.mvValue}>{fmtZar(selected.market_values.trade_price_zar)}</Text>
                    </View>
                    <View style={styles.mvBox}>
                      <Text style={styles.mvLabel}>RETAIL VALUE</Text>
                      <Text style={styles.mvValue}>{fmtZar(selected.market_values.retail_price_zar)}</Text>
                    </View>
                  </View>
                ) : selected.market_values?.status === "error" ? (
                  <Text style={styles.analysisEmpty}>
                    Could not fetch market values: {selected.market_values.error || "Kredo lookup failed."}
                  </Text>
                ) : (
                  <Text style={styles.analysisEmpty}>Fetching from Kredo…</Text>
                )}
              </View>

              {/* ================= FACTORY FITTED VEHICLE OPTIONS (Bimmervin) ================= */}
              {/* Read-only mirror of the mobile "Factory Fitted Vehicle
                  Options" card. Fetching stays on mobile — the web
                  cockpit just displays the cached snapshot. */}
              {selected.bimmer_spec?.status === "ok" ? (
                <View style={styles.analysisBox}>
                  <Text style={styles.boxTitle}>FACTORY FITTED VEHICLE OPTIONS</Text>
                  <Text style={styles.bimmerWebSubHeader}>Against supplied VIN</Text>
                  {Array.isArray(selected.bimmer_spec.options) && selected.bimmer_spec.options.length > 0 ? (
                    <View style={styles.bimmerOptionsWebList}>
                      {selected.bimmer_spec.options.map((o) => (
                        <View
                          key={`${o.kind}-${o.code}`}
                          style={o.description ? styles.bimmerOptionWebRow : styles.bimmerOptionWebRowBare}
                        >
                          <View style={styles.bimmerOptionWebKindBadge}>
                            <Text style={styles.bimmerOptionWebKindText}>{o.kind}</Text>
                          </View>
                          <Text style={styles.bimmerOptionWebCodeStrong}>{o.code}</Text>
                          {o.description ? (
                            <Text style={styles.bimmerOptionWebDesc} numberOfLines={2}>
                              {o.description}
                            </Text>
                          ) : (
                            <Text style={styles.bimmerOptionWebDescMuted}>—</Text>
                          )}
                        </View>
                      ))}
                    </View>
                  ) : (
                    <Text style={styles.analysisEmpty}>No factory options returned for this VIN.</Text>
                  )}
                </View>
              ) : selected.bimmer_spec?.status === "error" ? (
                <View style={styles.analysisBox}>
                  <Text style={styles.boxTitle}>FACTORY FITTED VEHICLE OPTIONS</Text>
                  <Text style={styles.analysisEmpty}>
                    Could not fetch factory options: {selected.bimmer_spec.error || "Bimmervin lookup failed."}
                  </Text>
                </View>
              ) : null}

              {/* ================= VIN-LINKED REPORTS ================= */}
              {/* Read-only list of every VIN-report order placed against
                  this submission — matches the mobile "Order a VIN-Linked
                  Report" section. Ordering UI stays on mobile for now. */}
              {selected.report_orders && selected.report_orders.length > 0 ? (
                <View style={styles.analysisBox}>
                  <Text style={styles.boxTitle}>VIN-LINKED REPORTS</Text>
                  {selected.report_orders.map((r) => (
                    <View key={r.id} style={styles.reportRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.reportName}>{r.name || formatReportName(r.type)}</Text>
                        <Text style={styles.reportMeta}>
                          {r.ordered_at ? `Ordered ${new Date(r.ordered_at).toLocaleString("en-ZA")}` : ""}
                          {r.cost_zar != null ? `  ·  ${fmtZar(r.cost_zar)}` : ""}
                        </Text>
                      </View>
                      <View
                        style={[
                          styles.reportStatusPill,
                          r.status === "completed" && { backgroundColor: colors.success + "22", borderColor: colors.success },
                          r.status === "failed" && { backgroundColor: colors.danger + "22", borderColor: colors.danger },
                        ]}
                      >
                        <Text style={styles.reportStatusText}>{(r.status || "pending").toUpperCase()}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              ) : null}

              {/* ================= ACCIDENT / CLAIM HISTORY (Kredo VIN) ================= */}
              {selected.kredo_vin_history?.status === "ok" ? (
                <View style={styles.analysisBox}>
                  <Text style={styles.boxTitle}>ACCIDENT / CLAIM HISTORY</Text>
                  <Text style={styles.summary}>
                    {(() => {
                      const claims = (selected.kredo_vin_history?.data as any)?.["claim-history"];
                      if (Array.isArray(claims) && claims.length > 0) {
                        return `${claims.length} claim record${claims.length === 1 ? "" : "s"} on file (Kredo).`;
                      }
                      return "No claim history recorded against this VIN (Kredo).";
                    })()}
                  </Text>
                  {selected.kredo_vin_history?.fetched_at ? (
                    <Text style={styles.disclaimer}>
                      Fetched {new Date(selected.kredo_vin_history.fetched_at).toLocaleString("en-ZA")}
                    </Text>
                  ) : null}
                </View>
              ) : null}

              {/* ================= LICENSE DISK DATA ================= */}
              {/* Decoded into labelled rows (matches mobile). If the raw
                  string can't be decoded we fall back to a monospace dump
                  so nothing is lost. */}
              {selected.license_disk_data ? (
                <View style={styles.analysisBox}>
                  <Text style={styles.boxTitle}>LICENSE DISK DATA</Text>
                  {(() => {
                    const info = decodeLicenseDisk(selected.license_disk_data!);
                    const rows: [string, string | undefined][] = [
                      ["Licence No", info.licenceNo],
                      ["Register No", info.vehicleRegisterNo],
                      ["Make", info.make],
                      ["Model", info.model],
                      ["Colour", info.colour],
                      ["Description", info.vehicleDescription],
                      ["VIN", info.vin],
                      ["Engine No", info.engineNo],
                      ["Expires", info.expiryDate],
                      ["Disc No", info.licenceDiscNo],
                    ];
                    const visible = rows.filter(([, v]) => !!v);
                    if (visible.length === 0) {
                      return (
                        <Text style={styles.diskData} selectable>
                          {selected.license_disk_data}
                        </Text>
                      );
                    }
                    return (
                      <View style={{ marginTop: spacing.sm }}>
                        {visible.map(([label, value]) => (
                          <View key={label} style={styles.diskDecodedRow}>
                            <Text style={styles.diskDecodedLabel}>{label}</Text>
                            <Text style={styles.diskDecodedValue} selectable>
                              {value}
                            </Text>
                          </View>
                        ))}
                      </View>
                    );
                  })()}
                </View>
              ) : null}

              {/* ================= OFFER HISTORY ================= */}
              {selected.price_history && selected.price_history.length > 0 ? (
                <View style={styles.analysisBox}>
                  <Text style={styles.boxTitle}>OFFER HISTORY</Text>
                  {selected.price_history.map((p, i) => (
                    <View key={p.id || i} style={styles.offerRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.offerPrice}>
                          {fmtZar(p.new_price)}
                          {p.previous_price != null ? (
                            <Text style={styles.offerNote}>
                              {"   was "}{fmtZar(p.previous_price)}
                            </Text>
                          ) : null}
                        </Text>
                        {p.comment ? (
                          <Text style={styles.offerNote}>{p.comment}</Text>
                        ) : null}
                        {p.new_notes ? (
                          <Text style={styles.offerNote}>{p.new_notes}</Text>
                        ) : null}
                      </View>
                      <View>
                        <Text style={styles.offerMeta}>
                          {p.at ? new Date(p.at).toLocaleString("en-ZA") : "—"}
                        </Text>
                        {p.admin_name ? (
                          <Text style={styles.offerMeta}>{p.admin_name}</Text>
                        ) : null}
                      </View>
                    </View>
                  ))}
                </View>
              ) : null}
            </ScrollView>
          )}
        </View>
      </View>
      )}
      <PhotoCarousel
        photos={carouselPhotos}
        initialIndex={carouselIdx ?? 0}
        visible={carouselIdx !== null}
        onClose={() => setCarouselIdx(null)}
      />
      <ConditionRatingInfoModal
        visible={conditionInfoOpen}
        onClose={() => setConditionInfoOpen(false)}
      />
    </View>
  );
}

function HeroPill({ label, value }: { label: string; value?: number }) {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.heroPill}>
      <Text style={styles.heroPillLabel}>{label}</Text>
      <Text style={styles.heroPillValue}>{value ? `${value}/10` : "—"}</Text>
    </View>
  );
}

function DetailRow({
  label,
  value,
  color,
  last,
  mono,
}: {
  label: string;
  value: string;
  color?: string;
  last?: boolean;
  mono?: boolean;
}) {
  const themeColors = useThemeColors();
  const styles = useMemo(() => makeStyles(themeColors), [themeColors]);
  return (
    <View style={[styles.detailRow, last && { borderBottomWidth: 0 }]}>
      <Text style={styles.detailRowLabel}>{label}:</Text>
      <Text
        style={[
          styles.detailRowValue,
          mono && { fontFamily: fonts.mono, letterSpacing: 0.5 },
          color ? { color } : null,
        ]}
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  );
}

function SpecCell(_props: { label: string; value: string; color?: string }) {
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const __SpecCellUnused = SpecCell;

const makeStyles = (colors: Palette) => StyleSheet.create({
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
  logo: { width: 168, height: 58 },
  divider: { width: 1, height: 30, backgroundColor: colors.border },
  topbarSub: {
    color: colors.textSecondary,
    fontFamily: fonts.heading,
    letterSpacing: 3,
    fontSize: 13,
    textTransform: "uppercase",
    fontWeight: "700",
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
  viewBtnTextActive: { color: colors.onPrimary, fontWeight: "800" },
  betaPill: {
    backgroundColor: colors.warning,
    borderRadius: 999,
    paddingHorizontal: 5,
    paddingVertical: 1,
    marginLeft: 4,
  },
  betaPillText: {
    color: colors.onPrimary,
    fontSize: 9,
    fontWeight: "900",
    letterSpacing: 0.5,
  },
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
  statPillValue: { fontSize: 20, fontWeight: "800", fontFamily: fonts.number, fontVariant: ["tabular-nums"], letterSpacing: -0.2 },
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
  chipTextActive: { color: colors.onPrimary, fontWeight: "800" },
  chipBadge: {
    minWidth: 22,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.pill,
    backgroundColor: colors.border,
    alignItems: "center",
  },
  chipBadgeActive: { backgroundColor: colors.onPrimary },
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
  rowRef: { color: "#fff", fontSize: 15, fontWeight: "800", fontFamily: fonts.mono, letterSpacing: 0.5 },
  rowBody: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  rowThumb: {
    width: 76,
    height: 58,
    borderRadius: radius.sm,
    overflow: "hidden",
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  rowThumbImg: { width: "100%", height: "100%" },
  rowBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.sm },
  rowBadgeText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: "700", marginTop: 8, letterSpacing: 0.1 },
  rowSub: { color: colors.textSecondary, fontSize: 13, marginTop: 3, letterSpacing: 0.1 },
  rowDealer: { color: colors.textDisabled, fontSize: 12, marginTop: 4, letterSpacing: 0.1 },
  rowPrice: {
    color: colors.success,
    fontSize: 16,
    fontWeight: "800",
    fontFamily: fonts.number,
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.1,
    marginTop: 6,
  },
  rowUnseenPill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: "#FDECEA",
    borderWidth: 1,
    borderColor: "#B3261E",
  },
  rowUnseenPillText: {
    color: "#B3261E",
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  detailUnseenBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: "#B3261E",
    backgroundColor: "#FDECEA",
  },
  detailUnseenTitle: {
    color: "#B3261E",
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  detailUnseenHint: {
    color: "#6B2018",
    fontSize: 12,
    marginTop: 2,
    lineHeight: 16,
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
  detailRef: { color: "#fff", fontFamily: fonts.mono, fontSize: 16, fontWeight: "800", letterSpacing: 0.8 },
  detailTitle: { color: colors.text, fontSize: 28, fontWeight: "800", fontFamily: fonts.heading, marginTop: 6, letterSpacing: 0.3 },
  detailSub: { color: colors.textSecondary, fontSize: 15, marginTop: 4, letterSpacing: 0.1 },
  adminSubmittedBy: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    alignSelf: "flex-start",
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: radius.sm,
  },
  adminSubmittedByText: { color: colors.textSecondary, fontSize: 12 },
  adminSubmittedByBold: { color: "#fff", fontWeight: "700" },
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

  photoRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm, flexWrap: "wrap" },
  photo: {
    width: 180,
    aspectRatio: 4 / 3,
    borderRadius: radius.sm,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
    position: "relative",
  },
  photoPlaceholder: { alignItems: "center", justifyContent: "center", gap: 4 },
  photoBadge: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    padding: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(0,0,0,0.72)",
  },
  photoBadgeText: { color: "#fff", fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  photoLabelDim: { color: colors.textDisabled, fontSize: 10, fontWeight: "700", letterSpacing: 1 },

  // Hero rating
  heroBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    marginBottom: spacing.md,
  },
  heroLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.6,
  },
  heroTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },
  heroInfoBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.paper,
  },
  heroInfoText: { color: colors.textSecondary, fontSize: 11, fontWeight: "700", letterSpacing: 0.4 },
  heroRow: { flexDirection: "row", alignItems: "baseline" },
  heroValue: {
    color: colors.text,
    fontSize: 72,
    fontWeight: "900",
    fontFamily: fonts.mono,
    lineHeight: 78,
    letterSpacing: -2,
  },
  heroOutOf: { color: colors.textSecondary, fontSize: 22, fontWeight: "700", fontFamily: fonts.mono, marginLeft: 6 },
  heroBar: {
    height: 6,
    backgroundColor: colors.border,
    borderRadius: 3,
    marginTop: spacing.sm,
    overflow: "hidden",
  },
  heroBarFill: { height: "100%", backgroundColor: "#fff" },
  heroBreakdown: { flexDirection: "column", gap: spacing.sm, minWidth: 130 },
  heroPill: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.paper,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  heroPillLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: "700", letterSpacing: 0.4 },
  heroPillValue: { color: colors.text, fontSize: 13, fontWeight: "800", fontFamily: fonts.mono },

  groupTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.3,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  groupHint: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "500",
  },

  detailsList: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.md,
  },
  detailRowLabel: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: "500",
    letterSpacing: 0.1,
  },
  detailRowValue: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.1,
    flex: 1,
    textAlign: "right",
  },

  infoCard: {
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    gap: 4,
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.md,
  },
  infoLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: "700", letterSpacing: 1, minWidth: 130 },
  infoValue: { color: colors.text, fontSize: 13, fontWeight: "700", flex: 1, textAlign: "right" },
  monoValue: { color: colors.text, fontSize: 12, fontFamily: fonts.mono, fontWeight: "700", flex: 1, textAlign: "right" },
  reconAmount: { color: colors.text, fontFamily: fonts.number, fontVariant: ["tabular-nums"], fontWeight: "700", fontSize: 15, letterSpacing: -0.1 },
  reconTotalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 10,
    paddingTop: 14,
  },
  reconTotal: { color: "#fff", fontFamily: fonts.number, fontVariant: ["tabular-nums"], fontWeight: "800", fontSize: 20, letterSpacing: -0.2 },
  reconThumbWrap: {
    width: 56,
    height: 56,
    borderRadius: radius.sm,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
  },
  adminReconCard: {
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  adminReconHeadRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.sm,
  },
  adminReconPhotoStrip: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },

  dealerBox: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
  },
  boxTitle: { color: colors.textSecondary, fontSize: 12, fontWeight: "700", letterSpacing: 0.4 },
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
  priceBadge: { color: colors.success, fontFamily: fonts.number, fontVariant: ["tabular-nums"], fontSize: 18, fontWeight: "800", letterSpacing: -0.2 },
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
  currencyLabel: { color: colors.textSecondary, fontSize: 18, fontFamily: fonts.number, marginRight: 6 },
  priceInput: {
    flex: 1,
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
    fontFamily: fonts.number,
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.2,
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
  sendBtnText: { color: colors.onPrimary, fontWeight: "800", fontSize: 14, letterSpacing: 0.3 },
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
  rangeValue: { color: colors.text, fontSize: 16, fontWeight: "800", fontFamily: fonts.number, fontVariant: ["tabular-nums"], letterSpacing: -0.1 },
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

  // === MARKET VALUES (Kredo snapshot) ===
  lockedPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.paper,
  },
  lockedPillText: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
  },
  mvGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: spacing.sm,
    marginHorizontal: -spacing.xs,
  },
  mvBox: {
    width: "50%",
    padding: spacing.xs,
  },
  mvLabel: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  mvValue: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  mvMono: {
    fontFamily: fonts.mono,
    letterSpacing: 0.5,
  },

  // === Bimmervin (BMW factory spec) — web pills ===
  bimmerWebSubHeader: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: spacing.sm,
  },
  bimmerOptionsWebWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  bimmerOptionWebPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.paper,
  },
  bimmerOptionWebKind: {
    color: colors.textSecondary,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  bimmerOptionWebCode: {
    color: colors.text,
    fontSize: 11,
    fontFamily: fonts.mono,
    letterSpacing: 0.5,
    fontWeight: "700",
  },
  // Rich rows with descriptions — used when local dictionary knows the code.
  bimmerOptionsWebList: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 6,
  },
  bimmerOptionWebRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.paper,
  },
  bimmerOptionWebRowBare: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border,
    backgroundColor: "transparent",
    opacity: 0.72,
  },
  bimmerOptionWebKindBadge: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: colors.neon + "22",
    minWidth: 24,
    alignItems: "center",
  },
  bimmerOptionWebKindText: {
    color: colors.text,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  bimmerOptionWebCodeStrong: {
    color: colors.text,
    fontSize: 12,
    fontFamily: fonts.mono,
    fontWeight: "800",
    letterSpacing: 0.5,
    minWidth: 50,
  },
  bimmerOptionWebDesc: {
    color: colors.text,
    fontSize: 12,
    lineHeight: 15,
    flex: 1,
  },
  bimmerOptionWebDescMuted: {
    color: colors.textSecondary,
    fontSize: 12,
    flex: 1,
    fontStyle: "italic",
  },

  // === VIN-LINKED REPORTS list ===
  reportRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  reportName: { color: colors.text, fontSize: 13, fontWeight: "700" },
  reportMeta: { color: colors.textSecondary, fontSize: 11, marginTop: 2 },
  reportStatusPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.paper,
  },
  reportStatusText: {
    color: colors.text,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.6,
  },

  // === LICENSE DISK RAW DATA (fallback when we can't decode) ===
  diskData: {
    color: colors.text,
    fontSize: 12,
    fontFamily: fonts.mono,
    lineHeight: 17,
    marginTop: spacing.sm,
  },
  // Decoded license-disk rows — mirrors the mobile look.
  diskDecodedRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingVertical: spacing.xs + 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.md,
  },
  diskDecodedLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    width: 128,
  },
  diskDecodedValue: {
    color: colors.text,
    fontSize: 13,
    fontFamily: fonts.mono,
    letterSpacing: 0.3,
    flex: 1,
    textAlign: "right",
  },

  // === OFFER HISTORY entries ===
  offerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.md,
  },
  offerPrice: { color: colors.text, fontSize: 15, fontWeight: "800" },
  offerNote: { color: colors.textSecondary, fontSize: 12, marginTop: 2, lineHeight: 17 },
  offerMeta: { color: colors.textSecondary, fontSize: 11, textAlign: "right" },
  tyreHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  tyreSpecBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: "#000",
  },
  tyreSpecText: { color: "#fff", fontFamily: fonts.mono, fontSize: 13, fontWeight: "700", letterSpacing: 0.5 },
  tyreRimText: { color: colors.textSecondary, fontSize: 12, fontWeight: "700", letterSpacing: 0.5 },
  tyreTotalBox: {
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.paper,
    marginBottom: spacing.md,
    alignItems: "center",
  },
  tyreTotalLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
  tyreTotalValue: { color: "#fff", fontSize: 28, fontWeight: "800", fontFamily: fonts.number, fontVariant: ["tabular-nums"], letterSpacing: -0.3, marginTop: 4 },
});
