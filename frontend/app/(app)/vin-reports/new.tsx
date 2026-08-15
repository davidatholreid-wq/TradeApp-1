/**
 * VIN Reports — new order flow.
 *
 * Three-step flow rendered as a single scrollable form:
 *   1. Pick a Make (dropdown)
 *   2. Enter or scan a VIN
 *   3. Pick one of the available report types for that make and order it
 *
 * On successful order the caller is redirected back to /vin-reports and
 * their new order appears at the top of the list with its result.
 *
 * The pattern deliberately mirrors the existing /submit scan flow so
 * dealers already familiar with the app feel right at home.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TextInput, ActivityIndicator, Platform, Alert, Modal } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { useRouter, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { storage } from "@/src/utils/storage";
import { SCAN_BUFFER_KEY, SCAN_PARSED_KEY } from "../scan";

import ScreenBackButton from "@/src/components/ScreenBackButton";
import { spacing, radius } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { apiFetch } from "@/src/api";
import { decodeLicenseDisk } from "@/src/utils/licenseDisk";

type ReportEntry = {
  id: string;
  label: string;
  cost_zar: number;
  blurb: string;
};

export default function VinReportsNewScreen() {
  const colors = useThemeColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ orderId?: string }>();
  const styles = makeStyles(colors);

  const [makes, setMakes] = useState<string[]>([]);
  const [selectedMake, setSelectedMake] = useState<string>("");
  const [vin, setVin] = useState<string>("");
  const [available, setAvailable] = useState<ReportEntry[]>([]);
  const [availableLoading, setAvailableLoading] = useState(false);
  const [ordering, setOrdering] = useState<string | null>(null);   // report_type being ordered
  const [makePickerOpen, setMakePickerOpen] = useState(false);
  const [makeQuery, setMakeQuery] = useState("");
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  // Result / view-order mode — if `orderId` was passed we're viewing
  // a previously completed order rather than starting a new one.
  const [viewOrder, setViewOrder] = useState<any | null>(null);
  const [viewLoading, setViewLoading] = useState(false);

  // Load makes on mount.
  useEffect(() => {
    (async () => {
      try {
        const r = await apiFetch("/api/vin-reports/makes");
        if (Array.isArray(r?.makes)) setMakes(r.makes);
      } catch (e) {
        console.warn("makes load:", e);
      }
    })();
  }, []);

  // If entered with an orderId, fetch and display that order in read-only mode.
  useEffect(() => {
    if (!params?.orderId) return;
    setViewLoading(true);
    (async () => {
      try {
        const r = await apiFetch(`/api/vin-reports/${params.orderId}`);
        setViewOrder(r?.order || null);
      } catch (e) {
        console.warn("order fetch failed:", e);
      } finally {
        setViewLoading(false);
      }
    })();
  }, [params?.orderId]);

  // Load available reports whenever make changes.
  useEffect(() => {
    if (!selectedMake) { setAvailable([]); return; }
    let cancelled = false;
    setAvailableLoading(true);
    (async () => {
      try {
        const r = await apiFetch(`/api/vin-reports/available?make=${encodeURIComponent(selectedMake)}`);
        if (!cancelled && Array.isArray(r?.reports)) setAvailable(r.reports);
      } catch (e) {
        console.warn("available load:", e);
      } finally {
        if (!cancelled) setAvailableLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedMake]);

  // Consume any scan-buffer left by /scan (returnPath=vinReports).
  useFocusEffect(useCallback(() => {
    (async () => {
      try {
        const buf = await storage.getItem<string>(SCAN_BUFFER_KEY, "");
        if (!buf) return;
        // Try to decode the license-disk barcode first so we can also
        // auto-fill the make. Falls back to using the raw scan as a VIN
        // if it isn't a full PDF-417 payload (e.g. QR-only OCR result).
        try {
          const parsed = decodeLicenseDisk(buf);
          if (parsed?.vin) {
            setVin(parsed.vin.toUpperCase());
            if (parsed.make && !selectedMake) {
              // Case-normalise so we match a make in our list. Try a
              // fuzzy match first — the license disc encodes short-form
              // makes (e.g. "TOYOTA") whereas our list uses title-case.
              const target = String(parsed.make).trim();
              const found = makes.find((m) => m.toUpperCase() === target.toUpperCase());
              if (found) setSelectedMake(found);
            }
            setScanNotice(`License disc decoded — VIN ${parsed.vin.toUpperCase()}`);
          } else if (buf.length >= 6 && buf.length <= 25) {
            setVin(buf.toUpperCase());
            setScanNotice(`VIN captured from scan.`);
          }
        } catch {
          if (buf.length >= 6 && buf.length <= 25) {
            setVin(buf.toUpperCase());
            setScanNotice(`VIN captured from scan.`);
          }
        }
        await storage.removeItem(SCAN_BUFFER_KEY);
        await storage.removeItem(SCAN_PARSED_KEY);
      } catch { /* no-op */ }
    })();
  }, [makes, selectedMake]));

  const filteredMakes = useMemo(() => {
    if (!makeQuery.trim()) return makes;
    const q = makeQuery.toLowerCase();
    return makes.filter((m) => m.toLowerCase().includes(q));
  }, [makes, makeQuery]);

  const openScanner = () => {
    router.push({ pathname: "/(app)/scan", params: { returnPath: "vinReports" } } as any);
  };

  const orderReport = async (entry: ReportEntry) => {
    if (!vin || vin.trim().length < 6) {
      Alert.alert("VIN required", "Please enter or scan a valid VIN before ordering a report.");
      return;
    }
    setOrdering(entry.id);
    try {
      const r = await apiFetch("/api/vin-reports/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          make: selectedMake,
          vin: vin.trim().toUpperCase(),
          report_type: entry.id,
        }),
      });
      const orderId = r?.order?.id;
      const cost = entry.cost_zar || 0;
      if (Platform.OS === "web") {
        (globalThis as any).alert?.(cost > 0
          ? `Report ordered — you were billed R${cost}.`
          : `Report ordered — no charge for this report.`);
      } else {
        Alert.alert(
          "Report ready",
          cost > 0 ? `Order complete — you were billed R${cost}.` : "Order complete — no charge for this report."
        );
      }
      if (orderId) {
        router.replace({ pathname: "/(app)/vin-reports/new", params: { orderId } } as any);
      } else {
        router.replace("/(app)/vin-reports" as any);
      }
    } catch (e: any) {
      const msg = String(e?.message || e || "Order failed.");
      Alert.alert("Order failed", msg);
    } finally {
      setOrdering(null);
    }
  };

  // -------------------------------------------------------------------
  // READ-ONLY view mode for an existing order.
  // -------------------------------------------------------------------
  if (params?.orderId) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={["top"]}>
        <ScreenBackButton />
        <ScrollView contentContainerStyle={{ padding: spacing.md, paddingBottom: 96 }}>
          {viewLoading ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
          ) : !viewOrder ? (
            <Text style={{ color: colors.textSecondary, textAlign: "center" }}>Order not found.</Text>
          ) : (
            <View>
              <Text style={styles.title}>{viewOrder.report_label || viewOrder.report_type}</Text>
              <Text style={styles.subtitle}>
                {(viewOrder.make || "").toUpperCase()} · VIN {viewOrder.vin}
              </Text>
              <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.card, marginTop: spacing.md }]}>
                <View style={styles.kvRow}>
                  <Text style={styles.kvLabel}>Status</Text>
                  <Text style={[styles.kvValue, { color:
                    viewOrder.status === "completed" ? colors.success :
                    viewOrder.status === "failed"    ? colors.danger  :
                    colors.warning }]}>
                    {(viewOrder.status || "").toUpperCase()}
                  </Text>
                </View>
                <View style={styles.kvRow}>
                  <Text style={styles.kvLabel}>Ordered</Text>
                  <Text style={styles.kvValue}>
                    {viewOrder.ordered_at ? new Date(viewOrder.ordered_at).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" } as any) : "—"}
                  </Text>
                </View>
                <View style={styles.kvRow}>
                  <Text style={styles.kvLabel}>Cost</Text>
                  <Text style={styles.kvValue}>{viewOrder.cost_zar ? `R${viewOrder.cost_zar}` : "Free"}</Text>
                </View>
              </View>

              {viewOrder.status === "failed" ? (
                <View style={[styles.card, { borderColor: colors.danger + "77", backgroundColor: colors.danger + "12", marginTop: spacing.md }]}>
                  <Text style={{ color: colors.danger, fontWeight: "700", marginBottom: 6 }}>Report failed</Text>
                  <Text style={{ color: colors.text, fontSize: 13, lineHeight: 19 }}>
                    {viewOrder.error || "The vendor returned no data for this VIN."}
                  </Text>
                </View>
              ) : viewOrder.status === "completed" ? (
                <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.card, marginTop: spacing.md }]}>
                  <Text style={{ color: colors.textSecondary, fontSize: 11, letterSpacing: 1.2, fontWeight: "800", textTransform: "uppercase", marginBottom: 8 }}>
                    Report payload
                  </Text>
                  <ResultBody data={viewOrder.result_data} reportType={viewOrder.report_type} colors={colors} />
                </View>
              ) : (
                <Text style={{ color: colors.textSecondary, textAlign: "center", marginTop: spacing.md }}>
                  Order is still pending. Pull down to refresh.
                </Text>
              )}
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // -------------------------------------------------------------------
  // NEW ORDER form.
  // -------------------------------------------------------------------
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={["top"]}>
      <ScreenBackButton />
      <ScrollView contentContainerStyle={{ padding: spacing.md, paddingBottom: 96 }}>
        <Text style={styles.title}>New VIN Report</Text>
        <Text style={styles.subtitle}>
          Pick a make, scan or type the VIN, then choose the report you want to order. You&apos;ll be billed the shown fee only if the vendor returns data.
        </Text>

        {/* STEP 1 — Make */}
        <Text style={styles.stepLabel}>1. MAKE</Text>
        <TouchableOpacity
          testID="vin-reports-make-select"
          style={styles.selectBox}
          onPress={() => { setMakeQuery(""); setMakePickerOpen(true); }}
          activeOpacity={0.85}
        >
          <Text style={[styles.selectVal, { color: selectedMake ? colors.text : colors.textSecondary }]}>
            {selectedMake || "Choose a make"}
          </Text>
          <Ionicons name="chevron-down" size={18} color={colors.textSecondary} />
        </TouchableOpacity>

        {/* STEP 2 — VIN */}
        <Text style={[styles.stepLabel, { marginTop: spacing.md }]}>2. VIN</Text>
        <View style={styles.vinRow}>
          <TextInput
            testID="vin-reports-vin-input"
            style={styles.vinInput}
            value={vin}
            onChangeText={(t) => setVin(t.toUpperCase())}
            placeholder="Enter VIN"
            placeholderTextColor={colors.textDisabled}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={25}
          />
          <TouchableOpacity
            testID="vin-reports-scan"
            style={[styles.scanBtn, { borderColor: colors.border }]}
            onPress={openScanner}
            activeOpacity={0.85}
          >
            <Ionicons name="qr-code-outline" size={18} color={colors.text} />
            <Text style={[styles.scanBtnTxt, { color: colors.text }]}>Scan Disk</Text>
          </TouchableOpacity>
        </View>
        {scanNotice ? (
          <Text style={{ color: colors.success, fontSize: 12, marginTop: 4 }}>{scanNotice}</Text>
        ) : null}

        {/* STEP 3 — Report picker */}
        <Text style={[styles.stepLabel, { marginTop: spacing.md }]}>3. AVAILABLE REPORTS</Text>
        {!selectedMake ? (
          <View style={[styles.emptyBox, { borderColor: colors.border }]}>
            <Ionicons name="alert-circle-outline" size={22} color={colors.textDisabled} />
            <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 4 }}>
              Choose a make above to see which reports are available.
            </Text>
          </View>
        ) : availableLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.md }} />
        ) : available.length === 0 ? (
          <View style={[styles.emptyBox, { borderColor: colors.border }]}>
            <Ionicons name="alert-circle-outline" size={22} color={colors.textDisabled} />
            <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 4 }}>
              No reports available for this make yet.
            </Text>
          </View>
        ) : (
          available.map((r) => (
            <TouchableOpacity
              key={r.id}
              testID={`vin-reports-order-${r.id}`}
              disabled={ordering !== null || !vin.trim()}
              style={[
                styles.reportRow,
                { borderColor: colors.border, backgroundColor: colors.card, opacity: (!vin.trim() || (ordering && ordering !== r.id)) ? 0.55 : 1 },
              ]}
              onPress={() => orderReport(r)}
              activeOpacity={0.85}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.reportLbl}>{r.label}</Text>
                <Text style={styles.reportSub}>{r.blurb}</Text>
              </View>
              <View style={{ alignItems: "flex-end", gap: 6, marginLeft: 8 }}>
                <View style={[styles.costChip, { borderColor: colors.primary + "77", backgroundColor: colors.primary + "18" }]}>
                  <Text style={[styles.costChipTxt, { color: colors.primary }]}>
                    {r.cost_zar > 0 ? `R${r.cost_zar}` : "FREE"}
                  </Text>
                </View>
                {ordering === r.id ? (
                  <ActivityIndicator color={colors.primary} size="small" />
                ) : (
                  <Ionicons name="arrow-forward-circle" size={22} color={colors.primary} />
                )}
              </View>
            </TouchableOpacity>
          ))
        )}
      </ScrollView>

      {/* MAKE PICKER — full-screen modal with a search input. */}
      <Modal visible={makePickerOpen} animationType="slide" transparent={false}>
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={["top"]}>
          <View style={styles.pickerHead}>
            <TouchableOpacity onPress={() => setMakePickerOpen(false)} style={{ padding: 6 }}>
              <Ionicons name="close" size={22} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.pickerTitle}>Choose a make</Text>
            <View style={{ width: 22 }} />
          </View>
          <View style={{ paddingHorizontal: spacing.md }}>
            <View style={[styles.searchBox, { borderColor: colors.border, backgroundColor: colors.card }]}>
              <Ionicons name="search-outline" size={16} color={colors.textSecondary} />
              <TextInput
                style={{ flex: 1, color: colors.text, fontSize: 15 }}
                placeholder="Search makes…"
                placeholderTextColor={colors.textDisabled}
                value={makeQuery}
                onChangeText={setMakeQuery}
                autoFocus
              />
            </View>
          </View>
          <ScrollView contentContainerStyle={{ padding: spacing.md, paddingBottom: 96 }}>
            {filteredMakes.map((m) => (
              <TouchableOpacity
                key={m}
                style={[styles.makeItem, { borderColor: colors.border, backgroundColor: colors.card }]}
                onPress={() => { setSelectedMake(m); setMakePickerOpen(false); }}
              >
                <Text style={{ color: colors.text, fontSize: 15, fontWeight: "700" }}>{m}</Text>
                {selectedMake === m ? (
                  <Ionicons name="checkmark-circle" size={20} color={colors.primary} />
                ) : null}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// ResultBody — a lightweight preview of the vendor payload. Full PDF /
// pretty rendering will land in Phase 2 — for now we surface the JSON
// keys so the dealer can confirm the data actually arrived.
// ---------------------------------------------------------------------------
function ResultBody({ data, reportType, colors }: { data: any; reportType?: string; colors: Palette }) {
  if (!data) {
    return <Text style={{ color: colors.textSecondary, fontSize: 13 }}>No result payload.</Text>;
  }
  // Type-specific quick summaries so the dealer sees something useful.
  if (reportType === "vin_history") {
    const claims = Array.isArray(data.claims) ? data.claims : [];
    return (
      <View style={{ gap: 6 }}>
        <Text style={{ color: colors.text, fontSize: 15, fontWeight: "800" }}>
          {claims.length} claim{claims.length === 1 ? "" : "s"} on file
        </Text>
        {claims.length === 0 ? (
          <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
            No accident / claim history recorded for this VIN.
          </Text>
        ) : claims.slice(0, 10).map((c: any, i: number) => (
          <View key={i} style={{ paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border }}>
            <Text style={{ color: colors.text, fontSize: 13, fontWeight: "700" }}>
              {c.accident_date || c.creation_date || "Undated"}
            </Text>
            <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
              {c.manufacturer || ""} {c.model || ""}
              {c.mileage_at_claim ? ` · ${Number(c.mileage_at_claim).toLocaleString()} km` : ""}
            </Text>
            {c.damage_locations?.length ? (
              <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                Damage: {c.damage_locations.join(", ")}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
    );
  }
  // Bimmervin, MBTools, Outvin — surface a short summary + option count.
  const options = data?.options || data?.factory_options || data?.equipment || [];
  const summary = data?.summary || data?.header || data?.vehicle || {};
  return (
    <View style={{ gap: 8 }}>
      {Object.entries(summary).slice(0, 8).map(([k, v]) => (
        <View key={k} style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={{ color: colors.textSecondary, fontSize: 12, fontWeight: "700" }}>{k}</Text>
          <Text style={{ color: colors.text, fontSize: 12, fontWeight: "700", marginLeft: 8, flex: 1, textAlign: "right" }} numberOfLines={2}>
            {String(v ?? "—")}
          </Text>
        </View>
      ))}
      {Array.isArray(options) && options.length ? (
        <Text style={{ color: colors.success, fontSize: 13, fontWeight: "800", marginTop: 4 }}>
          {options.length} factory option{options.length === 1 ? "" : "s"} decoded ✓
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "800",
    letterSpacing: -0.4,
    marginBottom: 4,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: spacing.md,
  },
  stepLabel: {
    color: colors.textSecondary,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    fontWeight: "800",
    marginBottom: 6,
  },
  selectBox: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  selectVal: {
    fontSize: 15,
    fontWeight: "700",
  },
  vinRow: {
    flexDirection: "row",
    gap: 8,
  },
  vinInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  scanBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderRadius: radius.md,
  },
  scanBtnTxt: {
    fontSize: 13,
    fontWeight: "700",
  },
  emptyBox: {
    borderWidth: 1,
    borderStyle: "dashed" as const,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: "center",
    gap: 4,
  },
  reportRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderWidth: 1,
    borderRadius: radius.md,
    marginTop: 8,
  },
  reportLbl: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: -0.1,
  },
  reportSub: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
    lineHeight: 17,
  },
  costChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  costChipTxt: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.4,
  },

  // Modal picker
  pickerHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  pickerTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "800",
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: spacing.sm,
  },
  makeItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 14,
    borderWidth: 1,
    borderRadius: radius.md,
    marginBottom: 8,
  },
  card: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 14,
    gap: 8,
  },
  kvRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  kvLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase" as const,
  },
  kvValue: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "800",
  },
});
