import { useCallback, useState, useMemo, useRef, useEffect } from "react";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  ActivityIndicator,
  Image,
  Platform,
  useWindowDimensions,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { useAuth } from "@/src/context/AuthContext";
import { apiFetch } from "@/src/api";
import BrandLogo from "@/src/components/BrandLogo";
import AsyncStorage from "@react-native-async-storage/async-storage";

// Accent colours for the three-offer panel on submission cards.
// Redesigned Nov 2026 — replaced the loud gold "My Offer" chip with
// a unified emerald/indigo/neutral palette so the three offers read
// as one grouped panel rather than a mismatched stack of pills.
//   • Fourbuy Offer  → neutral text / soft chip (informational)
//   • Highest Cover  → brand primary (blue) — the market's answer
//   • My Offer       → emerald — the dealer's own stake, positive but calm
const FOURBUY_OFFER_ACCENT = "#94A3B8";     // slate — neutral
const COVER_OFFER_ACCENT   = "#3B82F6";     // brand blue — external market
const MY_OFFER_ACCENT      = "#10B981";     // emerald — dealer's own number

// Fixed emerald for the "Done Deal" outcome. Not tied to `colors.success`
// because the app's monochrome theme swaps success between black/white
// depending on light/dark mode, which read as washed-out on photo
// overlays. `#22C55E` is Tailwind's `green-500` — solid, readable on
// both dark and light backgrounds.
const DONE_DEAL_GREEN      = "#22C55E";

type Submission = {
  id: string;
  reference?: string;
  dealer_name?: string;
  submitted_by_name?: string | null;
  submitted_by_job_title?: string | null;
  company_name?: string;
  make_name: string;
  model_name: string;
  derivative_name: string;
  year: number;
  mileage: number;
  condition: number;
  colour: string;
  status: "pending" | "priced" | "declined";
  bucket?: "incoming" | "priced" | "archived";
  price: number | null;
  priced_at?: string | null;
  created_at: string;
  front_photo?: string | null;
  unseen?: boolean;
  // Three-offer summary — enriched by the backend so the list UI can
  // show all pricing signals at a glance without a per-row query.
  dealer_offer_zar?: number | null;   // dealer's own recorded buy-in
  highest_cover_zar?: number | null;  // max pricing-agent cover on this sub
  cover_count?: number;
  // Deal-tracking outcome — set by the dealer AFTER pricing lands:
  //   deal.done === true  → "Done Deal"  (deal_bucket = "deal_done")
  //   deal.done === false → "No Deal"    (deal_bucket = "no_deal")
  //   otherwise / missing → "Pending"    (deal_bucket = "pending")
  deal?: { done?: boolean | null; sold?: boolean | null } | null;
};

type DealBucket = "all" | "pending" | "deal_done" | "no_deal";

// Map a submission's `deal.done` value into one of the three outcome
// buckets. Non-priced submissions are always "pending" because there's
// nothing yet to close a deal against.
function computeDealBucket(s: Submission): Exclude<DealBucket, "all"> {
  if (s.status !== "priced") return "pending";
  const done = s.deal?.done;
  if (done === true) return "deal_done";
  if (done === false) return "no_deal";
  return "pending";
}

type BucketCounts = { incoming: number; priced: number; archived: number };

type Draft = {
  id: string;
  label: string;
  updated_at: string;
  data?: any;
};

