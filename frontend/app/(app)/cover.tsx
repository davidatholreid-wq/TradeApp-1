/**
 * Give Cover — pricing-agent workspace.
 *
 * Two-tab layout:
 *   • Cars available to cover   — blind submissions the agent hasn't
 *     yet covered. Each card shows a real photo thumbnail.
 *   • Cover given               — the agent's own binding covers so
 *     far. Tap into any of them to update the cover (each update
 *     bills another R10). Ordered by most-recent update.
 *
 * List rows navigate directly to /vehicle/{id}?cover=1 so the vehicle
 * detail loads inline (no double-hop through /cover/[id] which was
 * causing a flash-of-white on some devices).
 */
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator,
  Image, RefreshControl, Platform, useWindowDimensions,
} from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Swipeable } from "react-native-gesture-handler";
import { useRouter, useLocalSearchParams, useFocusEffect } from "expo-router";
import ScreenBackButton from "@/src/components/ScreenBackButton";
import { CoverOfferTermsButton } from "@/src/components/CoverOfferTerms";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets, SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "@/src/context/AuthContext";
import { apiFetch } from "@/src/api";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useThemeColors } from "@/src/theme/ThemeContext";
import { spacing, radius, fonts } from "@/src/theme";

type CoverSub = {
  id: string;
  reference?: string;
  make_name?: string;
  model_name?: string;
  derivative_name?: string;
  year_of_production?: number;
  year_registered?: number;
  mileage?: number;
  thumbnail?: string | null;
  photos?: any;
  fuel_type?: string;
  transmission?: string;
  status?: string;
  my_cover?: {
    price_zar: number;
    created_at: string;
    updated_at?: string;
    history?: { price_zar: number; at: string }[];
  } | null;
  // Only present on rows returned from the declined-silo endpoint.
  declined_at?: string;
};

type Tab = "available" | "given" | "declined";

export default function GiveCoverScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ tab?: string }>();
  const { user } = useAuth();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  // Web-only list/grid toggle — mirrors the toolbar in `submissions.tsx`.
  // The user's choice (mode + column count) is persisted to
  // AsyncStorage so it sticks across sessions and matches how they've
  // already configured the My Vehicles list.
  const canUseGrid = Platform.OS === "web" && width >= 700;
  const [viewMode, setViewMode] = useState<"list" | "grid">(
    canUseGrid ? "grid" : "list",
  );
  const [gridColumnsPref, setGridColumnsPref] = useState<3 | 6>(3);
  useEffect(() => {
    (async () => {
      try {
        const savedMode = await AsyncStorage.getItem("cover.viewMode");
        if ((savedMode === "list" || savedMode === "grid") && canUseGrid) {
          setViewMode(savedMode);
        }
        const savedCols = await AsyncStorage.getItem("cover.gridColumns");
        const n = Number(savedCols);
        if (n === 3 || n === 6) setGridColumnsPref(n as 3 | 6);
      } catch {}
    })();
  }, [canUseGrid]);
  const setViewModePersist = useCallback((next: "list" | "grid") => {
    setViewMode(next);
    AsyncStorage.setItem("cover.viewMode", next).catch(() => {});
  }, []);
  const setGridColumnsPrefPersist = useCallback((next: 3 | 6) => {
    setGridColumnsPref(next);
    AsyncStorage.setItem("cover.gridColumns", String(next)).catch(() => {});
  }, []);

  // Actual number of columns rendered — 6 needs a wide viewport, else
  // fall back to 3.
  const isWebGrid = canUseGrid && viewMode === "grid";
  const gridColumns =
    isWebGrid && gridColumnsPref === 6 && width >= 1500 ? 6 : 3;
  const [subs, setSubs] = useState<CoverSub[]>([]);
  const [declinedSubs, setDeclinedSubs] = useState<CoverSub[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>(
    params?.tab === "given"
      ? "given"
      : params?.tab === "declined"
        ? "declined"
        : "available"
  );

  // Sync tab whenever the incoming ?tab= param changes — e.g. the
  // back-arrow on a covered vehicle detail returns via
  // /cover?tab=given so the pricing agent lands back on the same
  // list they came from.
  useEffect(() => {
    if (
      params?.tab === "given" ||
      params?.tab === "available" ||
      params?.tab === "declined"
    ) {
      setTab(params.tab as Tab);
    }
  }, [params?.tab]);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    // `silent` — used by the on-focus refresh and interval polling. We
    // don't flip the loading spinner in those cases so the UI doesn't
    // flash when new data arrives.
    if (!opts?.silent) setLoading(true);
    try {
      // Load the primary list AND the declined silo in parallel. Both
      // are cheap indexed queries and this keeps the tab counters
      // accurate no matter which tab the agent is currently on.
      const [primary, declined] = await Promise.all([
        apiFetch("/api/cover/submissions"),
        apiFetch("/api/cover/declined-submissions"),
      ]);
      setSubs((primary as any).submissions || []);
      setDeclinedSubs((declined as any).submissions || []);
    } catch (e) {
      console.warn("cover load failed", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Auto-refresh whenever the tab regains focus (e.g. after the
  // pricing agent places a cover on a vehicle detail and taps back).
  // Also polls silently every 30 s while the tab is focused so the
  // "Incoming" list picks up brand-new submissions without the
  // dealer having to pull-to-refresh or reload the browser.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useFocusEffect(
    useCallback(() => {
      load({ silent: true });
      pollRef.current = setInterval(() => {
        load({ silent: true });
      }, 30_000);
      return () => {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      };
    }, [load])
  );

  const available = useMemo(() => subs.filter((s) => !s.my_cover), [subs]);
  const given = useMemo(
    () => subs.filter((s) => s.my_cover)
      .sort((a, b) => (
        (b.my_cover?.updated_at || b.my_cover?.created_at || "") <
        (a.my_cover?.updated_at || a.my_cover?.created_at || "") ? -1 : 1
      )),
    [subs],
  );
  const shown =
    tab === "available"
      ? available
      : tab === "given"
        ? given
        : declinedSubs;

  // Swipe-to-decline (iOS style) — the agent swipes a row on the
  // "Available" tab to permanently hide it from THEIR view. The
  // submission stays available to every other pricing agent. We show
  // an in-app Undo snackbar for a few seconds so an accidental swipe
  // is instantly recoverable.
  const [undoState, setUndoState] = useState<{ subId: string; label: string } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openSwipeRef = useRef<Swipeable | null>(null);

  const clearUndoTimer = () => {
    if (undoTimer.current) {
      clearTimeout(undoTimer.current);
      undoTimer.current = null;
    }
  };

  const handleDecline = useCallback(async (sub: CoverSub) => {
    // Optimistic remove from primary list AND add to declined silo so
    // both tab counters update immediately.
    setSubs((prev) => prev.filter((s) => s.id !== sub.id));
    const decliedRow: CoverSub = { ...sub, declined_at: new Date().toISOString() };
    setDeclinedSubs((prev) =>
      prev.some((s) => s.id === sub.id) ? prev : [decliedRow, ...prev]
    );
    const label = [sub.reference, sub.make_name, sub.derivative_name || sub.model_name]
      .filter(Boolean)
      .join(" · ");
    setUndoState({ subId: sub.id, label });
    clearUndoTimer();
    undoTimer.current = setTimeout(() => setUndoState(null), 5000);
    try {
      await apiFetch(`/api/cover/submissions/${sub.id}/decline`, { method: "POST" });
    } catch (e) {
      console.warn("decline failed — rolling back", e);
      setSubs((prev) => (prev.some((p) => p.id === sub.id) ? prev : [sub, ...prev]));
      setDeclinedSubs((prev) => prev.filter((s) => s.id !== sub.id));
      setUndoState(null);
    }
  }, []);

  const handleUndoDecline = useCallback(async () => {
    const target = undoState;
    if (!target) return;
    clearUndoTimer();
    setUndoState(null);
    // Optimistically remove from silo — the sub will re-appear in the
    // primary list via the reload.
    setDeclinedSubs((prev) => prev.filter((s) => s.id !== target.subId));
    try {
      await apiFetch(`/api/cover/submissions/${target.subId}/decline`, { method: "DELETE" });
      load({ silent: true });
    } catch (e) {
      console.warn("undo decline failed", e);
      // On failure, re-hydrate everything so the UI is truthful.
      load({ silent: true });
    }
  }, [undoState, load]);

  /**
   * Restore a previously-declined submission back into the available
   * queue. Used by the "Restore" action on the Declined silo (both the
   * button and the right-swipe gesture). Optimistic: the row is
   * removed from the silo immediately, and we let the next load()
   * refresh the primary list so the sub reappears there.
   */
  const handleRestore = useCallback(async (sub: CoverSub) => {
    setDeclinedSubs((prev) => prev.filter((s) => s.id !== sub.id));
    try {
      await apiFetch(`/api/cover/submissions/${sub.id}/decline`, { method: "DELETE" });
      load({ silent: true });
    } catch (e) {
      console.warn("restore failed — rolling back", e);
      // Roll back — put the row back in the silo.
      setDeclinedSubs((prev) => (prev.some((p) => p.id === sub.id) ? prev : [sub, ...prev]));
    }
  }, [load]);

  if (!user?.is_pricing_agent) {
    return (
      <View style={[styles.blockedWrap, { backgroundColor: colors.bg }]}>
        <Ionicons name="lock-closed-outline" size={36} color={colors.textDisabled} />
        <Text style={[styles.blockedTitle, { color: colors.text }]}>Managerial access only</Text>
        <Text style={[styles.blockedSub, { color: colors.textSecondary }]}>
          Ask a Fourbuy admin to enable pricing-agent permissions on your account.
        </Text>
      </View>
    );
  }

  const scrollContent = (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={{
        padding: spacing.md,
        paddingTop: spacing.md,
        paddingBottom: 80,
      }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => { setRefreshing(true); load(); }}
          tintColor={colors.primary}
        />
      }
    >
      {/* Header — simple, single-line title. Sits below the notch/status
          bar so it never gets clipped on device. */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={[styles.heading, { color: colors.text }]}>Give Cover</Text>
        {/* Cover T&Cs — pricing agents can review the full Subject-to-
            View Cover Offer terms before placing / reviewing covers. */}
        <CoverOfferTermsButton compact />
      </View>

      {/* Tab switch — Available / Cover given / Declined. Horizontally
          scrollable on narrow screens so all three pills fit even on
          smaller phones. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabRow}
      >
        <TouchableOpacity
          testID="cover-tab-available"
          style={[
            styles.tabBtn,
            { borderColor: colors.border, backgroundColor: colors.card },
            tab === "available" && { borderColor: colors.primary, borderWidth: 2 },
          ]}
          onPress={() => setTab("available")}
        >
          <Ionicons
            name="car-sport-outline"
            size={15}
            color={tab === "available" ? colors.text : colors.textSecondary}
          />
          <Text
            numberOfLines={1}
            style={[
              styles.tabBtnText,
              { color: tab === "available" ? colors.text : colors.textSecondary },
            ]}
          >
            Available · {available.length}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="cover-tab-given"
          style={[
            styles.tabBtn,
            { borderColor: colors.border, backgroundColor: colors.card },
            tab === "given" && { borderColor: colors.primary, borderWidth: 2 },
          ]}
          onPress={() => setTab("given")}
        >
          <Ionicons
            name="checkmark-done-outline"
            size={15}
            color={tab === "given" ? colors.text : colors.textSecondary}
          />
          <Text
            numberOfLines={1}
            style={[
              styles.tabBtnText,
              { color: tab === "given" ? colors.text : colors.textSecondary },
            ]}
          >
            Cover given · {given.length}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="cover-tab-declined"
          style={[
            styles.tabBtn,
            { borderColor: colors.border, backgroundColor: colors.card },
            tab === "declined" && { borderColor: colors.danger, borderWidth: 2 },
          ]}
          onPress={() => setTab("declined")}
        >
          <Ionicons
            name="archive-outline"
            size={15}
            color={tab === "declined" ? colors.text : colors.textSecondary}
          />
          <Text
            numberOfLines={1}
            style={[
              styles.tabBtnText,
              { color: tab === "declined" ? colors.text : colors.textSecondary },
            ]}
          >
            Declined · {declinedSubs.length}
          </Text>
        </TouchableOpacity>
      </ScrollView>

      {/* How Give Cover works — friendlier callout block with icon + bullets.
          Sits below the tabs so the primary action (switching tabs) is
          reached first and the explainer is available on demand. */}
      <View style={[styles.explainerCard, { backgroundColor: colors.card, borderColor: colors.primary + "55" }]}>
        <View style={styles.explainerHeader}>
          <View style={[styles.explainerIcon, { backgroundColor: colors.primary + "22", borderColor: colors.primary + "88" }]}>
            <Ionicons name="shield-checkmark" size={18} color={colors.primary} />
          </View>
          <Text style={[styles.explainerTitle, { color: colors.text }]}>How Give Cover works</Text>
        </View>
        <View style={styles.explainerBulletRow}>
          <Ionicons name="pricetag-outline" size={13} color={colors.textSecondary} />
          <Text style={[styles.explainerBullet, { color: colors.textSecondary }]}>
            <Text style={{ color: colors.text, fontWeight: "700" }}>R10</Text> billed once per submission when you place a cover. Updates are free.
          </Text>
        </View>
        <View style={styles.explainerBulletRow}>
          <Ionicons name="lock-closed-outline" size={13} color={colors.textSecondary} />
          <Text style={[styles.explainerBullet, { color: colors.textSecondary }]}>
            Your cover is <Text style={{ color: colors.text, fontWeight: "700" }}>binding</Text> subject to physical inspection of the vehicle.
          </Text>
        </View>
        <View style={styles.explainerBulletRow}>
          <Ionicons name="repeat-outline" size={13} color={colors.textSecondary} />
          <Text style={[styles.explainerBullet, { color: colors.textSecondary }]}>
            Change your mind? Open any car in <Text style={{ color: colors.text, fontWeight: "700" }}>Cover given</Text> and update your price — no extra charge.
          </Text>
        </View>
      </View>

      {/* View toggle toolbar (List / Grid + 3/6 cols) — only rendered
          when a grid layout is actually usable at the current viewport.
          Mirrors the toolbar in My Vehicles so users get a consistent
          mental model. Persisted per browser via AsyncStorage. */}
      {canUseGrid ? (
        <View style={styles.viewToolbar} testID="cover-view-toolbar">
          <View style={[styles.viewToggle, { borderColor: colors.border }]}>
            <TouchableOpacity
              testID="cover-view-toggle-list"
              onPress={() => setViewModePersist("list")}
              activeOpacity={0.85}
              style={[
                styles.viewToggleBtn,
                viewMode === "list" && { backgroundColor: colors.primary + "22" },
              ]}
            >
              <Ionicons
                name="list"
                size={16}
                color={viewMode === "list" ? colors.primary : colors.textSecondary}
              />
              <Text
                style={[
                  styles.viewToggleText,
                  { color: viewMode === "list" ? colors.primary : colors.textSecondary },
                ]}
              >
                List
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="cover-view-toggle-grid"
              onPress={() => setViewModePersist("grid")}
              activeOpacity={0.85}
              style={[
                styles.viewToggleBtn,
                viewMode === "grid" && { backgroundColor: colors.primary + "22" },
              ]}
            >
              <Ionicons
                name="grid"
                size={16}
                color={viewMode === "grid" ? colors.primary : colors.textSecondary}
              />
              <Text
                style={[
                  styles.viewToggleText,
                  { color: viewMode === "grid" ? colors.primary : colors.textSecondary },
                ]}
              >
                Grid
              </Text>
            </TouchableOpacity>
          </View>
          {viewMode === "grid" ? (
            <View style={[styles.viewToggle, { borderColor: colors.border }]}>
              {([3, 6] as const).map((n) => {
                const disabled = n === 6 && width < 1500;
                const active = gridColumns === n;
                return (
                  <TouchableOpacity
                    key={n}
                    testID={`cover-grid-cols-${n}`}
                    onPress={() => !disabled && setGridColumnsPrefPersist(n)}
                    activeOpacity={disabled ? 1 : 0.85}
                    style={[
                      styles.viewToggleBtn,
                      active && { backgroundColor: colors.primary + "22" },
                      disabled && { opacity: 0.4 },
                    ]}
                  >
                    <Text
                      style={[
                        styles.viewToggleText,
                        {
                          color: active ? colors.primary : colors.textSecondary,
                          fontWeight: "800",
                        },
                      ]}
                    >
                      {n} cols
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : null}
        </View>
      ) : null}

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
      ) : shown.length === 0 ? (
        <View style={[styles.emptyBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Ionicons
            name={
              tab === "available"
                ? "search-outline"
                : tab === "given"
                  ? "receipt-outline"
                  : "archive-outline"
            }
            size={30}
            color={colors.textDisabled}
          />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>
            {tab === "available"
              ? "No submissions to cover"
              : tab === "given"
                ? "No covers placed yet"
                : "No declined submissions"}
          </Text>
          <Text style={{ color: colors.textSecondary, textAlign: "center", fontSize: 12 }}>
            {tab === "available"
              ? "Pull to refresh — new submissions land here as dealers submit them."
              : tab === "given"
                ? "Head to Available to place your first binding cover."
                : "Anything you swipe away from Available lands here. Swipe right on a card to restore it."}
          </Text>
        </View>
      ) : (
        <View style={isWebGrid ? styles.gridContainer : undefined}>
          {shown.map((s) => {
          const thumb = s.thumbnail;
          const year = s.year_of_production ?? s.year_registered;
          const meta = [
            year,
            s.mileage ? `${s.mileage.toLocaleString()} km` : null,
            s.fuel_type,
            s.transmission,
          ].filter(Boolean).join(" · ");
          const covered = !!s.my_cover;
          const historyCount = (s.my_cover?.history || []).length;
          const isDeclinedTab = tab === "declined";

          // Human-friendly "declined X ago" for the silo row footer.
          const declinedAgo = (() => {
            if (!s.declined_at) return null;
            const t = new Date(s.declined_at).getTime();
            if (isNaN(t)) return null;
            const diff = Date.now() - t;
            const mins = Math.round(diff / 60000);
            if (mins < 1) return "just now";
            if (mins < 60) return `${mins} min ago`;
            const hrs = Math.round(mins / 60);
            if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
            const days = Math.round(hrs / 24);
            return `${days} day${days === 1 ? "" : "s"} ago`;
          })();

          // ---------- WeBuyCars-style grid card (web only) ----------
          // Front photo on top, title + meta below, dedicated Offer /
          // Decline buttons at the bottom. Never uses a swipe gesture
          // — web has no reliable swipe UX. Cover-given cards show a
          // single "Update cover" CTA; Declined cards show a single
          // "Restore" CTA.
          if (isWebGrid) {
            const openVehicle = () =>
              router.push({
                pathname: "/vehicle/[id]",
                params: { id: s.id, cover: "1" },
              });
            // Vehicle title split into two lines everywhere in the app:
            //   • bold `titleLine`: year + make only (e.g. "2021 Land Rover")
            //   • lighter `subtitleLine`: derivative (falling back to model)
            // This avoids the previous duplication where derivative appeared
            // in both title and subtitle.
            const titleLine = [year, s.make_name].filter(Boolean).join(" ");
            const subtitleLine = s.derivative_name || s.model_name || "";
            const gridColWidth = `${(100 / gridColumns).toFixed(4)}%` as any;
            return (
              <View
                key={s.id}
                style={[styles.gridCol, { width: gridColWidth }]}
              >
                <View
                  testID={`cover-card-${s.id}`}
                  style={[
                    styles.gridCard,
                    { backgroundColor: colors.card, borderColor: colors.border },
                    covered && { borderColor: colors.success + "aa" },
                    isDeclinedTab && { opacity: 0.85 },
                  ]}
                >
                  {/* Front image — full-bleed at the top with WeBuyCars-
                      like 4:3 aspect ratio. Tapping the image jumps
                      straight into the vehicle detail (same as tapping
                      the row on mobile). */}
                  <TouchableOpacity
                    onPress={openVehicle}
                    activeOpacity={0.9}
                    style={styles.gridImgWrap}
                  >
                    {thumb ? (
                      <Image source={{ uri: thumb }} style={styles.gridImg} resizeMode="cover" />
                    ) : (
                      <View style={[styles.gridImg, styles.gridImgEmpty, { backgroundColor: colors.paper }]}>
                        <Ionicons name="car-outline" size={48} color={colors.textDisabled} />
                      </View>
                    )}
                    {/* Ref number badge sits on top of the image so the
                        primary reading area below stays clean. */}
                    <View style={styles.gridRefBadge}>
                      <Text style={styles.gridRefBadgeText}>{s.reference || s.id.slice(0, 8)}</Text>
                    </View>
                    {/* We used to overlay a "Cover · R{amount}" pill in
                        the top-right corner too, but the price is
                        already stated (much more legibly) in the
                        `YOUR COVER` row below the image, and the
                        overlay clashed with the dark thumbnails in
                        night mode. Skipping the duplicate. The
                        `Declined` state still gets an overlay pill
                        because the row below doesn't otherwise
                        signal the archived status. */}
                    {!covered && isDeclinedTab ? (
                      <View style={[styles.gridStatusBadge, { backgroundColor: colors.danger }]}>
                        <Ionicons name="archive" size={11} color="#fff" />
                        <Text style={styles.gridStatusBadgeText}>Declined</Text>
                      </View>
                    ) : null}
                  </TouchableOpacity>

                  {/* Text stack — bold title = year + make, lighter
                      subtitle = derivative (falling back to model). */}
                  <View style={styles.gridBody}>
                    <Text style={[styles.gridTitle, { color: colors.text }]} numberOfLines={2}>
                      {titleLine || "Vehicle"}
                    </Text>
                    {subtitleLine ? (
                      <Text style={[styles.gridDeriv, { color: colors.textSecondary }]} numberOfLines={2}>
                        {subtitleLine}
                      </Text>
                    ) : null}
                    <View style={styles.gridMetaRow}>
                      {s.mileage ? (
                        <View style={styles.gridMetaChip}>
                          <Ionicons name="speedometer-outline" size={11} color={colors.textSecondary} />
                          <Text style={[styles.gridMetaChipText, { color: colors.textSecondary }]}>
                            {s.mileage.toLocaleString()} km
                          </Text>
                        </View>
                      ) : null}
                      {s.transmission ? (
                        <View style={styles.gridMetaChip}>
                          <Ionicons name="cog-outline" size={11} color={colors.textSecondary} />
                          <Text style={[styles.gridMetaChipText, { color: colors.textSecondary }]}>
                            {s.transmission}
                          </Text>
                        </View>
                      ) : null}
                      {s.fuel_type ? (
                        <View style={styles.gridMetaChip}>
                          <Ionicons name="flame-outline" size={11} color={colors.textSecondary} />
                          <Text style={[styles.gridMetaChipText, { color: colors.textSecondary }]}>
                            {s.fuel_type}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    {isDeclinedTab && declinedAgo ? (
                      <Text style={[styles.gridFootnote, { color: colors.textDisabled }]}>
                        Declined {declinedAgo}
                      </Text>
                    ) : covered ? (
                      /* Cover-given card — show the cover PRICE as the
                         hero data point (green highlight chip) plus a
                         subtle "Placed / Updated" footnote below.
                         Tapping anywhere on the card opens the vehicle
                         detail where the price can be updated. The old
                         "Update cover" CTA has been removed at the
                         user's request. */
                      <View style={styles.gridCoveredBlock}>
                        <View
                          style={[
                            styles.gridCoveredChip,
                            { borderColor: colors.success + "66", backgroundColor: colors.success + "18" },
                          ]}
                        >
                          <Text
                            style={[styles.gridCoveredChipLabel, { color: colors.success }]}
                          >
                            YOUR COVER
                          </Text>
                          <Text
                            style={[styles.gridCoveredChipValue, { color: colors.success }]}
                          >
                            R {(s.my_cover?.price_zar || 0).toLocaleString()}
                          </Text>
                        </View>
                        <Text style={[styles.gridFootnote, { color: colors.textDisabled }]}>
                          {historyCount > 0
                            ? `Updated ${new Date(s.my_cover!.updated_at || s.my_cover!.created_at).toLocaleDateString()} · ${historyCount + 1} versions · tap to change`
                            : `Placed ${new Date(s.my_cover!.created_at).toLocaleDateString()} · tap to change`}
                        </Text>
                      </View>
                    ) : null}
                  </View>

                  {/* Action bar — Offer / Decline for available cards,
                      Restore for declined. Cover-given cards no longer
                      show an action bar — tapping the card itself opens
                      the vehicle detail where the cover price can be
                      updated. */}
                  <View style={styles.gridActionRow}>
                    {isDeclinedTab ? (
                      <TouchableOpacity
                        testID={`cover-grid-restore-${s.id}`}
                        onPress={() => handleRestore(s)}
                        style={[styles.gridBtn, styles.gridBtnFull, { backgroundColor: colors.success }]}
                        activeOpacity={0.85}
                      >
                        <Ionicons name="arrow-undo" size={14} color="#fff" />
                        <Text style={styles.gridBtnText}>Restore</Text>
                      </TouchableOpacity>
                    ) : covered ? null : (
                      <>
                        <TouchableOpacity
                          testID={`cover-grid-decline-${s.id}`}
                          onPress={() => handleDecline(s)}
                          style={[styles.gridBtn, styles.gridBtnGhost, { borderColor: colors.danger }]}
                          activeOpacity={0.85}
                        >
                          <Ionicons name="close" size={14} color={colors.danger} />
                          <Text style={[styles.gridBtnText, { color: colors.danger }]}>
                            Decline
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          testID={`cover-grid-offer-${s.id}`}
                          onPress={openVehicle}
                          style={[styles.gridBtn, styles.gridBtnPrimary, { backgroundColor: colors.primary }]}
                          activeOpacity={0.85}
                        >
                          <Ionicons name="flash" size={14} color={colors.onPrimary} />
                          <Text style={[styles.gridBtnText, { color: colors.onPrimary }]}>
                            Offer
                          </Text>
                        </TouchableOpacity>
                      </>
                    )}
                  </View>
                </View>
              </View>
            );
          }

          // iOS-style swipe-to-reveal-decline action rendered on the
          // RIGHT (finger swipes leftwards to reveal). Only offered on
          // the "Available" tab — we don't let the agent decline a
          // cover they've already placed. Unlike iOS Mail's "full
          // swipe auto-triggers" pattern, the user MUST tap the
          // revealed button to actually decline — swipe alone is
          // never destructive.
          const renderRightActions = () => (
            <View style={styles.declineActionWrap}>
              <TouchableOpacity
                testID={`cover-row-decline-action-${s.id}`}
                onPress={() => handleDecline(s)}
                style={[styles.declineAction, { backgroundColor: colors.danger }]}
                activeOpacity={0.85}
              >
                <Ionicons name="close-circle" size={20} color="#fff" />
                <Text style={styles.declineActionText}>Decline</Text>
              </TouchableOpacity>
            </View>
          );

          // Mirror swipe action for the Declined tab — swipe RIGHT to
          // reveal a "Restore" button that the user then taps.
          const renderLeftActions = () => (
            <View style={styles.restoreActionWrap}>
              <TouchableOpacity
                testID={`cover-row-restore-action-${s.id}`}
                onPress={() => handleRestore(s)}
                style={[styles.declineAction, { backgroundColor: colors.success }]}
                activeOpacity={0.85}
              >
                <Ionicons name="arrow-undo" size={20} color="#fff" />
                <Text style={styles.declineActionText}>Restore</Text>
              </TouchableOpacity>
            </View>
          );

          const cardInner = (
            <TouchableOpacity
              key={s.id}
              testID={`cover-row-${s.id}`}
              style={[
                styles.card,
                { backgroundColor: colors.card, borderColor: colors.border },
                covered && { borderColor: colors.success + "88" },
                isDeclinedTab && { opacity: 0.85 },
              ]}
              onPress={() =>
                router.push({
                  pathname: "/vehicle/[id]",
                  params: { id: s.id, cover: "1" },
                })
              }
              activeOpacity={0.85}
            >
              {thumb ? (
                <Image source={{ uri: thumb }} style={styles.thumb} resizeMode="cover" />
              ) : (
                <View style={[styles.thumb, styles.thumbEmpty, { backgroundColor: colors.paper }]}>
                  <Ionicons name="car-outline" size={30} color={colors.textDisabled} />
                </View>
              )}
              <View style={styles.cardBody}>
                <View style={styles.cardTopRow}>
                  <Text style={[styles.ref, { color: colors.textSecondary }]}>
                    {s.reference || s.id.slice(0, 8)}
                  </Text>
                  {isDeclinedTab ? (
                    <TouchableOpacity
                      testID={`cover-row-restore-${s.id}`}
                      onPress={(e) => {
                        e.stopPropagation?.();
                        handleRestore(s);
                      }}
                      style={[styles.pill, { backgroundColor: colors.success + "22" }]}
                      hitSlop={6}
                    >
                      <Ionicons name="arrow-undo" size={11} color={colors.success} />
                      <Text style={[styles.pillText, { color: colors.success }]}>Restore</Text>
                    </TouchableOpacity>
                  ) : covered ? (
                    <View style={[styles.pill, { backgroundColor: colors.success + "22" }]}>
                      <Ionicons name="shield-checkmark" size={11} color={colors.success} />
                      <Text style={[styles.pillText, { color: colors.success }]}>
                        R{s.my_cover!.price_zar.toLocaleString()}
                      </Text>
                    </View>
                  ) : (
                    <View style={[styles.pill, { backgroundColor: colors.primary + "22" }]}>
                      <Text style={[styles.pillText, { color: colors.primary }]}>Cover this</Text>
                    </View>
                  )}
                </View>
                <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
                  {[s.year, s.make_name].filter(Boolean).join(" ") || s.make_name || "Vehicle"}
                </Text>
                {s.derivative_name || s.model_name ? (
                  <Text style={[styles.deriv, { color: colors.textSecondary }]} numberOfLines={2}>
                    {s.derivative_name || s.model_name}
                  </Text>
                ) : null}
                {meta ? (
                  <Text style={[styles.meta, { color: colors.textDisabled }]}>{meta}</Text>
                ) : null}
                {isDeclinedTab && declinedAgo ? (
                  <Text style={[styles.updatedAt, { color: colors.textDisabled }]}>
                    Declined {declinedAgo}
                  </Text>
                ) : covered ? (
                  <Text style={[styles.updatedAt, { color: colors.textDisabled }]}>
                    {historyCount > 0
                      ? `Updated ${new Date(s.my_cover!.updated_at || s.my_cover!.created_at).toLocaleDateString()} · ${historyCount + 1} version${historyCount ? "s" : ""}`
                      : `Placed ${new Date(s.my_cover!.created_at).toLocaleDateString()}`}
                  </Text>
                ) : null}
              </View>
              {/* On WEB only: dedicated small "×" button on the Available
                  tab so the agent can decline without any gesture.
                  Native intentionally hides this — the swipe gesture
                  is the accepted UX there. */}
              {Platform.OS === "web" && tab === "available" ? (
                <TouchableOpacity
                  testID={`cover-row-decline-btn-${s.id}`}
                  onPress={(e) => {
                    e.stopPropagation?.();
                    handleDecline(s);
                  }}
                  style={[styles.webDeclineBtn, { borderColor: colors.danger + "55" }]}
                  hitSlop={6}
                  accessibilityLabel="Decline this cover opportunity"
                >
                  <Ionicons name="close" size={16} color={colors.danger} />
                </TouchableOpacity>
              ) : null}
              <Ionicons name="chevron-forward" size={20} color={colors.textDisabled} />
            </TouchableOpacity>
          );

          // Rendering rules per platform + tab:
          //   • Web              → NEVER wrap in Swipeable (uses the ×
          //                        button); Cover-given rows are static
          //                        as before.
          //   • Native Available → Wrap in Swipeable; swipe reveals the
          //                        red "Decline" button which the user
          //                        must TAP. Full swipe does NOT auto-
          //                        trigger.
          //   • Native Declined  → Wrap in Swipeable; swipe reveals the
          //                        green "Restore" button which the user
          //                        must TAP.
          //   • Native Given     → Not wrapped (no action available).
          if (Platform.OS === "web") return cardInner;
          if (covered) return cardInner;
          if (isDeclinedTab) {
            return (
              <Swipeable
                key={s.id}
                friction={2}
                leftThreshold={40}
                overshootLeft={false}
                renderLeftActions={renderLeftActions}
              >
                {cardInner}
              </Swipeable>
            );
          }
          return (
            <Swipeable
              key={s.id}
              friction={2}
              rightThreshold={40}
              overshootRight={false}
              renderRightActions={renderRightActions}
              onSwipeableWillOpen={() => {
                // Close any other open swipe row so only one shows its
                // action at a time (matches iOS Mail UX).
                if (openSwipeRef.current && (openSwipeRef.current as any)._id !== s.id) {
                  try { openSwipeRef.current.close(); } catch {}
                }
              }}
            >
              {cardInner}
            </Swipeable>
          );
          })}
        </View>
      )}
    </ScrollView>
  );

  // Bottom snackbar for Undo — mounted OUTSIDE the ScrollView so it
  // stays anchored while the list scrolls. We return a Fragment so
  // both siblings can be rendered.
  const undoBar = undoState ? (
    <View
      pointerEvents="box-none"
      style={[
        styles.snackbarWrap,
        { bottom: Math.max(insets.bottom, 12) + 16 },
      ]}
    >
      <View style={[styles.snackbar, { backgroundColor: colors.text }]}>
        <Ionicons name="checkmark-circle" size={16} color={colors.bg} />
        <Text style={[styles.snackbarText, { color: colors.bg }]} numberOfLines={1}>
          Removed {undoState.label ? `“${undoState.label}”` : "submission"}
        </Text>
        <TouchableOpacity
          testID="cover-decline-undo"
          onPress={handleUndoDecline}
          style={styles.snackbarBtn}
          hitSlop={8}
        >
          <Text style={[styles.snackbarBtnText, { color: colors.bg }]}>UNDO</Text>
        </TouchableOpacity>
      </View>
    </View>
  ) : null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={["top"]}>
      <ScreenBackButton />
      {scrollContent}
      {undoBar}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  heading: {
    fontSize: 20,
    fontWeight: "700",
    marginBottom: spacing.md,
  },
  subheading: { fontSize: 12, lineHeight: 17, marginBottom: spacing.md },
  // "How Give Cover works" explainer callout — sits below the tabs
  // to keep the primary control (Available / Given switch) at the top
  // while still surfacing the fee + rules to first-time users.
  explainerCard: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: 6,
  },
  explainerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 4,
  },
  explainerIcon: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: "center", justifyContent: "center",
    borderWidth: 1,
  },
  explainerTitle: {
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  explainerBulletRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingLeft: 2,
  },
  explainerBullet: {
    fontSize: 12,
    lineHeight: 17,
    flex: 1,
  },
  tabRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginBottom: spacing.md,
    alignItems: "center",
    // ScrollView's inner content sizes to its children — with no
    // flex:1 on the buttons each pill widens to fit its text on a
    // single line ("Cover given · 12" no longer wraps).
  },
  tabBtn: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  tabBtnText: {
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.2,
    // Explicit single line so long counts ("Cover given · 27") never
    // wrap onto two lines even in narrow containers.
    flexShrink: 0,
    whiteSpace: "nowrap" as any,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  thumb: {
    width: 96,
    height: 72,
    borderRadius: 10,
    backgroundColor: "#000",
  },
  thumbEmpty: { alignItems: "center", justifyContent: "center" },
  cardBody: { flex: 1, minWidth: 0 },
  cardTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 2,
    gap: spacing.sm,
  },
  ref: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.8,
    fontFamily: fonts.mono,
  },
  name: { fontSize: 15, fontWeight: "800" },
  deriv: { fontSize: 12, marginTop: 1 },
  meta: { fontSize: 11, marginTop: 4 },
  updatedAt: { fontSize: 10, marginTop: 6, fontStyle: "italic" },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  pillText: { fontSize: 11, fontWeight: "800" },
  blockedWrap: {
    flex: 1, alignItems: "center", justifyContent: "center",
    padding: spacing.xl, gap: spacing.sm,
  },
  blockedTitle: { fontSize: 17, fontWeight: "800" },
  blockedSub: { fontSize: 13, textAlign: "center" },
  emptyBox: {
    borderWidth: 1, borderRadius: radius.md, padding: spacing.xl,
    alignItems: "center", gap: spacing.sm,
  },
  emptyTitle: { fontSize: 14, fontWeight: "800", marginTop: 4 },

  // Swipe-to-decline action rendered on the RIGHT of the row when the
  // pricing agent drags leftwards.
  declineActionWrap: {
    justifyContent: "center",
    alignItems: "flex-end",
    marginBottom: spacing.sm,
  },
  restoreActionWrap: {
    justifyContent: "center",
    alignItems: "flex-start",
    marginBottom: spacing.sm,
  },

  // Small "×" icon button rendered on the RIGHT of each Available card
  // on WEB only (native uses the swipe gesture instead). Sits inside
  // the row's flexbox, right of the body text and just before the
  // chevron. Tap → decline. Border is a light danger tint so it looks
  // secondary next to the primary "Cover this" pill.
  webDeclineBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 4,
    ...(Platform.OS === "web" ? ({ cursor: "pointer" as any } as any) : {}),
  },

  // ---------- WeBuyCars-style grid (web only) ----------
  gridContainer: {
    flexDirection: "row",
    flexWrap: "wrap" as const,
    marginHorizontal: -8, // negative margin cancels the per-col padding
  },
  gridCol: {
    paddingHorizontal: 8,
    paddingBottom: 16,
  },
  gridCard: {
    borderRadius: radius.lg,
    borderWidth: 1,
    overflow: "hidden",
    // Full-height so cards in the same row line up regardless of
    // per-card content length (derivative, footnote, etc.).
    height: "100%",
    display: "flex" as any,
    flexDirection: "column",
    ...(Platform.OS === "web" ? ({
      transitionProperty: "transform, box-shadow, border-color" as any,
      transitionDuration: "180ms" as any,
    } as any) : {}),
  },
  gridImgWrap: {
    width: "100%",
    aspectRatio: 4 / 3,
    position: "relative" as any,
    ...(Platform.OS === "web" ? ({ cursor: "pointer" as any } as any) : {}),
  },
  gridImg: {
    width: "100%",
    height: "100%",
  },
  gridImgEmpty: {
    alignItems: "center",
    justifyContent: "center",
  },
  gridRefBadge: {
    position: "absolute" as any,
    top: 10,
    left: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  gridRefBadgeText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  gridStatusBadge: {
    position: "absolute" as any,
    top: 10,
    right: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
  },
  gridStatusBadgeText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "800",
  },
  gridBody: {
    padding: 12,
    gap: 4,
    flex: 1,
  },
  gridTitle: {
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: -0.2,
  },
  gridDeriv: {
    fontSize: 13,
    fontWeight: "600",
  },
  gridMetaRow: {
    flexDirection: "row",
    flexWrap: "wrap" as const,
    gap: 6,
    marginTop: 6,
  },
  gridMetaChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  gridMetaChipText: {
    fontSize: 11,
    fontWeight: "700",
  },
  gridFootnote: {
    fontSize: 11,
    fontStyle: "italic",
    marginTop: 6,
  },
  // -- "Your cover" price chip for cards on the Cover-given tab --
  // Shown INSIDE the card body (below the meta chips) so the agent
  // sees the price they placed at a glance without needing to open
  // the vehicle detail. A small footnote below reminds them the
  // whole card is tappable for changes.
  gridCoveredBlock: {
    marginTop: 8,
    gap: 4,
  },
  gridCoveredChip: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
  },
  gridCoveredChipLabel: {
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  gridCoveredChipValue: {
    fontSize: 16,
    fontWeight: "900",
    letterSpacing: -0.2,
  },
  gridActionRow: {
    flexDirection: "row",
    gap: 8,
    padding: 12,
    paddingTop: 0,
  },
  gridBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.sm,
    ...(Platform.OS === "web" ? ({ cursor: "pointer" as any } as any) : {}),
  },
  gridBtnFull: {
    flex: 1,
  },
  gridBtnPrimary: {
    flex: 1,
  },
  gridBtnGhost: {
    flex: 1,
    borderWidth: 1.5,
    backgroundColor: "transparent",
  },
  gridBtnText: {
    // Neutral mid-grey — readable on both dark and light page bgs when
    // used inside a transparent/ghost ‘Restore' button. Explicit overrides
    // (`colors.onPrimary`, `colors.danger`) at the call-site handle the
    // Place-Cover and Decline variants.
    color: "#9CA3AF",
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  declineAction: {
    width: 100,
    height: "100%",
    borderRadius: radius.md,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    // Match the row's bottom margin so the action height lines up with
    // the neighbouring card exactly.
  },
  declineActionText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.5,
  },

  // Bottom-anchored Undo snackbar (shown for 5s after each decline).
  snackbarWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    ...(Platform.OS === "web" ? ({ pointerEvents: "box-none" as any } as any) : {}),
  },
  snackbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    minWidth: 260,
    maxWidth: 460,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  snackbarText: {
    flex: 1,
    fontSize: 12,
    fontWeight: "700",
  },
  snackbarBtn: {
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  snackbarBtnText: {
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 1,
  },
  // ---- View-toggle toolbar (list ↔ grid + 3/6 cols) ----
  // Same visual language as the toolbar in My Vehicles so both screens
  // feel like sibling views of the same "car list" concept.
  viewToolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 8,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  viewToggle: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 8,
    padding: 2,
    gap: 2,
  },
  viewToggleBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  viewToggleText: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
});