export default function DashboardScreen() {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { user } = useAuth();
  const router = useRouter();
  const tabBarHeight = useBottomTabBarHeight();
  const [items, setItems] = useState<Submission[]>([]);
  const [counts, setCounts] = useState<BucketCounts>({ incoming: 0, priced: 0, archived: 0 });
  const [bucket, setBucket] = useState<"incoming" | "priced">("incoming");
  // Deal-tracking outcome filter — orthogonal to the stage bucket. All
  // priced/completed submissions carry a deal.done value; unpriced ones
  // are lumped into "pending" so the chip counts stay honest.
  const [dealFilter, setDealFilter] = useState<DealBucket>("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [draftsExpanded, setDraftsExpanded] = useState(false);
  const isAdmin = user?.role === "admin";

  // ---- List / Grid view toggle (web-first) --------------------------
  // Two orthogonal preferences persisted to AsyncStorage so the user's
  // last choice sticks between sessions:
  //   • `viewMode` — "list" (traditional row cards) OR "grid" (WeBuyCars-
  //     style image-forward card catalogue). Grid is only OFFERED on web
  //     at ≥700px wide; native and narrow web stay on the list.
  //   • `gridColumns` — 3 or 6. On very wide desktops (>=1500px) users
  //     can pack 6 cards per row for a WeBuyCars-showroom feel; 3 keeps
  //     each card comfortably large.
  const { width } = useWindowDimensions();
  const canUseGrid = Platform.OS === "web" && width >= 700;
  const [viewMode, setViewMode] = useState<"list" | "grid">(
    canUseGrid ? "grid" : "list",
  );
  const [gridColumns, setGridColumns] = useState<3 | 6>(3);

  // Load persisted preferences on mount and normalise legacy values.
  useEffect(() => {
    (async () => {
      try {
        const savedMode = await AsyncStorage.getItem("submissions.viewMode");
        if ((savedMode === "list" || savedMode === "grid") && canUseGrid) {
          setViewMode(savedMode);
        }
        const savedCols = await AsyncStorage.getItem("submissions.gridColumns");
        const n = Number(savedCols);
        if (n === 3 || n === 6) setGridColumns(n as 3 | 6);
      } catch {
        // First load / storage unavailable — keep defaults.
      }
    })();
  }, [canUseGrid]);

  // Persist whenever the user changes either preference.
  const setViewModePersist = useCallback((next: "list" | "grid") => {
    setViewMode(next);
    AsyncStorage.setItem("submissions.viewMode", next).catch(() => {});
  }, []);
  const setGridColumnsPersist = useCallback((next: 3 | 6) => {
    setGridColumns(next);
    AsyncStorage.setItem("submissions.gridColumns", String(next)).catch(() => {});
  }, []);

  // The grid can't render at 6 columns on medium-width web (900-1400px)
  // without cards becoming too skinny — auto-clamp to 3 columns in that
  // window so the layout never looks broken even if a user stored 6.
  const effectiveGridColumns: 3 | 6 =
    viewMode === "grid" && gridColumns === 6 && width < 1500 ? 3 : gridColumns;

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const path = isAdmin ? "/api/admin/submissions" : "/api/submissions/my";
      const data = await apiFetch(path);
      const subs: Submission[] = data.submissions || [];
      setItems(subs);
      if (!isAdmin) {
        // Fetch dealer's drafts alongside their submissions.
        try {
          const dRes = await apiFetch("/api/drafts");
          setDrafts(dRes.drafts || []);
        } catch {
          setDrafts([]);
        }
      }
      if (isAdmin) {
        if (data.counts) {
          setCounts(data.counts);
        } else {
          // Fallback: derive counts client-side.
          const c: BucketCounts = { incoming: 0, priced: 0, archived: 0 };
          subs.forEach((s) => {
            const b = s.bucket || (s.status === "priced" || s.status === "declined" ? "priced" : "incoming");
            c[b] = (c[b] || 0) + 1;
          });
          setCounts(c);
        }
      }
    } catch (e) {
      console.log("load error", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isAdmin]);

  // Silent poll while the list is focused so status/price changes made
  // by admins (or by the pricing agent placing a cover) surface without
  // the dealer having to pull-to-refresh or reload the browser.
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

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  // Filter items by the current silo (admin only). Non-admin sees all their
  // (non-archived) items which are already filtered server-side.
  // Base list — admins are already scoped by stage bucket, dealers see
  // every non-archived submission (server-filtered).
  const baseItems = isAdmin
    ? items.filter((s) => (s.bucket || (s.status === "priced" || s.status === "declined" ? "priced" : "incoming")) === bucket)
    : items;

  // Roll-up counts across ALL items so the chip counts don't jump around
  // as the user clicks between filter chips.
  const dealCounts = useMemo(() => {
    const c = { all: baseItems.length, pending: 0, deal_done: 0, no_deal: 0 };
    baseItems.forEach((s) => { c[computeDealBucket(s)] += 1; });
    return c;
  }, [baseItems]);

  const visibleItems = dealFilter === "all"
    ? baseItems
    : baseItems.filter((s) => computeDealBucket(s) === dealFilter);

  const renderItem = ({ item }: { item: Submission }) => {
    const dealBucket = computeDealBucket(item);
    const dealBadge =
      dealBucket === "deal_done"
        ? { label: "DONE DEAL",     tint: DONE_DEAL_GREEN,  icon: "checkmark-circle" as const }
        : dealBucket === "no_deal"
          ? { label: "NO DEAL",     tint: colors.danger,    icon: "close-circle"     as const }
          : { label: "DEAL PENDING", tint: colors.warning,  icon: "hourglass-outline" as const };
    return (
    <TouchableOpacity
      testID={`submission-card-${item.id}`}
      style={styles.card}
      onPress={() => router.push(`/(app)/vehicle/${item.id}` as any)}
    >
      <View style={styles.cardTop}>
        {/* Front photo thumbnail (or placeholder if missing) — helps the
            dealer visually identify their submissions at a glance. */}
        <View style={styles.thumbWrap}>
          {item.front_photo ? (
            <Image source={{ uri: item.front_photo }} style={styles.thumb} resizeMode="cover" />
          ) : (
            <View style={styles.thumbPlaceholder}>
              <Ionicons name="car-outline" size={22} color={colors.textDisabled} />
            </View>
          )}
        </View>
        <View style={{ flex: 1 }}>
          {item.reference ? (
            <Text style={styles.cardRef}>{item.reference}</Text>
          ) : null}
          <Text style={styles.cardTitle} numberOfLines={1}>
            {item.year} {item.make_name}
          </Text>
          {item.derivative_name || item.model_name ? (
            <Text style={styles.cardSubtitle} numberOfLines={2}>
              {item.derivative_name || item.model_name}
            </Text>
          ) : null}
          {item.unseen ? (
            <View style={styles.unseenPill} testID="unseen-pill">
              <Ionicons name="eye-off-outline" size={10} color={colors.textSecondary} />
              <Text style={styles.unseenPillText}>SUBJECT TO VIEW</Text>
            </View>
          ) : null}
        </View>
      {/* Workflow status badge (PRICED / PENDING / NO OFFER) removed
          Nov 2026 — it duplicated the more informative deal-outcome pill
          in the bottom-right of the photo AND was hard to read in dark
          mode where `colors.success` was pure white on white photo
          highlights. The dealer's actual signal (their deal outcome +
          the Fourbuy Offer amount below) is much clearer. */}
      </View>

      <View style={styles.metaRow}>
        <View style={styles.metaItem}>
          <Ionicons name="speedometer-outline" size={14} color={colors.textSecondary} />
          <Text style={styles.metaText}>{item.mileage.toLocaleString()} km</Text>
        </View>
        <View style={styles.metaItem}>
          <Ionicons name="color-palette-outline" size={14} color={colors.textSecondary} />
          <Text style={styles.metaText}>{item.colour}</Text>
        </View>
        <View style={styles.metaItem}>
          <Ionicons name="star-outline" size={14} color={colors.textSecondary} />
          <Text style={styles.metaText}>Condition {item.condition}/10</Text>
        </View>
        {/* Deal outcome pill — inline with the meta chips so the dealer
            sees the deal status right alongside vehicle facts. */}
        <View style={[styles.dealPillList, { backgroundColor: dealBadge.tint + "22", borderColor: dealBadge.tint + "77" }]}>
          <Ionicons name={dealBadge.icon} size={11} color={dealBadge.tint} />
          <Text style={[styles.dealPillListTxt, { color: dealBadge.tint }]}>{dealBadge.label}</Text>
        </View>
      </View>

      {isAdmin && item.dealer_name ? (
        <View style={styles.dealerRow}>
          <Ionicons name="business-outline" size={12} color={colors.textSecondary} />
          <Text style={styles.dealerText}>
            {item.dealer_name} · {item.company_name}
          </Text>
        </View>
      ) : null}

      {/* Submitted-by chip — for dealer users of a multi-user dealership so
          you can tell which team member captured this valuation. */}
      {!isAdmin && item.submitted_by_name ? (
        <View style={styles.dealerRow}>
          <Ionicons name="person-circle-outline" size={12} color={colors.textSecondary} />
          <Text style={styles.dealerText} numberOfLines={1}>
            {item.submitted_by_name}
            {item.submitted_by_job_title ? ` · ${item.submitted_by_job_title}` : ""}
            {item.created_at ? ` · ${(item.created_at || "").slice(0, 10)}` : ""}
          </Text>
        </View>
      ) : null}

      {/* Unified offers panel — Fourbuy Offer, Highest Cover, and
          My Offer render as one grouped card so the three prices
          read together at a glance. Each row is a coloured left-
          stripe + accent-tinted amount so the panel stays readable
          without any loud borders. My Offer sits at the bottom on a
          subtle emerald wash to hint "this is yours" without dominating. */}
      {(() => {
        const showFourbuy = item.status === "priced" && item.price !== null;
        const showFourbuyNoOffer = item.status === "declined";
        const showCover = item.highest_cover_zar != null;
        return (
          <View style={styles.offersPanel}>
            {showFourbuy ? (
              <View style={styles.offersRow}>
                <View style={[styles.offersDot, { backgroundColor: FOURBUY_OFFER_ACCENT }]} />
                <Text style={styles.offersRowLabel}>Fourbuy Offer</Text>
                <Text style={[styles.offersRowValue, { color: colors.text }]}>
                  R {item.price!.toLocaleString()}
                </Text>
              </View>
            ) : showFourbuyNoOffer ? (
              <View style={styles.offersRow}>
                <View style={[styles.offersDot, { backgroundColor: FOURBUY_OFFER_ACCENT }]} />
                <Text style={styles.offersRowLabel}>Fourbuy Offer</Text>
                <Text style={[styles.offersRowValueMuted, { color: colors.textSecondary }]}>
                  No offer — not charged
                </Text>
              </View>
            ) : null}

            {showCover ? (
              <View style={[styles.offersRow, (showFourbuy || showFourbuyNoOffer) && styles.offersRowDivider]}>
                <View style={[styles.offersDot, { backgroundColor: COVER_OFFER_ACCENT }]} />
                <Text style={styles.offersRowLabel}>
                  Cover Offer{item.cover_count && item.cover_count > 1 ? ` · ${item.cover_count}` : ""}
                </Text>
                <Text style={[styles.offersRowValue, { color: COVER_OFFER_ACCENT }]}>
                  R {item.highest_cover_zar!.toLocaleString()}
                </Text>
              </View>
            ) : null}

            {/* My Offer / Dealer Offer — ALWAYS rendered so the row is a
                consistent visual anchor for the dealer's own stake.
                Rendered with a subtle emerald wash + left stripe so it
                still holds a bit more weight than the neutral rows above
                without shouting. */}
            <View
              style={[
                styles.offersMyRow,
                (showFourbuy || showFourbuyNoOffer || showCover) && styles.offersMyRowWithDivider,
                { backgroundColor: MY_OFFER_ACCENT + "12" },
              ]}
            >
              <View style={[styles.offersDot, { backgroundColor: MY_OFFER_ACCENT }]} />
              <Text style={[styles.offersRowLabel, { color: MY_OFFER_ACCENT }]}>
                {isAdmin ? "Dealer Offer" : "My Offer"}
              </Text>
              {item.dealer_offer_zar != null ? (
                <Text style={[styles.offersRowValue, { color: MY_OFFER_ACCENT }]}>
                  R {item.dealer_offer_zar.toLocaleString()}
                </Text>
              ) : (
                <Text style={[styles.offersRowValueMuted, { color: MY_OFFER_ACCENT + "99" }]}>
                  Not set
                </Text>
              )}
            </View>
          </View>
        );
      })()}
    </TouchableOpacity>
    );
  };

  // ---- Grid card renderer (WeBuyCars-style — web only) --------------
  // Image-forward layout with the front photo at the top, title + meta
  // beneath, and a subtle price/status footer. Mirrors the same visual
  // language as `Give Cover`, minus the Offer/Decline action bar since
  // this is the dealer's own submission catalogue, not the pricing-
  // agent inbox. Tapping any card opens the vehicle detail.
  const renderGridCard = (item: Submission) => {
    const gridColWidth = `${(100 / effectiveGridColumns).toFixed(4)}%` as any;
    // Deal outcome badge — only meaningful once a submission has been
    // priced (before that it's always "Pending"). We still render for
    // pending items so the visual placeholder is consistent between
    // cards; the chip just says "Deal Pending" until the dealer
    // records an outcome.
    // Done Deal uses a fixed emerald (#22C55E) rather than
    // `colors.success` so it reads as a proper green in BOTH themes —
    // the monochrome theme's success token is black/white which looked
    // washed out on the photo overlay.
    const dealBucket = computeDealBucket(item);
    const dealBadge =
      dealBucket === "deal_done"
        ? { label: "DONE DEAL",     tint: DONE_DEAL_GREEN,  icon: "checkmark-circle" as const }
        : dealBucket === "no_deal"
          ? { label: "NO DEAL",     tint: colors.danger,    icon: "close-circle"     as const }
          : { label: "DEAL PENDING", tint: colors.warning,  icon: "hourglass-outline" as const };
    return (
      <View
        key={item.id}
        style={[styles.gridCol, { width: gridColWidth }]}
      >
        <TouchableOpacity
          testID={`submission-card-${item.id}`}
          onPress={() => router.push(`/(app)/vehicle/${item.id}` as any)}
          activeOpacity={0.92}
          style={[
            styles.gridCard,
            { backgroundColor: colors.paper, borderColor: colors.border },
          ]}
        >
          {/* Front image — 4:3 aspect matches the Give Cover grid. */}
          <View style={styles.gridImgWrap}>
            {item.front_photo ? (
              <Image
                source={{ uri: item.front_photo }}
                style={styles.gridImg}
                resizeMode="cover"
              />
            ) : (
              <View style={[styles.gridImg, styles.gridImgEmpty, { backgroundColor: colors.bg }]}>
                <Ionicons name="car-outline" size={44} color={colors.textDisabled} />
              </View>
            )}
            {item.reference ? (
              <View style={styles.gridRefBadge}>
                <Text style={styles.gridRefBadgeText}>{item.reference}</Text>
              </View>
            ) : null}
            {/* Workflow status badge (PRICED / PENDING / NO OFFER) removed
                Nov 2026 — the deal-outcome pill in the bottom-right of
                the photo now carries all the signal the dealer needs,
                and the workflow badge was hard to read in dark mode. */}
            {item.unseen ? (
              <View style={styles.gridUnseenBadge}>
                <Ionicons name="eye-off-outline" size={10} color="#fff" />
                <Text style={styles.gridUnseenBadgeText}>SUBJECT TO VIEW</Text>
              </View>
            ) : null}
            {/* Deal-outcome pill — bottom-right of the photo so the
                dealer sees the deal status alongside the workflow
                status (PRICED / PENDING / NO OFFER) at a glance. */}
            <View style={[styles.gridDealBadge, { backgroundColor: dealBadge.tint }]}>
              <Ionicons name={dealBadge.icon} size={11} color="#fff" />
              <Text style={styles.gridStatusBadgeText}>{dealBadge.label}</Text>
            </View>
          </View>

          {/* Text stack — title, meta chips. Vehicle title is split
              into TWO lines everywhere in the app:
                • bold `year + make` (e.g. "2021 Land Rover")
                • lighter `derivative` line below (falls back to model)
              This avoids the previous duplication where derivative
              appeared both in the title and as a subtitle. */}
          <View style={styles.gridBody}>
            <Text style={[styles.gridTitle, { color: colors.text }]} numberOfLines={1}>
              {item.year} {item.make_name}
            </Text>
            {item.derivative_name || item.model_name ? (
              <Text
                style={[styles.gridDeriv, { color: colors.textSecondary }]}
                numberOfLines={2}
              >
                {item.derivative_name || item.model_name}
              </Text>
            ) : null}
            <View style={styles.gridMetaRow}>
              <View style={styles.gridMetaChip}>
                <Ionicons name="speedometer-outline" size={11} color={colors.textSecondary} />
                <Text style={[styles.gridMetaChipText, { color: colors.textSecondary }]}>
                  {item.mileage.toLocaleString()} km
                </Text>
              </View>
              <View style={styles.gridMetaChip}>
                <Ionicons name="color-palette-outline" size={11} color={colors.textSecondary} />
                <Text style={[styles.gridMetaChipText, { color: colors.textSecondary }]}>
                  {item.colour}
                </Text>
              </View>
              <View style={styles.gridMetaChip}>
                <Ionicons name="star-outline" size={11} color={colors.textSecondary} />
                <Text style={[styles.gridMetaChipText, { color: colors.textSecondary }]}>
                  {item.condition}/10
                </Text>
              </View>
            </View>

            {/* Unified offers footer — same visual language as the
                list card so dealers see the same grouped Fourbuy / Cover
                Offer / My Offer panel across both views. */}
            <View style={styles.offersPanel}>
              {item.status === "priced" && item.price !== null ? (
                <View style={styles.offersRow}>
                  <View style={[styles.offersDot, { backgroundColor: FOURBUY_OFFER_ACCENT }]} />
                  <Text style={styles.offersRowLabel}>Fourbuy Offer</Text>
                  <Text style={[styles.offersRowValue, { color: colors.text, fontSize: 14 }]}>
                    R {item.price.toLocaleString()}
                  </Text>
                </View>
              ) : item.status === "declined" ? (
                <View style={styles.offersRow}>
                  <View style={[styles.offersDot, { backgroundColor: FOURBUY_OFFER_ACCENT }]} />
                  <Text style={styles.offersRowLabel}>Fourbuy Offer</Text>
                  <Text style={[styles.offersRowValueMuted, { color: colors.textSecondary }]}>
                    No offer
                  </Text>
                </View>
              ) : (
                <View style={styles.offersRow}>
                  <View style={[styles.offersDot, { backgroundColor: FOURBUY_OFFER_ACCENT }]} />
                  <Text style={styles.offersRowLabel}>Fourbuy Offer</Text>
                  <Text style={[styles.offersRowValueMuted, { color: colors.textSecondary }]}>
                    Awaiting
                  </Text>
                </View>
              )}
              {item.highest_cover_zar != null ? (
                <View style={[styles.offersRow, styles.offersRowDivider]}>
                  <View style={[styles.offersDot, { backgroundColor: COVER_OFFER_ACCENT }]} />
                  <Text style={styles.offersRowLabel}>Cover Offer</Text>
                  <Text style={[styles.offersRowValue, { color: COVER_OFFER_ACCENT, fontSize: 14 }]}>
                    R {item.highest_cover_zar.toLocaleString()}
                  </Text>
                </View>
              ) : null}
              <View
                style={[
                  styles.offersMyRow,
                  styles.offersMyRowWithDivider,
                  { backgroundColor: MY_OFFER_ACCENT + "12" },
                ]}
              >
                <View style={[styles.offersDot, { backgroundColor: MY_OFFER_ACCENT }]} />
                <Text style={[styles.offersRowLabel, { color: MY_OFFER_ACCENT }]}>
                  {isAdmin ? "Dealer Offer" : "My Offer"}
                </Text>
                {item.dealer_offer_zar != null ? (
                  <Text style={[styles.offersRowValue, { color: MY_OFFER_ACCENT, fontSize: 14 }]}>
                    R {item.dealer_offer_zar.toLocaleString()}
                  </Text>
                ) : (
                  <Text style={[styles.offersRowValueMuted, { color: MY_OFFER_ACCENT + "99" }]}>
                    Not set
                  </Text>
                )}
              </View>
            </View>
          </View>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Slim brand strip so the logo is always visible above the header. */}
      <View style={styles.brandStrip}>
        <BrandLogo size="sm" linkToHome />
      </View>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.greeting}>{isAdmin ? "Fourbuy Admin" : "My Submissions"}</Text>
          <Text style={styles.subGreeting}>
            {isAdmin
              ? `${counts.incoming + counts.priced} active · ${counts.archived} archived`
              : `${items.length} ${items.length === 1 ? "vehicle" : "vehicles"}`}
          </Text>
        </View>
        {!isAdmin ? (
          <TouchableOpacity
            testID="header-new-submission-button"
            style={styles.newBtn}
            onPress={() => router.push("/(app)/submit" as any)}
          >
            <Ionicons name="add" size={20} color={colors.onPrimary} />
            <Text style={styles.newBtnText}>New</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {isAdmin ? (
        <View style={styles.silosRow}>
          {(["incoming", "priced"] as const).map((b) => {
            const active = bucket === b;
            const label = b === "incoming" ? "Incoming" : "Priced";
            const n = counts[b] || 0;
            return (
              <TouchableOpacity
                key={b}
                testID={`silo-${b}`}
                onPress={() => setBucket(b)}
                style={[styles.silo, active && styles.siloActive]}
                activeOpacity={0.85}
              >
                <Text style={[styles.siloLabel, active && styles.siloLabelActive]}>{label}</Text>
                <View style={[styles.siloBadge, active && styles.siloBadgeActive]}>
                  <Text style={[styles.siloBadgeText, active && styles.siloBadgeTextActive]}>{n}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}

      {/* Deal-outcome filter chip row — orthogonal to the stage bucket.
          Priced vehicles carry a `deal.done` outcome recorded by the
          dealer; unpriced/pending ones show up under "Pending". Chip
          counts reflect the currently-scoped baseItems so the numbers
          always add up to the total. Never shown when there's no data
          yet (loading + empty state handled below). */}
      {!loading && baseItems.length > 0 ? (
        <View style={styles.dealFilterRow}>
          {([
            { key: "all",       label: "All",         tint: colors.textSecondary },
            { key: "pending",   label: "Pending",     tint: colors.warning },
            { key: "deal_done", label: "Done Deal",   tint: DONE_DEAL_GREEN },
            { key: "no_deal",   label: "No Deal Done", tint: colors.danger },
          ] as { key: DealBucket; label: string; tint: string }[]).map((c) => {
            const active = dealFilter === c.key;
            const n = dealCounts[c.key];
            return (
              <TouchableOpacity
                key={c.key}
                testID={`deal-filter-${c.key}`}
                onPress={() => setDealFilter(c.key)}
                style={[
                  styles.dealChip,
                  { borderColor: active ? c.tint : colors.border },
                  active && { backgroundColor: c.tint + "22" },
                ]}
                activeOpacity={0.85}
              >
                <View style={[styles.dealChipDot, { backgroundColor: c.tint }]} />
                <Text style={[
                  styles.dealChipLabel,
                  { color: active ? c.tint : colors.textSecondary },
                ]}>
                  {c.label}
                </Text>
                <View style={[styles.dealChipCount, { backgroundColor: (active ? c.tint : colors.border) + (active ? "" : "") }]}>
                  <Text style={[
                    styles.dealChipCountTxt,
                    { color: active ? colors.onPrimary : colors.text },
                  ]}>
                    {n}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}

      {/* Drafts card — shown to dealers with in-progress submissions. Sits
          above both the empty-state and the list so it's always accessible. */}
      {!isAdmin && drafts.length > 0 ? (
        <View style={styles.draftsCardWrap}>
          <View style={styles.draftsCard} testID="drafts-card">
            <TouchableOpacity
              style={styles.draftsHeader}
              onPress={() => setDraftsExpanded((v) => !v)}
              testID="drafts-toggle"
              activeOpacity={0.75}
            >
              <View style={styles.draftsBadge}>
                <Ionicons name="document-outline" size={16} color={colors.text} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.draftsTitle}>Drafts ({drafts.length})</Text>
                <Text style={styles.draftsSub}>
                  In-progress vehicle submissions
                </Text>
              </View>
              <Ionicons
                name={draftsExpanded ? "chevron-up" : "chevron-down"}
                size={18}
                color={colors.textSecondary}
              />
            </TouchableOpacity>

            {draftsExpanded ? (
              <View style={styles.draftsList}>
                {drafts.map((d) => (
                  <View key={d.id} style={styles.draftRow}>
                    <TouchableOpacity
                      style={{ flex: 1, paddingVertical: 4 }}
                      onPress={() => router.push(`/(app)/submit?draft=${d.id}` as any)}
                      testID={`resume-draft-${d.id}`}
                    >
                      <Text style={styles.draftLabel}>{d.label}</Text>
                      <Text style={styles.draftMeta}>
                        Updated {new Date(d.updated_at).toLocaleString()}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.draftDeleteBtn}
                      testID={`delete-draft-${d.id}`}
                      onPress={async () => {
                        try {
                          await apiFetch(`/api/drafts/${d.id}`, { method: "DELETE" });
                          setDrafts((prev) => prev.filter((x) => x.id !== d.id));
                        } catch {
                          /* silent */
                        }
                      }}
                    >
                      <Ionicons name="trash-outline" size={16} color={colors.danger} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : visibleItems.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="car-outline" size={64} color={colors.textDisabled} />
          <Text style={styles.emptyTitle}>
            {isAdmin
              ? bucket === "incoming"
                ? "No incoming submissions"
                : "Nothing priced in the last 30 days"
              : "No submissions yet"}
          </Text>
          <Text style={styles.emptyText}>
            {isAdmin
              ? bucket === "incoming"
                ? "New dealer submissions will appear here"
                : "Priced vehicles appear here for 30 days then move to Archive on desktop"
              : "Submit your first vehicle for pricing"}
          </Text>
          {!isAdmin ? (
            <TouchableOpacity
              testID="empty-new-submission-button"
              style={styles.emptyBtn}
              onPress={() => router.push("/(app)/submit" as any)}
            >
              <Text style={styles.emptyBtnText}>Submit Vehicle</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : (
        <>
          {/* View-toggle toolbar — only shown when a grid mode is
              actually usable at the current viewport (web + wide
              enough). Lets the user switch between the row list and a
              WeBuyCars-style grid, and pick 3 or 6 columns in grid
              mode. Preferences are persisted per browser via
              AsyncStorage. */}
          {canUseGrid ? (
            <View style={styles.viewToolbar} testID="submissions-view-toolbar">
              <View style={[styles.viewToggle, { borderColor: colors.border }]}>
                <TouchableOpacity
                  testID="view-toggle-list"
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
                  testID="view-toggle-grid"
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
                    // 6-column mode needs at least 1500px of viewport to
                    // avoid cards becoming too skinny — greyed out on
                    // narrower windows so the intent is obvious.
                    const disabled = n === 6 && width < 1500;
                    const active = effectiveGridColumns === n;
                    return (
                      <TouchableOpacity
                        key={n}
                        testID={`grid-cols-${n}`}
                        onPress={() => !disabled && setGridColumnsPersist(n)}
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

          {viewMode === "grid" && canUseGrid ? (
            /* WeBuyCars-style grid — a plain ScrollView with flex-wrapping
               children. FlatList doesn't support arbitrary CSS-grid
               widths so we use a manual wrap layout matching the pattern
               used in the Give Cover screen. */
            <ScrollView
              testID="submissions-grid"
              contentContainerStyle={[
                styles.gridScroll,
                { paddingBottom: tabBarHeight + spacing.md },
              ]}
              refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
              }
            >
              <View style={styles.gridContainer}>
                {visibleItems.map((it) => renderGridCard(it))}
              </View>
            </ScrollView>
          ) : (
            <FlatList
              data={visibleItems}
              keyExtractor={(i) => i.id}
              renderItem={renderItem}
              contentContainerStyle={[styles.list, { paddingBottom: tabBarHeight + spacing.md }]}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
            />
          )}
        </>
      )}
    </SafeAreaView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  brandStrip: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: 4,
    backgroundColor: colors.bg,
    alignItems: "flex-start",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.paper,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  greeting: { color: colors.text, fontSize: 24, fontWeight: "800", fontFamily: fonts.heading, letterSpacing: 0.3 },
  subGreeting: { color: colors.textSecondary, fontSize: 14, marginTop: 4, letterSpacing: 0.1 },
  newBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.sm,
  },
  newBtnText: { color: colors.onPrimary, fontWeight: "800", letterSpacing: 0.5 },

  // Deal-outcome filter chip row — sits directly below the greeting/new
  // header. Chips are subtle by default; the active one lights up in
  // the outcome's tint (amber for Pending, emerald for Done Deal, red
  // for No Deal). Count badges make the split obvious at a glance.
  dealFilterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  dealChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderRadius: 999,
    backgroundColor: colors.card,
  },
  dealChipDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  dealChipLabel: {
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  dealChipCount: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  dealChipCountTxt: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.2,
  },

  silosRow: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    backgroundColor: colors.bg,
  },
  silo: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  siloActive: {
    borderColor: colors.neon,
    backgroundColor: colors.neon + "12",
  },
  siloLabel: { color: colors.textSecondary, fontSize: 13, fontWeight: "700", letterSpacing: 0.3 },
  siloLabelActive: { color: colors.text },
  siloBadge: {
    minWidth: 24,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.border,
    alignItems: "center",
  },
  siloBadgeActive: { backgroundColor: colors.neon },
  siloBadgeText: { color: colors.text, fontSize: 11, fontWeight: "800" },
  siloBadgeTextActive: { color: colors.onPrimary },
  list: { padding: spacing.md, paddingBottom: spacing.xl },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  cardTop: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  thumbWrap: {
    width: 68,
    height: 52,
    borderRadius: radius.sm,
    overflow: "hidden",
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.border,
  },
  thumb: { width: "100%", height: "100%" },
  thumbPlaceholder: { flex: 1, alignItems: "center", justifyContent: "center" },
  cardRef: { color: colors.text, fontSize: 14, fontWeight: "800", letterSpacing: 0.6, fontFamily: fonts.mono, marginBottom: 6 },
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: "700", letterSpacing: 0.1 },
  // Lighter subtitle sitting directly under the bold title. Renders
  // the derivative (or model, when no derivative). Keeps every list
  // card in step with the grid layout's title/subtitle rhythm.
  cardSubtitle: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.05,
    marginTop: 2,
  },
  unseenPill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.border,
  },
  unseenPillText: {
    color: colors.textSecondary,
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.sm,
  },
  badgeText: { fontSize: 11, fontWeight: "700", letterSpacing: 0.3 },
  metaRow: { flexDirection: "row", gap: spacing.md, marginTop: spacing.sm, flexWrap: "wrap" },
  metaItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  metaText: { color: colors.textSecondary, fontSize: 13, letterSpacing: 0.1 },
  dealerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  dealerText: { color: colors.textSecondary, fontSize: 12 },
  priceRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  priceLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: "600" },
  priceValue: { color: colors.success, fontSize: 18, fontWeight: "800" },
  // ---- Unified offers panel (list card) ----
  // A single grouped container that holds Fourbuy Offer, Cover Offer
  // (highest external cover), and the dealer's own My Offer. Each
  // row is a coloured left-dot + label + right-aligned amount. My
  // Offer sits at the bottom on a subtle emerald wash so it still
  // reads as "the dealer's own number" without shouting like the
  // previous outlined gold pill.
  offersPanel: {
    marginTop: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.paper,
    overflow: "hidden",
  },
  offersRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 10,
  },
  offersRowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  offersMyRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 12,
    gap: 10,
  },
  offersMyRowWithDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  offersDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  offersRowLabel: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase" as const,
  },
  offersRowValue: {
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: -0.2,
    fontVariant: ["tabular-nums"],
  },
  offersRowValueMuted: {
    fontSize: 12,
    fontWeight: "700",
  },
  // ---- Legacy price row (kept for other callers) ----

  // ---- View toggle toolbar (list ↔ grid, plus 3/6 cols) ----
  viewToolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  viewToggle: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: 2,
    gap: 2,
  },
  viewToggleBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.sm - 2,
  },
  viewToggleText: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.2,
  },

  // ---- WeBuyCars-style grid (web only) ----
  gridScroll: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  gridContainer: {
    flexDirection: "row",
    flexWrap: "wrap" as const,
    marginHorizontal: -6,
  },
  gridCol: {
    paddingHorizontal: 6,
    paddingBottom: 12,
  },
  gridCard: {
    borderRadius: radius.lg,
    borderWidth: 1,
    overflow: "hidden",
    // Match sibling card heights within a row.
    height: "100%",
    display: "flex" as any,
    flexDirection: "column",
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
    top: 8,
    left: 8,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 5,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  gridRefBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  gridStatusBadge: {
    position: "absolute" as any,
    top: 8,
    right: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
  },
  gridStatusBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "800",
  },
  // Deal-outcome pill — bottom-right of the photo. Mirrors the shape of
  // the workflow status badge (top-right) but uses outcome colours
  // (emerald / red / amber). Compact so it doesn't fight for space with
  // the "SUBJECT TO VIEW" indicator (bottom-left).
  gridDealBadge: {
    position: "absolute" as any,
    bottom: 8,
    right: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
  },
  // Deal outcome pill for the LIST card metaRow. Softer than the grid
  // overlay pill — uses translucent background + coloured border so it
  // sits in-flow with the other meta chips without dominating.
  dealPillList: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  dealPillListTxt: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  gridUnseenBadge: {
    position: "absolute" as any,
    bottom: 8,
    left: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 5,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  gridUnseenBadgeText: {
    color: "#fff",
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  gridBody: {
    padding: 10,
    gap: 3,
    flex: 1,
    justifyContent: "space-between",
  },
  gridTitle: {
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: -0.1,
  },
  gridDeriv: {
    fontSize: 12,
    fontWeight: "600",
  },
  gridMetaRow: {
    flexDirection: "row",
    flexWrap: "wrap" as const,
    gap: 5,
    marginTop: 4,
  },
  gridMetaChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  gridMetaChipText: {
    fontSize: 10,
    fontWeight: "700",
  },
  gridFooter: {
    marginTop: 8,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 3,
  },
  gridFooterRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 6,
  },
  gridFooterLabel: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  gridFooterValue: {
    fontSize: 13,
    fontWeight: "800",
  },
  // -- Grid card My Offer / Dealer Offer highlight --
  // Same "gold chip" as the list card but tuned for the grid's tighter
  // footprint. Sits directly below the neutral Fourbuy + Highest Cover
  // rows so it caps every card with a bold gold band.
  gridFooterHighlight: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 6,
    paddingHorizontal: 7,
    paddingVertical: 5,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  gridFooterHighlightLabel: {
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  gridFooterHighlightValue: {
    fontSize: 14,
    fontWeight: "900",
    letterSpacing: -0.1,
  },

  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm, padding: spacing.lg },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: "700", marginTop: spacing.sm },
  emptyText: { color: colors.textSecondary, fontSize: 14, textAlign: "center" },
  emptyBtn: {
    marginTop: spacing.md,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.xl,
    paddingVertical: 12,
    borderRadius: radius.sm,
  },
  emptyBtnText: { color: colors.onPrimary, fontWeight: "800", letterSpacing: 0.5 },

  // Drafts card (dealer dashboard header)
  draftsCardWrap: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  draftsCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    marginBottom: spacing.md,
    overflow: "hidden",
  },
  draftsHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
    gap: spacing.sm,
  },
  draftsBadge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  draftsTitle: {
    color: colors.text,
    fontWeight: "800",
    fontSize: 14,
    letterSpacing: 0.5,
  },
  draftsSub: {
    color: colors.textSecondary,
    fontSize: 11,
    marginTop: 2,
  },
  draftsList: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: spacing.md,
  },
  draftRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  draftLabel: {
    color: colors.text,
    fontWeight: "700",
    fontSize: 13,
  },
  draftMeta: {
    color: colors.textDisabled,
    fontSize: 11,
    marginTop: 2,
    fontFamily: fonts.mono,
  },
  draftDeleteBtn: {
    padding: 6,
  },
});
