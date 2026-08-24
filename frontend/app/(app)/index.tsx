import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import * as React from "react";
import { Pressable } from "@/src/components/HapticButtons";
import { View, Text, StyleSheet, ScrollView, Image, Platform, useWindowDimensions, Alert, Linking } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSequence,
  runOnJS,
  Easing,
} from "react-native-reanimated";
import { Ionicons } from "@expo/vector-icons";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEvent } from "expo";
import { LinearGradient } from "expo-linear-gradient";
import AppIconTile from "@/src/components/home/AppIconTile";
import { useFocusEffect, useRouter } from "expo-router";

import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { useAuth } from "@/src/context/AuthContext";
import { apiFetch } from "@/src/api";

// ---------------------------------------------------------------------------
// Home / Landing screen — dealer + admin.
// Video banner at the top, then three tap-to-flip tiles below. Each tile
// cycles through pages on tap (front → point 1 → point 2 → ... → loop).
// ---------------------------------------------------------------------------

// Bundled hero video — client-supplied cinematic (Aug 2026).
// Native (iOS / Android): render the looping H.264 .mp4 via expo-video.
// Web: skip the video entirely and show a clean static TRADE AI logo
//      on a black backdrop. The web preview environment surfaces a
//      transient "6000ms timeout exceeded" font-loading warning while
//      the cinematic buffers, and the client prefers a rock-solid
//      still-image hero on the browser anyway.
const HERO_VIDEO = require("../../assets/video/hero_v2.mp4");
// Static logo lockup used as the fallback poster behind the VideoView
// so the panel is never a blank rectangle. Points at the "TRADE APP"
// logo-reveal frame extracted from the video (feb 2027 rebrand — the
// previous `tradeai_hero.png` was branded "POWERED BY FOURBUY").
const HERO_LOGO = require("../../assets/video/hero_v2_poster.jpg");

// Advertising rotation — bundled bitmaps, cycled per-tap.
const AD_TCS = require("../../assets/brands/ad_tcs.jpeg");
const AD_SWIFT = require("../../assets/brands/ad_swift.jpeg");
const AD_MERCEDES = require("../../assets/brands/ad_mercedes.jpeg");

// Lifestyle image for the "Trade with Confidence" hero tile front page.
// Kept for reference — the current implementation uses the full 5-page
// hero cycle (`HERO_TRADE_PAGES` below) instead of this single lifestyle
// still, but we leave the import in place in case we ever revert to
// the older static-image + bullet-points layout.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const HERO_TILE_LIFESTYLE = require("../../assets/brands/hero_lifestyle.jpg");

// Trade-with-Confidence 5-page hero cycle. Each image is a fully
// designed 2:1 landscape composition (dark cinematic photography with
// baked-in title + description on the left, and a UI preview mock on
// the right). We do NOT overlay any text on top of these — the images
// are the whole story. The cycle order matches the customer journey:
//   1. Verified Dealer Network (who's trading)
//   2. Trade with Confidence   (the brand promise)
//   3. Real Market Intelligence (the data)
//   4. Get More Cover          (multi-dealer offers)
//   5. Know the Vehicle        (VIN-linked reports)
const HERO_TRADE_PAGES: number[] = [
  require("../../assets/brands/hero_tiles/hero_verified_dealer_network.png"),
  require("../../assets/brands/hero_tiles/hero_trade_with_confidence.png"),
  require("../../assets/brands/hero_tiles/hero_real_market_intelligence.png"),
  require("../../assets/brands/hero_tiles/hero_get_more_cover.png"),
  require("../../assets/brands/hero_tiles/hero_know_the_vehicle.png"),
];
// Note: the "Earn Rewards" flip banner was removed at the user's request
// (the rewards content now lives only on the /rewards module). The
// rewards_lifestyle.jpg asset is kept in the repo but no longer imported.

type PagePoint = { icon?: keyof typeof Ionicons.glyphMap; text: string };
type PageAd = { image: number | { uri: string }; label?: string };

// A tile has ONE front page + N interior pages OR a `heroes` array
// where every page is a full-bleed hero image (no overlay, no
// front/footer). Bullet points and ad-carousel patterns remain
// supported for backwards compatibility with other tiles.
type Tile = {
  key: "trade" | "rewards" | "ads";
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  footer?: string; // Trailing italic line after last bullet
  points?: PagePoint[];
  ads?: PageAd[];
  // Full-bleed hero pages (each image is its own page in the flip cycle).
  // When set, the tile skips the front/footer/points/ads pipeline
  // entirely — the images ARE the tile.
  heroes?: number[];
  frontImage?: number; // Optional lifestyle image behind the front page.
};

const BASE_TILES: Tile[] = [
  {
    key: "trade",
    icon: "shield-checkmark",
    title: "Trade with Confidence",
    subtitle: "Reduce your risks — tap to see how",
    // Full-bleed cinematic hero cycle. See HERO_TRADE_PAGES above.
    heroes: HERO_TRADE_PAGES,
  },
  {
    key: "ads",
    icon: "megaphone",
    title: "Advertising",
    subtitle: "Featured partners — tap to browse",
    ads: [
      { image: AD_TCS, label: "TheCarScene" },
      { image: AD_SWIFT, label: "Suzuki Swift" },
      { image: AD_MERCEDES, label: "Mercedes-Benz EQS" },
    ],
  },
];

export default function HomeScreen() {
  const colors = useThemeColors();
  const { width } = useWindowDimensions();
  // Above this, we switch to a website-style layout: constrained max width,
  // three-column tile grid, quick-actions row across the top.
  const isWide = width >= 900;
  const styles = useMemo(() => makeStyles(colors, isWide, width), [colors, isWide, width]);
  const insets = useBottomTabBarHeight();
  const router = useRouter();
  const { user } = useAuth();
  const isSuspended = user?.active === false;

  // When a dealer's account is suspended (billing hold, admin action,
  // etc.) they must NOT be able to submit new valuations or place
  // covers. Tapping Get Cover / Give Cover pops a modal offering to
  // WhatsApp the admin directly with a pre-filled enquiry.
  const handleGuardedNavigate = React.useCallback(
    (target: string, tileLabel: string) => {
      if (!isSuspended) {
        router.push(target as never);
        return;
      }
      const dealership =
        user?.dealership?.name ||
        (user as any)?.company_info?.company_name ||
        "—";
      const userName =
        user?.name ||
        [user?.dealer_info?.first_name, user?.dealer_info?.last_name]
          .filter(Boolean)
          .join(" ") ||
        user?.email ||
        "—";
      const adminPhone = "27848819073";
      // Build the message in plain text first, then URL-encode the
      // whole thing exactly ONCE. Earlier version mixed hard-coded
      // `%0A` line breaks with `encodeURIComponent(dealership)` which
      // double-encoded any special characters (apostrophes, ampersands,
      // etc.) in dealership / user names — WhatsApp then displayed
      // literal "%20" and "%2F" tokens in the pre-filled body.
      const waMessage =
        "Hi TradeAPP Admin,\n\n" +
        "I'm enquiring about an account suspension.\n" +
        `Dealership: ${dealership}\n` +
        `User: ${userName}\n\n` +
        "Please assist us to reactivate the account.";
      const waUrl = `https://wa.me/${adminPhone}?text=${encodeURIComponent(waMessage)}`;
      const message =
        `Your account is currently suspended, so you can't ${tileLabel === "Get Cover" ? "submit new valuations" : "place covers"} right now.\n\n` +
        `Please contact the TradeAPP administrator to resolve this.`;
      if (Platform.OS === "web") {
        const ok = (globalThis as any).confirm?.(
          `${message}\n\nOpen WhatsApp to message admin now?`
        );
        if (ok) (globalThis as any).open?.(waUrl, "_blank");
        return;
      }
      Alert.alert(
        "Account suspended",
        message,
        [
          { text: "Ignore", style: "cancel" },
          {
            text: "WhatsApp Admin",
            style: "default",
            onPress: async () => {
              try {
                await Linking.openURL(waUrl);
              } catch {
                Alert.alert(
                  "Could not open WhatsApp",
                  "Please install WhatsApp or contact +27 84 881 9073 directly."
                );
              }
            },
          },
        ],
        { cancelable: true }
      );
    },
    [isSuspended, router, user]
  );

  const firstName =
    user?.dealer_info?.first_name?.trim() ||
    user?.name?.split(" ")[0] ||
    (user?.email ? user.email.split("@")[0] : "");

  // Dealership label for the welcome header ("Welcome David from
  // TradeAPP Fourways Gardens (PTY) Ltd"). Falls back to company_info's
  // company_name for dealers who registered before we linked them to
  // a `dealership` doc.
  const dealershipName =
    user?.dealership?.name ||
    user?.company_info?.company_name ||
    "";

  const heroPlayer = useVideoPlayer(HERO_VIDEO, (p) => {
    // Client-supplied cinematic intro. Plays on every platform —
    // iOS, Android and Web. Muted so browser autoplay policies
    // allow it without a user gesture.
    //
    // Feb 2027 — the video's last frames feature a particle-shatter
    // that dissolves the "TRADE APP" logo. Clients wants the freeze
    // to land on the fully-revealed logo, not on the empty aftermath.
    // We solve that in two coordinated ways:
    //   1. `loop = false` — playback stops naturally, no restart.
    //   2. The timeUpdate subscriber below pauses the player at the
    //      logo-reveal moment (~7.5s in), before the shatter starts,
    //      so the last visible frame is the clean logo.
    p.loop = false;
    p.muted = true;
    p.timeUpdateEventInterval = 0.25;
    p.play();
  });

  // Auto-pause at the logo-reveal moment. Uses `expo`'s `useEvent` hook
  // to subscribe to expo-video's `timeUpdate` event. Cheap subscription
  // — fires 4×/second (250 ms interval configured above) — and only
  // triggers the pause once per playback cycle (guarded by a ref so
  // subsequent time updates after the pause are no-ops).
  const heroPaused = useRef(false);
  const HERO_FREEZE_AT = 7.5; // seconds — matches the logo-reveal frame
  const heroTime = useEvent(heroPlayer, "timeUpdate", { currentTime: 0 });
  useEffect(() => {
    if (heroPaused.current) return;
    if (heroTime?.currentTime && heroTime.currentTime >= HERO_FREEZE_AT) {
      heroPaused.current = true;
      try {
        heroPlayer.pause();
      } catch { /* no-op */ }
    }
  }, [heroTime, heroPlayer]);

  // Fetch the running "Value of Cars Covered in the last 30 Days" figure
  // so it can be surfaced on the Earn Rewards flip banner. Refreshed on
  // every focus so the number stays live without needing a hard reload.
  const [coversTotal30d, setCoversTotal30d] = useState<number | null>(null);
  const loadCoversTotal = useCallback(async () => {
    try {
      const r = await apiFetch("/api/stats/covers-30d");
      const t = Number((r as any)?.total_zar);
      if (Number.isFinite(t)) setCoversTotal30d(t);
    } catch {
      // Non-fatal — the tile will simply hide the stat row on failure.
    }
  }, []);
  useEffect(() => { loadCoversTotal(); }, [loadCoversTotal]);
  useFocusEffect(useCallback(() => { loadCoversTotal(); }, [loadCoversTotal]));

  // Deal-outcomes reporting tile — counts of submissions grouped by
  // whether the dealer marked "did the deal", "no deal", or hasn't yet
  // answered ("pending outcome"). Scoped to the caller's dealership on
  // the backend; admins see every dealership rolled up. Refreshes on
  // every focus so leaving-and-returning updates the numbers.
  type DealOutcomes = {
    pending: number;
    deal_done: number;
    no_deal: number;
    sold: number;
    total: number;
    gross_profit_zar: number;
  };
  const [dealOutcomes, setDealOutcomes] = useState<DealOutcomes | null>(null);
  const loadDealOutcomes = useCallback(async () => {
    try {
      const r = await apiFetch("/api/stats/deal-outcomes");
      if (r && typeof r === "object") setDealOutcomes(r as DealOutcomes);
    } catch {
      // Non-fatal — the tile stays hidden if the endpoint fails.
    }
  }, []);
  useEffect(() => { loadDealOutcomes(); }, [loadDealOutcomes]);
  useFocusEffect(useCallback(() => { loadDealOutcomes(); }, [loadDealOutcomes]));

  // TradeAPP Rewards — running balance + how far to the next voucher.
  // Powers the redesigned TakealotRewardsTile so dealers can see their
  // points and how much more they need to earn a Takealot voucher, all
  // from the home dashboard. Refreshed on every focus so returning from
  // the Rewards screen (which may have redeemed) immediately reflects
  // the new balance. Admins don't have a rewards ledger so we skip the
  // fetch for them entirely.
  type RewardsSummary = {
    balance: number;
    points_to_next_voucher: number;
    points_per_voucher: number;
    voucher_value_zar: number;
    voucher_provider: string;
    can_redeem: boolean;
  };
  const [rewards, setRewards] = useState<RewardsSummary | null>(null);
  const loadRewards = useCallback(async () => {
    if (user?.role === "admin") {
      setRewards(null);
      return;
    }
    try {
      const r = await apiFetch("/api/rewards/me");
      if (r && typeof r === "object") {
        setRewards({
          balance: Number((r as any).balance) || 0,
          points_to_next_voucher: Number((r as any).points_to_next_voucher) || 0,
          points_per_voucher: Number((r as any).points_per_voucher) || 50,
          voucher_value_zar: Number((r as any).voucher_value_zar) || 500,
          voucher_provider: String((r as any).voucher_provider || "Takealot"),
          can_redeem: !!(r as any).can_redeem,
        });
      }
    } catch {
      // Non-fatal — the tile falls back to its base copy without stats.
    }
  }, [user?.role]);
  useEffect(() => { loadRewards(); }, [loadRewards]);
  useFocusEffect(useCallback(() => { loadRewards(); }, [loadRewards]));

  // How many submissions are currently AVAILABLE for the caller to
  // cover — powers the badge on the "Give Cover" home tile so pricing
  // agents can see at a glance how much fresh work is waiting. Only
  // fetched when the caller is toggled as a pricing agent, and
  // refreshes on every focus so leaving-and-returning to home updates
  // the count without a manual pull-to-refresh.
  const [coversAvailable, setCoversAvailable] = useState<number | null>(null);
  const loadCoversAvailable = useCallback(async () => {
    if (!user?.is_pricing_agent) {
      setCoversAvailable(null);
      return;
    }
    try {
      const r = await apiFetch("/api/cover/submissions");
      const arr = (r as any)?.submissions;
      if (Array.isArray(arr)) {
        // "Available" == subs the agent has NOT covered yet. Cover-
        // given rows come back in the same payload but with a truthy
        // `my_cover` field.
        const n = arr.filter((s: any) => !s.my_cover).length;
        setCoversAvailable(n);
      }
    } catch {
      // Non-fatal — the tile just shows the base hint if the fetch fails.
    }
  }, [user?.is_pricing_agent]);
  useEffect(() => { loadCoversAvailable(); }, [loadCoversAvailable]);
  useFocusEffect(useCallback(() => { loadCoversAvailable(); }, [loadCoversAvailable]));

  // Admin-only — count of incoming (still-to-be-priced) submissions.
  // Powers the badge on the "Submissions" home tile so admins see at
  // a glance whether there's fresh work in the queue. Uses the tiny
  // `/api/admin/submissions/counts` endpoint (no submission payload)
  // so it's safe to refresh on every focus.
  const [incomingCount, setIncomingCount] = useState<number | null>(null);
  const loadIncomingCount = useCallback(async () => {
    if (user?.role !== "admin") {
      setIncomingCount(null);
      return;
    }
    try {
      const r = await apiFetch("/api/admin/submissions/counts");
      const n = (r as any)?.counts?.incoming;
      if (typeof n === "number") setIncomingCount(n);
    } catch {
      // Non-fatal — the tile falls back to the base hint.
    }
  }, [user?.role]);
  useEffect(() => { loadIncomingCount(); }, [loadIncomingCount]);
  useFocusEffect(useCallback(() => { loadIncomingCount(); }, [loadIncomingCount]));

  // Live-loaded advertising slots — replace the hardcoded 3 ads on the
  // "Advertising" tile with whatever the admin has configured via the
  // Admin Cockpit → Advertising module. If none are configured yet we
  // fall back to the bundled sample ads so the tile is never empty.
  // NOTE: declared BEFORE `dynamicTiles` (below) so its useMemo dep array
  // can reference `activeAds` without hitting a Temporal-Dead-Zone error
  // ("Cannot access 'activeAds' before initialization").
  type ActiveAd = { slot_number: number; image_base64: string; dealership_name?: string | null };
  const [activeAds, setActiveAds] = useState<ActiveAd[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch("/api/ads/active");
        if (!cancelled && Array.isArray(r?.ads)) setActiveAds(r.ads);
      } catch { /* ignore — falls back to bundled sample ads */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Dynamic tile list — inject the admin-managed active ads onto the
  // Advertising tile. The "value of cars covered" figure is now rendered
  // as its own standalone banner above the tile row (see below).
  const dynamicTiles = useMemo<Tile[]>(() => {
    return BASE_TILES.map((t) => {
      if (t.key === "ads" && activeAds.length) {
        return {
          ...t,
          ads: activeAds.map((a) => ({
            image: { uri: a.image_base64 },
            label: a.dealership_name || undefined,
          })),
        };
      }
      return t;
    });
  }, [activeAds]);

  // Quick-action cards — the primary tasks a dealer/admin comes here to do.
  // These render as flip tiles between the hero video and the marketing
  // tiles below. Each tile has its own accent colour so the row reads
  // like a legible dashboard at a glance.
  type QuickAction = {
    key: string;
    label: string;
    hint: string;
    icon: keyof typeof Ionicons.glyphMap;
    to: string;
    tint: string;
    // Optional short label (usually a count) that renders as a small
    // pill in the top-right corner of the tile. Used by "Give Cover"
    // to surface the live number of submissions still needing a cover.
    badge?: string;
  };
  const isAdmin = user?.role === "admin";
  const isPricingAgent = !!user?.is_pricing_agent;
  const quickActions: QuickAction[] = isAdmin
    ? [
        { key: "dealers", label: "Dealers", hint: "Approve, edit & manage accounts", icon: "people", to: "/(app)/dealers", tint: "#5B8DEF" },
        { key: "billing", label: "Billing", hint: "Invoices, credits & receipts", icon: "cash", to: "/(app)/billing", tint: "#22C55E" },
        { key: "rewards", label: "Rewards", hint: "Points, referrals & vouchers", icon: "gift", to: "/(app)/rewards", tint: "#F97316" },
        // Submissions tile — replaces the old "History" tile on the
        // admin cockpit (History is already reachable from the bottom
        // tab bar). Badge surfaces the live count of "incoming"
        // submissions still waiting to be priced so admins see the
        // work queue at a glance.
        {
          key: "submissions",
          label: "Submissions",
          hint: incomingCount != null && incomingCount > 0
            ? `${incomingCount} incoming · tap to review`
            : incomingCount === 0
              ? "No incoming submissions"
              : "Incoming · priced · archived",
          icon: "car-sport",
          to: "/(app)/submissions",
          tint: "#A78BFA",
          badge: incomingCount && incomingCount > 0 ? String(incomingCount) : undefined,
        },
        { key: "vin-reports", label: "VIN Reports", hint: "Order OEM & history reports for any VIN", icon: "document-text", to: "/(app)/vin-reports", tint: "#22C55E" },
        // Partner API — Kredo & other resellers. Manage API keys,
        // IP allowlists and rate limits. Same screen as the desktop
        // cockpit's "Partner API" tile — just wrapped for mobile
        // chrome. Admin-only.
        { key: "partner-api", label: "Partner API", hint: "Kredo resellers · keys · IPs · usage", icon: "git-network", to: "/(app)/partner-api", tint: "#14B8A6" },
      ]
    : [
        // ============ TOP ROW (dealer home) ============
        // Ordered exactly per Nov 2026 spec:
        //   1. My Evaluations — dealer's own priced vehicles (routes
        //      to /history, which lists their submissions).
        //   2. Get Cover      — submit a new vehicle for cover.
        //   3. Give Cover     — pricing agents queue (managerial only).
        // Billing has been demoted OUT of tiles and now sits in the
        // bottom-tab bar for a cleaner primary-action row. Stock has
        // been renamed to "Stock List" for clarity.
        // -------------------------------------------------
        {
          key: "my-evaluations",
          label: "My Evaluations",
          hint: "Your priced & pending vehicles",
          icon: "car-sport" as const,
          to: "/(app)/submissions",
          tint: "#EC4899",
        },
        { key: "get-cover", label: "Get Cover", hint: "Submit a vehicle · confirmed cover in 90 s", icon: "flash" as const, to: "/(app)/submit", tint: "#14B8A6" },
        ...(isPricingAgent
          ? [{
              key: "cover",
              label: "Give Cover",
              hint: coversAvailable != null && coversAvailable > 0
                ? `${coversAvailable} car${coversAvailable === 1 ? "" : "s"} waiting · R10 each`
                : coversAvailable === 0
                  ? "No new submissions waiting"
                  : "Price blind submissions · R10 each",
              icon: "shield-checkmark" as const,
              to: "/(app)/cover",
              tint: "#5B8DEF",
              badge: coversAvailable && coversAvailable > 0 ? String(coversAvailable) : undefined,
            }]
          : []),
        // ============ SECONDARY ROW ============
        // Renamed from "Stock" → "Stock List" per Nov 2026 request.
        { key: "stock", label: "Stock List", hint: "Vehicles in stock · aging & pricing", icon: "cube" as const, to: "/(app)/stock", tint: "#8B5CF6" },
        { key: "rewards", label: "Rewards", hint: "Earn points & vouchers", icon: "gift" as const, to: "/(app)/rewards", tint: "#F97316" },
        { key: "suppliers", label: "Suppliers", hint: "Recon suppliers · dealership catalog", icon: "briefcase" as const, to: "/(app)/suppliers", tint: "#0EA5E9" },
        // "VIN Reports" — standalone (no-submission) vendor report
        // ordering. Every user can access it regardless of pricing-
        // agent status. Sits as the 6th tile per Nov 2026 spec.
        { key: "vin-reports", label: "VIN Reports", hint: "Order OEM & history reports for any VIN", icon: "document-text" as const, to: "/(app)/vin-reports", tint: "#22C55E" },
      ];

  const tiles: Tile[] = dynamicTiles;

  // Split out the Ads + hero (trade) tiles so we can render them
  // side-by-side in a dedicated 2-column row on wide screens. On phones
  // both tiles remain in the main tile grid (stacked full-width).
  const adsTile = tiles.find((t) => t.key === "ads") || null;
  const tradeTile = tiles.find((t) => t.key === "trade") || null;
  const otherTiles = tiles.filter((t) => t.key !== "ads" && t.key !== "trade");
  const tilesForGrid = isWide ? otherTiles : tiles;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets + spacing.xl }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.pageMax}>
          {/* Welcome header — greets the user by first name + dealership
              (Aug 2026 client request). Sub-copy removed per same
              request; the dealership name below the greeting grounds
              the page contextually. */}
          <View style={styles.welcomeRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.welcomeEyebrow}>
                {isAdmin ? "ADMIN COCKPIT" : "DEALER PORTAL"}
              </Text>
              <Text style={styles.welcomeTitle} numberOfLines={1}>
                {firstName ? `Welcome ${firstName}` : "Welcome"}
              </Text>
              {!isAdmin && dealershipName ? (
                <Text style={styles.welcomeSub} numberOfLines={2}>
                  from {dealershipName}
                </Text>
              ) : isAdmin ? (
                <Text style={styles.welcomeSub} numberOfLines={2}>
                  Manage submissions, dealers and rewards from one place.
                </Text>
              ) : null}
            </View>
          </View>

          {/* Hero panel — capped height on wide screens so it stops
              swallowing the whole viewport, and full-bleed 16:9 on
              phones.
              Feb 2027 — client asked for the video to play on web too
              (previously we rendered a static text lockup). The
              same expo-video pipeline now drives all platforms; the
              only web-specific override is a shorter max-height so
              the hero doesn't dominate the browser viewport, and a
              tighter maxWidth so the panel stays visually contained.
              */}
          <View>
            <View style={[styles.heroWrap, Platform.OS === "web" && styles.heroWrapWeb]}>
              <Image
                source={HERO_LOGO}
                style={styles.heroPoster}
                resizeMode="cover"
                accessibilityLabel="TradeAPP hero poster"
              />
              <VideoView
                player={heroPlayer}
                style={styles.hero}
                contentFit="cover"
                nativeControls={false}
                allowsFullscreen={false}
                allowsPictureInPicture={false}
                accessibilityLabel="TradeAPP"
              />
            </View>
          </View>

          {/* Quick-nav tiles — the primary secondary-destinations
              (Billing, History, Rewards, Dealers, Kredo, Give Cover…).
              Redesigned 2026-08 as iOS-inspired app-icon "squircles" so
              the grid stays clean on both mobile and web and reads at
              a glance. Rewards uses the same app-icon look, with the
              live points balance surfaced as the icon badge. */}
          <View style={styles.appIconGrid}>
            {quickActions.map((qa) => (
              <View
                key={qa.key}
                style={isWide ? styles.appIconCellWide : styles.appIconCell}
              >
                <AppIconTile
                  label={qa.label}
                  hint={qa.hint}
                  icon={qa.icon}
                  tint={qa.tint}
                  badge={
                    qa.key === "rewards" && rewards?.balance
                      ? String(rewards.balance)
                      : qa.badge
                  }
                  onPress={() => {
                    // Suspension guard: Get Cover (submit valuations)
                    // and Give Cover (place cover offers) both require
                    // an active account. Other tiles are informational
                    // (Billing, History, Rewards…) and remain open.
                    if (qa.key === "get-cover" || qa.key === "cover") {
                      handleGuardedNavigate(qa.to, qa.label);
                      return;
                    }
                    router.push(qa.to as never);
                  }}
                  colors={colors}
                  testID={`app-icon-tile-${qa.key}`}
                />
              </View>
            ))}
          </View>

          {/* Live "Value of Cars Covered in the last 30 Days" banner —
              standalone stat card that sits above the marketing tiles.
              Deliberately NOT a flip tile / not tied to rewards — it's a
              running figure of TradeAPP's real cover activity, formatted
              with comma thousand-separators (en-US). Hidden while the
              stat is loading so the layout doesn't jump. */}
          {coversTotal30d != null ? (
            <View style={styles.coversBannerWrap}>
              <LinearGradient
                colors={[colors.primary + "55", colors.primary + "22", "transparent"]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFill}
                pointerEvents="none"
              />
              <View style={styles.coversBannerRow}>
                <View style={styles.coversBannerIconChip}>
                  <Ionicons name="trending-up" size={26} color={colors.primary} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.coversBannerEyebrow}>LIVE — LAST 30 DAYS</Text>
                  <Text style={styles.coversBannerLabel}>
                    Value of Cars Covered
                  </Text>
                  <Text style={styles.coversBannerValue} testID="covers-banner-value">
                    R{coversTotal30d.toLocaleString("en-US")}
                  </Text>
                </View>
              </View>
            </View>
          ) : null}

          {/* -------- Deal Outcomes reporting tile --------
              Shows PENDING / DEAL DONE / NO DEAL DONE counts for the
              caller's dealership (admins see the global roll-up).
              Renders as three coloured pills + a "sold" callout so the
              dealer can spot pending outcomes at a glance. */}
          {dealOutcomes && dealOutcomes.total > 0 ? (
            <View style={styles.dealStatWrap} testID="deal-outcomes-tile">
              <Pressable
                style={styles.dealStatHead}
                onPress={() => router.push("/(app)/deal-outcomes?bucket=pending" as never)}
                testID="deal-outcomes-header"
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.dealStatEyebrow}>
                    {isAdmin ? "ALL DEALERSHIPS" : "YOUR DEALERSHIP"}
                  </Text>
                  <Text style={styles.dealStatTitle}>Deal Outcomes</Text>
                  <Text style={styles.dealStatSub}>
                    Tap for the 90-day report · outcome & win-rate.
                  </Text>
                </View>
                <View style={styles.dealStatTotalChip}>
                  <Text style={styles.dealStatTotalNum}>{dealOutcomes.total}</Text>
                  <Text style={styles.dealStatTotalLbl}>TOTAL</Text>
                </View>
              </Pressable>
              <View style={styles.dealStatRow}>
                <Pressable
                  style={[styles.dealStatCard, styles.dealStatCardPending]}
                  onPress={() => router.push("/(app)/deal-outcomes?bucket=pending" as never)}
                  testID="deal-outcome-pending"
                >
                  <Ionicons name="hourglass-outline" size={16} color="#E5E7EB" />
                  <Text style={[styles.dealStatValue, { color: "#E5E7EB" }]}>
                    {dealOutcomes.pending}
                  </Text>
                  <Text style={styles.dealStatLabel}>PENDING</Text>
                  <Text style={styles.dealStatHint} numberOfLines={1}>
                    Awaiting outcome
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.dealStatCard, styles.dealStatCardDone]}
                  onPress={() => router.push("/(app)/deal-outcomes?bucket=deal_done" as never)}
                  testID="deal-outcome-done"
                >
                  <Ionicons name="checkmark-circle" size={16} color="#1F7A3A" />
                  <Text style={[styles.dealStatValue, { color: "#1F7A3A" }]}>
                    {dealOutcomes.deal_done}
                  </Text>
                  <Text style={styles.dealStatLabel}>DEAL DONE</Text>
                  <Text style={styles.dealStatHint} numberOfLines={1}>
                    {dealOutcomes.sold} sold
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.dealStatCard, styles.dealStatCardNo]}
                  onPress={() => router.push("/(app)/deal-outcomes?bucket=no_deal" as never)}
                  testID="deal-outcome-no"
                >
                  <Ionicons name="close-circle" size={16} color="#DC2626" />
                  <Text style={[styles.dealStatValue, { color: "#DC2626" }]}>
                    {dealOutcomes.no_deal}
                  </Text>
                  <Text style={styles.dealStatLabel}>NO DEAL</Text>
                  <Text style={styles.dealStatHint} numberOfLines={1}>
                    Not proceeded
                  </Text>
                </Pressable>
              </View>
              {/* Gross-profit strip removed Nov 2026 — the number was
                  informational rather than actionable and dealers found
                  it distracting under the primary Deal Outcomes counts. */}
            </View>
          ) : null}

          {/* Section heading above the marketing tiles on wide — helps
              signpost that the below area is the pitch, not primary UI. */}
          {isWide ? (
            <View style={styles.sectionHead}>
              <Text style={styles.sectionEyebrow}>WHY TRADEAPP</Text>
              <Text style={styles.sectionTitle}>Everything you need to trade with confidence</Text>
            </View>
          ) : null}

          {/* Compact iOS-style app-icon grid for quick-nav tiles. Renders
              4-up on phones and 6-up on wide screens. Sits above the
              marketing/hero tiles so the primary destinations are the
              first thing the eye lands on. */}

          {/* Flip-tiles */}
          <View style={styles.cardsWrap}>
            {tilesForGrid.map((t) => (
              <View
                key={t.key}
                style={[
                  styles.tileCol,
                  // Hero tiles get their own full-width layout so the
                  // 2:1 cinematic images can breathe — a tile jammed
                  // into a 1/3 grid cell crops off the right-hand
                  // product-mock preview.
                  t.heroes ? styles.tileColHero : null,
                ]}
              >
                <FlipTile
                  tile={t}
                  styles={styles}
                  colors={colors}
                  autoRotateMs={t.key === "ads" ? 5000 : 0}
                />
              </View>
            ))}
          </View>

          {/* Wide-screen only: Trade heroes tile + Advertising tile
              side-by-side in ONE row. Both share the same total width
              as every other section on the page (welcome header, hero
              logo panel, app-icon row, live cover-value banner) so the
              layout reads as a coherent centred column. On phones the
              two tiles fall through the flip-tile grid above (stacked
              full-width) so this row is wide-only.
              The heroes tile keeps a wider column (58%) than ads (42%)
              because the baked-in 2:1 cinematic images carry marketing
              copy on the left AND a UI preview mock on the right — a
              50/50 split cropped the mock. Both tiles are the SAME
              vertical height so the row reads as balanced. */}
          {isWide && (tradeTile || adsTile) ? (
            <View style={styles.heroAdRow}>
              {tradeTile ? (
                <View style={styles.heroAdLeftCol}>
                  <FlipTile
                    tile={tradeTile}
                    styles={styles}
                    colors={colors}
                    autoRotateMs={0}
                    outerStyle={styles.heroAdTileOuter}
                  />
                </View>
              ) : null}
              {adsTile ? (
                <View style={styles.heroAdRightCol}>
                  <FlipTile
                    tile={adsTile}
                    styles={styles}
                    colors={colors}
                    autoRotateMs={5000}
                    outerStyle={styles.heroAdTileOuter}
                  />
                </View>
              ) : null}
            </View>
          ) : null}

          <View style={styles.hintRow}>
            <Ionicons name="finger-print-outline" size={14} color={colors.textSecondary} />
            <Text style={styles.hintText}>Tap any card to flip through — one point at a time.</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// NavFlipTile — quick-navigation tile with a brief flip animation on tap
// before navigating. Renders an icon chip, label, hint, and an "Open →"
// caret. Used above the marketing tiles on the home page as a portal
// into secondary sections (Billing, History, Rewards, Give Cover, etc.)
// so the bottom tab bar can stay lean.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// TakealotRewardsTile — co-branded Rewards tile matching the app's dark
// theme.
//
// Redesigned 2026-08-10: the tile now surfaces the dealer's live points
// balance + a progress bar toward their next voucher, and gives the
// Takealot logo a much more prominent stage (a full-width branded chip
// at the bottom, not a "powered by" footer footnote). This turns the
// tile from a static landing card into a glanceable rewards HUD.
// ---------------------------------------------------------------------------
type RewardsSummary = {
  balance: number;
  points_to_next_voucher: number;
  points_per_voucher: number;
  voucher_value_zar: number;
  voucher_provider: string;
  can_redeem: boolean;
};

function TakealotRewardsTile({
  onNavigate,
  styles,
  colors,
  rewards,
}: {
  onNavigate: () => void;
  styles: ReturnType<typeof makeStyles>;
  colors: Palette;
  rewards: RewardsSummary | null;
}) {
  const rot = useSharedValue(0);
  const scale = useSharedValue(1);
  const faceStyle = useAnimatedStyle(() => ({
    transform: [
      { perspective: 900 },
      { rotateY: `${rot.value * 180}deg` },
      { scale: scale.value },
    ],
  }));
  const onTap = useCallback(() => {
    rot.value = withSequence(
      withTiming(0.5, { duration: 140, easing: Easing.in(Easing.cubic) }, () => {
        runOnJS(onNavigate)();
      }),
      withTiming(0, { duration: 300, easing: Easing.out(Easing.cubic) }),
    );
    scale.value = withSequence(
      withTiming(0.96, { duration: 140 }),
      withTiming(1, { duration: 300 }),
    );
  }, [rot, scale, onNavigate]);

  // Same orange tint as the original Rewards nav tile — keeps the tile
  // visually consistent with its sibling NavFlipTiles (Get Cover ·
  // Billing · History) which all use tint-coloured icon chips.
  const tint = "#F97316";

  // Progress toward the next voucher (0..1). If rewards haven't loaded
  // yet or the balance is already past a voucher threshold, we clamp to
  // sensible bounds so the bar never looks broken.
  const perVoucher = rewards?.points_per_voucher || 50;
  const balance = rewards?.balance ?? 0;
  const toNext = rewards?.points_to_next_voucher ?? perVoucher;
  const progressPointsInCurrentCycle = Math.max(0, perVoucher - toNext);
  const progress = rewards
    ? Math.max(0, Math.min(1, progressPointsInCurrentCycle / perVoucher))
    : 0;
  const voucherR = rewards?.voucher_value_zar ?? 500;
  const canRedeem = !!rewards?.can_redeem;

  return (
    <Pressable
      onPress={onTap}
      accessibilityRole="button"
      accessibilityLabel={
        rewards
          ? `TradeAPP Rewards. ${balance} points. ${toNext} points until your next R${voucherR} Takealot voucher.`
          : "TradeAPP Rewards, powered by takealot.com"
      }
      testID="rewards-takealot-tile"
      style={({ pressed }) => [{ opacity: pressed ? 0.92 : 1 }]}
    >
      <Animated.View
        style={[
          styles.quickCard,
          { borderColor: tint + "44" },
          faceStyle,
        ]}
      >
        {/* Same 56dp orange icon chip as the original Rewards NavFlip
            tile — keeps the tile visually consistent with its row-
            mates (Get Cover / Billing / History). */}
        <View
          style={[
            styles.quickIconChip,
            { backgroundColor: tint + "22", borderColor: tint + "66" },
          ]}
        >
          <Ionicons name="gift" size={26} color={tint} />
        </View>

        {/* Tile label — same size/weight as sibling NavFlipTiles. */}
        <Text style={[styles.quickCardLabel, { color: colors.text }]}>Rewards</Text>

        {/* Live balance row — replaces the usual "hint" line with a
            hero data point. Reads as "6 pts" in the tile's tint colour
            so the number pops without breaking the tile's look. */}
        <View style={styles.rewardsBalanceRow}>
          <Text style={[styles.rewardsBalanceNum, { color: tint }]}>
            {rewards ? balance : "—"}
          </Text>
          <Text style={[styles.rewardsBalanceUnit, { color: colors.textSecondary }]}>pts</Text>
        </View>

        {/* Progress bar toward the next voucher — thin tinted fill on
            the theme border colour so it feels of-a-piece with the
            tile rather than shouting. */}
        <View style={[styles.rewardsProgressTrack, { backgroundColor: colors.border }]}>
          <View
            style={[
              styles.rewardsProgressFill,
              { width: `${Math.round(progress * 100)}%`, backgroundColor: tint },
            ]}
          />
        </View>

        {/* Live sub-label — mirrors the "hint" line on sibling tiles
            so tile-to-tile alignment stays consistent. */}
        <Text style={styles.rewardsProgressLabel} numberOfLines={2}>
          {rewards
            ? canRedeem
              ? `Ready to redeem for R${voucherR}`
              : `${toNext} pts to next R${voucherR} voucher`
            : "Points, referrals & vouchers"}
        </Text>
      </Animated.View>
    </Pressable>
  );
}


function NavFlipTile({
  label, hint, icon, tint, badge, onNavigate, styles, colors,
}: {
  label: string;
  hint: string;
  icon: keyof typeof Ionicons.glyphMap;
  tint: string;
  badge?: string;
  onNavigate: () => void;
  styles: ReturnType<typeof makeStyles>;
  colors: Palette;
}) {
  const rot = useSharedValue(0);
  const scale = useSharedValue(1);
  const faceStyle = useAnimatedStyle(() => ({
    transform: [
      { perspective: 900 },
      { rotateY: `${rot.value * 180}deg` },
      { scale: scale.value },
    ],
  }));
  const onTap = useCallback(() => {
    // Brief flip forward, run the router.push while the tile is
    // face-down (so the navigation feels like the tile *is* the
    // destination), then unwind so it doesn't get stuck backwards.
    rot.value = withSequence(
      withTiming(0.5, { duration: 140, easing: Easing.in(Easing.cubic) }, () => {
        runOnJS(onNavigate)();
      }),
      withTiming(0, { duration: 300, easing: Easing.out(Easing.cubic) }),
    );
    scale.value = withSequence(
      withTiming(0.96, { duration: 140 }),
      withTiming(1, { duration: 300 }),
    );
  }, [rot, scale, onNavigate]);
  return (
    <Pressable
      onPress={onTap}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      style={({ pressed }) => [{ opacity: pressed ? 0.9 : 1 }]}
    >
      <Animated.View style={[styles.quickCard, { borderColor: tint + "44" }, faceStyle]}>
        {/* Soft coloured gradient wash that hints at each tile's identity
            without dominating the card. Colour → transparent so the card
            still reads as part of the surrounding surface. */}
        <LinearGradient
          colors={[tint + "33", tint + "0D", "transparent"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        {/* Large filled icon chip (centered) — the primary graphic hook.
            Uses the tile's tint at 22% background + solid tint for the
            icon so it pops on both light and dark themes. */}
        <View
          style={[
            styles.quickIconChip,
            { backgroundColor: tint + "22", borderColor: tint + "77" },
          ]}
        >
          <Ionicons name={icon} size={28} color={tint} />
        </View>
        <Text style={[styles.quickCardLabel, { color: colors.text }]}>{label}</Text>
        {/* Aug 2026: description under the tile label removed per
            request — the label + icon alone communicate the module.
            The `hint` prop is kept in the signature for a11y (screen
            readers announce the tile's purpose via accessibilityHint)
            but no longer rendered visually. */}
        {/* Live count pill — rendered ABSOLUTELY in the tile's top-right
            corner. Only shown when the caller provided a `badge` string
            (currently used by the "Give Cover" tile to surface how many
            submissions are still waiting for a cover). */}
        {badge ? (
          <View
            style={[
              styles.quickCardBadge,
              { backgroundColor: tint, borderColor: tint },
            ]}
            pointerEvents="none"
            accessibilityLabel={`${badge} waiting`}
          >
            <Text style={styles.quickCardBadgeTxt} numberOfLines={1}>
              {badge}
            </Text>
          </View>
        ) : null}
      </Animated.View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// FlipTile — cycles through pages on tap with a flip-fade animation.
// ---------------------------------------------------------------------------
type FlipTileProps = {
  tile: Tile;
  styles: ReturnType<typeof makeStyles>;
  colors: Palette;
  // When >0, the tile auto-advances to the next page every N ms. A manual
  // tap resets the timer so users don't get skipped mid-read. Set to 0
  // (default) for tap-only tiles.
  autoRotateMs?: number;
  // Optional style override applied to the outer Pressable. Used by the
  // "promoted ad tile" in the hero row so it can stretch to fill its
  // column instead of using the default fixed `TILE_HEIGHT`.
  outerStyle?: any;
};

function FlipTile({ tile, styles, colors, autoRotateMs = 0, outerStyle }: FlipTileProps) {
  // Total pages:
  //   * `heroes` tiles = one page per hero image (no front / no footer).
  //   * `ads` tiles    = one page per ad (no front / no footer either — the
  //     ads are self-explanatory, and the old "Advertising · Featured
  //     partners" front page was just eating an impression the paying
  //     partners deserved).
  //   * Bullet-point tiles = 1 (front) + points + optional footer.
  const totalPages = tile.heroes
    ? tile.heroes.length
    : tile.ads
      ? tile.ads.length
      : 1 + (tile.points?.length ?? 0) + (tile.footer ? 1 : 0);
  const [idx, setIdx] = useState(0);
  const rot = useSharedValue(0);       // 0..1 flip progress (bullet + hero tiles)
  const scale = useSharedValue(1);
  // Ads tile uses a totally different transition: DISINTEGRATE +
  // MATERIALIZE. `dissolve` sweeps 0 → 1 → 0 per cycle. At the peak
  // (1) the current ad is fully invisible / scaled down / blurred out,
  // and we swap `idx` to the next ad. The value then eases back to 0
  // and the new ad materializes on the same face. See the styles
  // below for the interpolation. On web we lean on CSS `filter: blur()`
  // for the actual disintegration look; on native (where blur isn't
  // free) the effect degrades gracefully to opacity + scale.
  const dissolve = useSharedValue(0);

  const setNext = useCallback(() => {
    setIdx((prev) => (prev + 1) % totalPages);
  }, [totalPages]);

  const flipToNext = useCallback(() => {
    rot.value = withSequence(
      withTiming(1, { duration: 220, easing: Easing.in(Easing.cubic) }, () => {
        runOnJS(setNext)();
      }),
      withTiming(0, { duration: 260, easing: Easing.out(Easing.cubic) }),
    );
    scale.value = withSequence(
      withTiming(0.96, { duration: 220 }),
      withTiming(1, { duration: 260 }),
    );
  }, [rot, scale, setNext]);

  // Disintegrate transition for the Ads tile. Total cycle ~1.0 s
  // (450 ms fade-out + 550 ms fade-in) — deliberately longer than the
  // 220/260 ms flip because the blur-and-scale motion needs breathing
  // room to read as a disintegration rather than a jittery cross-fade.
  const disintegrateToNext = useCallback(() => {
    dissolve.value = withSequence(
      withTiming(1, { duration: 450, easing: Easing.in(Easing.quad) }, () => {
        runOnJS(setNext)();
      }),
      withTiming(0, { duration: 550, easing: Easing.out(Easing.quad) }),
    );
  }, [dissolve, setNext]);

  // Advance strategy: ads → disintegrate; everything else → flip.
  const advance = useCallback(() => {
    if (tile.ads) {
      disintegrateToNext();
    } else {
      flipToNext();
    }
  }, [tile.ads, disintegrateToNext, flipToNext]);

  // Auto-rotate: for the Advertising tile we cycle without requiring a
  // tap so dealers always see fresh advertisers even when idle. The timer
  // is reset on every manual tap (interaction wins over the automation
  // so users can never be "skipped" mid-read). Paused when the tab is
  // hidden to save battery / avoid off-screen animation.
  const lastTapAtRef = useRef<number>(0);
  useEffect(() => {
    if (!autoRotateMs || autoRotateMs <= 0) return;
    if (totalPages < 2) return;
    const id = setInterval(() => {
      // If the user tapped recently, skip this tick — gives them a grace
      // window to keep reading whatever they just flipped to.
      if (Date.now() - lastTapAtRef.current < autoRotateMs) return;
      advance();
    }, autoRotateMs);
    return () => clearInterval(id);
  }, [autoRotateMs, advance, totalPages]);

  const onTap = useCallback(() => {
    lastTapAtRef.current = Date.now();
    advance();
  }, [advance]);

  const faceStyle = useAnimatedStyle(() => {
    const deg = rot.value * 180;
    return {
      transform: [{ perspective: 900 }, { rotateY: `${deg}deg` }, { scale: scale.value }],
      opacity: rot.value < 0.5 ? 1 : 0,
    };
  });

  const nextFaceStyle = useAnimatedStyle(() => {
    const deg = 180 - rot.value * 180;
    return {
      transform: [{ perspective: 900 }, { rotateY: `${-deg}deg` }, { scale: scale.value }],
      opacity: rot.value >= 0.5 ? 1 : 0,
    };
  });

  // Disintegrate face style — a single face (no back-face needed
  // because we hard-swap idx at the peak). Interpolates opacity,
  // scale, and (on web) a blur filter continuously from the dissolve
  // shared value. At `dissolve = 0` the ad is crisp and fully opaque;
  // at `dissolve = 1` it's blurred, faded, and shrunk — the moment
  // right after the swap we run in reverse so the next ad
  // materializes from the same "particle cloud".
  const dissolveFaceStyle = useAnimatedStyle(() => {
    const d = dissolve.value;
    return {
      opacity: 1 - d,
      transform: [{ scale: 1 - d * 0.15 }],
      // @ts-ignore web-only CSS filter passthrough
      filter: Platform.OS === "web" ? `blur(${d * 12}px)` : undefined,
    };
  });

  // Current & next page content — pre-compute so both faces stay in sync
  // during the animation without stale-closure surprises.
  const nextIdx = (idx + 1) % totalPages;
  const CurrentContent = <TilePage tile={tile} pageIdx={idx} styles={styles} colors={colors} />;
  const NextContent = <TilePage tile={tile} pageIdx={nextIdx} styles={styles} colors={colors} />;

  return (
    <Pressable
      onPress={onTap}
      style={[styles.tileOuter, tile.heroes ? styles.tileOuterHero : null, outerStyle]}
      accessibilityRole="button"
      accessibilityLabel={`${tile.title} card. Tap to see next.`}
    >
      {tile.ads ? (
        // ADS TILE — disintegrate/materialize transition on a single
        // face. Both faces are rendered but the "next" one is only
        // used as a pre-warm so the first swap doesn't flash a blank
        // frame; it stays visually hidden underneath.
        <>
          <Animated.View style={[styles.tileFace, styles.tileFaceHiddenInitial]} pointerEvents="none">
            {NextContent}
          </Animated.View>
          <Animated.View style={[styles.tileFace, dissolveFaceStyle]} pointerEvents="none">
            {CurrentContent}
          </Animated.View>
        </>
      ) : (
        // Everything else — flip transition (two rotated faces).
        <>
          {/* Next face rendered first (below), starts fully hidden and
              only fades in via nextFaceStyle when rot >= 0.5. This
              ordering + the initial opacity: 0 stops a full-bleed ad
              from bleeding through the front page on web where
              reanimated may apply its animated style on the next
              paint frame. */}
          <Animated.View style={[styles.tileFace, styles.tileFaceHiddenInitial, nextFaceStyle]} pointerEvents="none">
            {NextContent}
          </Animated.View>
          <Animated.View style={[styles.tileFace, faceStyle]} pointerEvents="none">
            {CurrentContent}
          </Animated.View>
        </>
      )}

      {/* Pagination dots removed at the user's request — the flip
          animation itself communicates that there's more content, and
          the white progress-bar dots weren't reading well against the
          new full-bleed cinematic hero imagery (or in night mode over
          dark advertisements). Auto-rotate + tap-to-advance both
          remain intact. */}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// TilePage — renders a single page inside a FlipTile.
// pageIdx 0 = front (title/subtitle). 1..N = point/ad. Last = footer text.
// ---------------------------------------------------------------------------
function TilePage({ tile, pageIdx, styles, colors }: { tile: Tile; pageIdx: number; styles: ReturnType<typeof makeStyles>; colors: Palette }) {
  // Hero-cycle tile — full-bleed image, no overlay. `resizeMode="contain"`
  // gives us pixel-accurate framing at any tile aspect (mobile portrait
  // included) without ever cropping off the baked-in title text or UI
  // preview mock. The images already sit on a solid #000 background so
  // any letterbox strip is completely invisible against the tile's
  // matching black backdrop.
  if (tile.heroes) {
    const src = tile.heroes[pageIdx];
    if (!src) return null;
    return (
      <View style={styles.pageHero}>
        <Image source={src} style={styles.heroImg} resizeMode="contain" />
      </View>
    );
  }

  // Ad tiles skip the front / footer pages entirely — every page is
  // one ad slot (see totalPages calc in FlipTile). Renders full-bleed
  // image with a small "ADVERTISING" pill in the top-left corner.
  if (tile.ads) {
    const ad = tile.ads[pageIdx];
    if (!ad) return null;
    return (
      <View style={styles.pageAd}>
        <Image source={ad.image} style={styles.adImg} resizeMode="contain" />
        <View style={styles.adBadge}>
          <Ionicons name="megaphone-outline" size={10} color="#fff" />
          <Text style={styles.adBadgeText}>ADVERTISING</Text>
        </View>
      </View>
    );
  }

  // Front page (bullet-point tiles only — heroes + ads skip this earlier).
  if (pageIdx === 0) {
    // Lifestyle-image front (currently only the "Trade with Confidence" tile).
    if (tile.frontImage) {
      return (
        <View style={styles.pageFrontImageWrap}>
          <Image source={tile.frontImage} style={styles.frontBgImage} resizeMode="cover" />
          <LinearGradient
            colors={["rgba(0,0,0,0.85)", "rgba(0,0,0,0.35)", "rgba(0,0,0,0)"]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFill}
          />
          <LinearGradient
            colors={["rgba(0,0,0,0)", "rgba(0,0,0,0.55)"]}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.pageFrontOverlay}>
            <View style={styles.iconChipOnImage}>
              <Ionicons name={tile.icon} size={20} color="#0A0A0A" />
            </View>
            <Text style={styles.frontTitleOnImage} numberOfLines={2}>{tile.title}</Text>
            {tile.subtitle ? (
              <Text style={styles.frontSubOnImage} numberOfLines={2}>{tile.subtitle}</Text>
            ) : null}
          </View>
        </View>
      );
    }
    return (
      <View style={styles.pageFront}>
        <View style={styles.iconChip}>
          <Ionicons name={tile.icon} size={22} color={colors.text} />
        </View>
        <Text style={styles.frontTitle}>{tile.title}</Text>
        {tile.subtitle ? <Text style={styles.frontSub}>{tile.subtitle}</Text> : null}
      </View>
    );
  }

  // Footer page (only for bullet tiles that define one)
  if (tile.footer && pageIdx === (tile.points?.length ?? 0) + 1) {
    return (
      <View style={styles.pageFooter}>
        <Ionicons name="sparkles" size={24} color={colors.textSecondary} />
        <Text style={styles.footerText}>{tile.footer}</Text>
      </View>
    );
  }

  // Bullet point
  const point = tile.points?.[pageIdx - 1];
  if (!point) return null;
  return (
    <View style={styles.pagePoint}>
      <View style={styles.pointNumRow}>
        <View style={styles.pointNumChip}>
          <Text style={styles.pointNumText}>{pageIdx}</Text>
        </View>
        <Text style={styles.pointEyebrow}>{tile.title.toUpperCase()}</Text>
      </View>
      <View style={styles.pointBody}>
        <View style={styles.pointIconChip}>
          <Ionicons name={point.icon || "checkmark-circle"} size={22} color={colors.text} />
        </View>
        <Text style={styles.pointText}>{point.text}</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const TILE_HEIGHT_MOBILE = 220;
const TILE_HEIGHT_WIDE = 260;
const PAGE_MAX_WIDTH = 1200;

const makeStyles = (colors: Palette, isWide: boolean, windowWidth: number = 0) => {
  const TILE_HEIGHT = isWide ? TILE_HEIGHT_WIDE : TILE_HEIGHT_MOBILE;
  // Mobile hero tile height = (viewport width - horizontal page padding) / 2
  // so the 2:1 hero images render at their intended aspect ratio without
  // side-cropping the baked-in headline text. Falls back to a sensible
  // default when window width isn't available yet.
  const heroMobileHeight = windowWidth
    ? Math.round((windowWidth - spacing.md * 2) / 2)
    : 180;
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.bg },
    scroll: {
      paddingHorizontal: isWide ? spacing.xl : spacing.md,
      paddingTop: isWide ? spacing.xl : spacing.sm,
      alignItems: "center", // centres pageMax on wide screens
    },
    // On wide screens everything sits inside a centred column with a max
    // width — otherwise the mobile design stretches full-bleed and looks
    // like a phone dumped in the middle of a desktop.
    pageMax: {
      width: "100%",
      maxWidth: PAGE_MAX_WIDTH,
      gap: isWide ? spacing.xl : spacing.md,
    },

    // Welcome header ------------------------------------------------------
    welcomeRow: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: spacing.md,
    },
    welcomeEyebrow: {
      color: colors.textSecondary,
      fontSize: 11,
      letterSpacing: 2.2,
      fontWeight: "700",
      marginBottom: 4,
    },
    welcomeTitle: {
      ...fonts.h1,
      color: colors.text,
      fontSize: isWide ? 32 : 24,
      letterSpacing: -0.5,
    },
    welcomeSub: {
      color: colors.textSecondary,
      fontSize: isWide ? 15 : 13,
      lineHeight: 22,
      marginTop: 4,
      maxWidth: 560,
    },

    // Hero video ----------------------------------------------------------
    // On wide screens the hero panel becomes a two-column row that
    // docks the Advertising flip-tile to the right of the TradeAPP
    // brand banner. The TradeAPP panel shrinks to ~62% width so both
    // banners feel balanced (the ad panel needs a workable minimum
    // width to render its full-bleed brand images legibly).
    heroRow: {
      flexDirection: "row",
      gap: spacing.md,
      alignItems: "stretch",
    },
    heroWrap: {
      width: "100%",
      aspectRatio: 16 / 9,
      maxHeight: isWide ? 360 : undefined,
      borderRadius: radius.lg,
      overflow: "hidden",
      // Solid black so the "contain"-fit logo image on web blends with
      // the artwork's own black background instead of showing a paper
      // stripe on either side.
      backgroundColor: "#000",
      ...Platform.select({
        ios: { shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } },
        android: { elevation: 3 },
      }),
    },
    heroWrapWithAd: {
      // 62% width leaves enough room for the ad tile (~35% + gap) and
      // preserves the 16:9 aspect ratio so nothing gets stretched.
      flex: 0.62,
      width: undefined as any,
      aspectRatio: undefined as any,
      maxHeight: undefined,
    },
    heroAdCol: {
      // Companion ad column — matches the shrunk hero's height via
      // stretch alignment so the two panels are exactly the same
      // vertical size regardless of content aspect.
      flex: 0.38,
      minHeight: 200,
      // Cap the maximum height so the ad panel never dwarfs the
      // TradeAPP banner on ultra-wide screens.
      maxHeight: 360,
      borderRadius: radius.lg,
      overflow: "hidden",
    },
    // Applied to the promoted ad FlipTile's outer Pressable — strips
    // the default `TILE_HEIGHT` fixed height and lets it fill the
    // parent column, so the banner sits at exactly the same height
    // as the neighbouring TradeAPP panel.
    heroAdOuter: {
      height: "100%",
      width: "100%",
      flex: 1,
    },
    hero: { width: "100%", height: "100%" },
    heroPoster: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, width: "100%", height: "100%" },
    // Web override — drop the black boxed backdrop so the TRADE AI
    // wordmark sits directly on the surrounding surface. Also removes
    // the platform shadow (transparent element casting a shadow
    // reads as visual noise) and cuts the max height so the mark
    // doesn't dominate the viewport.
    // Feb 2027 — web hero now plays the same cinematic video that
    // native uses. Kept the max-height slim (was 220/180 → now
    // 260/200) and added a centred maxWidth so the hero doesn't
    // sprawl across ultra-wide browser windows. The 16:9 aspect
    // inherited from `heroWrap` still governs the actual size, so
    // shorter windows collapse the panel proportionally.
    heroWrapWeb: {
      maxHeight: isWide ? 260 : 200,
      maxWidth: 720,
      alignSelf: "center",
      width: "100%",
    },
    webLogoLockup: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
    },
    webLogoRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    webLogoTrade: {
      color: colors.text,
      // Sized so the lockup reads as a hero on wide screens but
      // gracefully compacts on phones (which never see this branch
      // anyway — kept responsive as a safety net).
      fontSize: isWide ? 56 : 40,
      fontWeight: "800",
      letterSpacing: isWide ? 6 : 4,
      lineHeight: isWide ? 60 : 44,
      fontFamily: fonts.heading,
    },
    webLogoAiChip: {
      backgroundColor: colors.text,
      paddingHorizontal: isWide ? 14 : 10,
      paddingVertical: isWide ? 4 : 3,
      borderRadius: 6,
    },
    webLogoAiText: {
      color: colors.paper,
      fontSize: isWide ? 44 : 32,
      fontWeight: "900",
      letterSpacing: 1,
      lineHeight: isWide ? 48 : 36,
      fontFamily: fonts.heading,
    },
    webLogoTagline: {
      color: colors.textSecondary,
      fontSize: isWide ? 13 : 11,
      fontWeight: "700",
      letterSpacing: isWide ? 5 : 3,
      marginTop: 4,
    },
    // Clean static hero — TRADE AI wordmark centred on a dark panel
    // with a soft cyan radial-style glow behind it. Consistent look
    // across iOS, Android and Web; a future video / animation can
    // slot in without touching the surrounding grid.
    heroPanel: {
      width: "100%",
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "#0A0F1E",
      paddingHorizontal: spacing.xl,
      paddingVertical: spacing.md,
      position: "relative",
      overflow: "hidden",
    },
    // Soft cyan halo positioned behind the logo — pure View with
    // border-radius so it renders identically everywhere. Acts as a
    // subtle "spotlight" without needing shaders or gradients.
    heroGlow: {
      position: "absolute",
      width: "70%",
      aspectRatio: 1,
      borderRadius: 999,
      backgroundColor: "#22D3EE",
      opacity: 0.12,
      // Web-only extra soft-blur for a nicer halo when supported;
      // native platforms already look great without it.
      ...Platform.select({
        // @ts-ignore — RN-Web only property
        web: { filter: "blur(40px)" } as any,
        default: {},
      }),
    },
    heroLogoImg: {
      width: "62%",
      height: "62%",
      maxWidth: 260,
      maxHeight: 260,
      minHeight: 120,
    },
    heroDivider: {
      width: 48,
      height: 2,
      backgroundColor: "#22D3EE",
      borderRadius: 1,
      marginTop: spacing.sm,
      marginBottom: 8,
      opacity: 0.75,
    },
    heroTagline: {
      color: "rgba(255,255,255,0.72)",
      fontSize: 11,
      fontWeight: "800",
      letterSpacing: 3,
      textAlign: "center",
    },

    // "Value of Cars Covered" banner --------------------------------
    coversBannerWrap: {
      position: "relative",
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.primary + "55",
      backgroundColor: colors.paper,
      overflow: "hidden",
      padding: isWide ? spacing.lg : spacing.md,
      marginTop: spacing.md,
      marginBottom: spacing.md,
      // Slight shadow to lift the banner off the page.
      shadowColor: "#000",
      shadowOpacity: 0.25,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 3,
    },
    coversBannerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
    },
    coversBannerIconChip: {
      width: 56, height: 56, borderRadius: 28,
      backgroundColor: colors.primary + "22",
      borderWidth: 1.5,
      borderColor: colors.primary + "77",
      alignItems: "center", justifyContent: "center",
    },
    coversBannerEyebrow: {
      color: colors.primary,
      fontSize: 10,
      letterSpacing: 2,
      fontWeight: "800",
      textTransform: "uppercase",
      marginBottom: 2,
    },
    coversBannerLabel: {
      color: colors.textSecondary,
      fontSize: isWide ? 14 : 13,
      fontWeight: "600",
      marginBottom: 2,
    },
    coversBannerValue: {
      color: colors.text,
      fontSize: isWide ? 42 : 32,
      fontWeight: "800",
      letterSpacing: -1,
      fontFamily: fonts.number,
      fontVariant: ["tabular-nums"],
      lineHeight: isWide ? 48 : 38,
    },
    // -------- Deal Outcomes reporting tile --------
    dealStatWrap: {
      marginTop: spacing.md,
      padding: isWide ? spacing.lg : spacing.md,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      gap: spacing.sm,
    },
    dealStatHead: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: spacing.md,
    },
    dealStatEyebrow: {
      color: colors.textSecondary,
      fontSize: 10,
      fontWeight: "800",
      letterSpacing: 1.2,
      marginBottom: 2,
    },
    dealStatTitle: {
      color: colors.text,
      fontSize: isWide ? 20 : 17,
      fontWeight: "800",
      letterSpacing: -0.3,
    },
    dealStatSub: {
      color: colors.textSecondary,
      fontSize: 12,
      marginTop: 2,
      lineHeight: 16,
    },
    dealStatTotalChip: {
      minWidth: 64,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.paper,
      alignItems: "center",
    },
    dealStatTotalNum: {
      color: colors.text,
      fontSize: isWide ? 26 : 22,
      fontWeight: "800",
      fontFamily: fonts.number,
      fontVariant: ["tabular-nums"],
      letterSpacing: -0.5,
    },
    dealStatTotalLbl: {
      color: colors.textSecondary,
      fontSize: 9,
      fontWeight: "800",
      letterSpacing: 1,
      marginTop: 1,
    },
    dealStatRow: {
      flexDirection: "row",
      gap: spacing.sm,
      marginTop: spacing.xs,
    },
    dealStatCard: {
      flex: 1,
      minWidth: 90,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      alignItems: "flex-start",
      gap: 4,
    },
    // Pending → monochrome / near-black: neutral surface with a hair-
    // line white outline. Reads as "not yet answered" without shouting.
    dealStatCardPending: {
      borderColor: "#FFFFFF" + "22",
      backgroundColor: "#111111",
    },
    // Deal done → green (unchanged).
    dealStatCardDone: {
      borderColor: "#1F7A3A" + "55",
      backgroundColor: "#1F7A3A" + "14",
    },
    // No deal → red tint so it reads as a clear negative outcome.
    dealStatCardNo: {
      borderColor: "#DC2626" + "55",
      backgroundColor: "#DC2626" + "14",
    },
    dealStatValue: {
      fontSize: isWide ? 32 : 26,
      fontWeight: "800",
      fontFamily: fonts.number,
      fontVariant: ["tabular-nums"],
      letterSpacing: -0.6,
      lineHeight: isWide ? 36 : 30,
    },
    dealStatLabel: {
      color: colors.text,
      fontSize: 11,
      fontWeight: "800",
      letterSpacing: 0.8,
    },
    dealStatHint: {
      color: colors.textSecondary,
      fontSize: 11,
      marginTop: 1,
    },
    dealStatProfitStrip: {
      marginTop: spacing.xs,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.paper,
    },
    dealStatProfitLbl: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: "600",
      flex: 1,
    },
    dealStatProfitVal: {
      fontSize: 15,
      fontWeight: "800",
      fontFamily: fonts.number,
      fontVariant: ["tabular-nums"],
      letterSpacing: -0.3,
    },
    // Quick-nav tile grid (all viewports) --------------------------------
    quickGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing.sm,
      marginTop: spacing.sm,
    },
    quickCardCol: isWide
      ? {
          // 3-up on wide screens: fill the row nicely and let overflow
          // wrap onto a second row for 5+ items (admin).
          flexBasis: `${(100 - 2 * 2) / 3}%`,
          flexGrow: 1,
          minWidth: 220,
        }
      : {
          // Two-up on mobile so every tile has a comfortable touch target
          // (~150-160dp wide at phone widths).
          flexBasis: "48%",
          flexGrow: 1,
        },
    // Constrain the Rewards tile column to the SAME width as its
    // NavFlipTile siblings so it doesn't stretch across the entire
    // second row when it wraps to a new line on desktop. `flexGrow: 0`
    // + `maxWidth` do the trick without breaking the flex layout on
    // narrower viewports.
    quickCardColRewards: isWide
      ? { flexGrow: 0, maxWidth: `${(100 - 2 * 2) / 3}%` }
      : { flexGrow: 0, maxWidth: "48%" },
    quickCard: {
      backgroundColor: colors.paper,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: isWide ? spacing.lg : spacing.md,
      // Centered layout — icon chip, label and hint all align down the
      // vertical axis. Reads much cleaner than a left-aligned stack,
      // especially on the wide-screen web layout.
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      overflow: "hidden",
      minHeight: isWide ? 168 : 152,
    },
    quickIconChip: {
      // Bigger, bolder, more graphic — 56dp filled/outlined chip with the
      // tile's tint colour instead of the previous neutral-grey chip.
      width: 56, height: 56, borderRadius: 28,
      borderWidth: 1.5,
      alignItems: "center", justifyContent: "center",
      marginBottom: 4,
    },
    quickCardLabel: {
      color: colors.text,
      fontSize: isWide ? 17 : 16,
      fontWeight: "800",
      letterSpacing: -0.2,
      textAlign: "center",
    },
    quickCardHint: {
      color: colors.textSecondary,
      fontSize: 12,
      lineHeight: 16,
      textAlign: "center",
      paddingHorizontal: 4,
    },
    // Small live-count pill anchored to the top-right corner of a
    // NavFlipTile. Uses the tile's tint as background so it inherits
    // each tile's brand colour without needing per-tile overrides.
    quickCardBadge: {
      position: "absolute",
      top: 8,
      right: 8,
      minWidth: 22,
      height: 22,
      paddingHorizontal: 7,
      borderRadius: 11,
      borderWidth: 1.5,
      borderColor: "transparent",
      alignItems: "center",
      justifyContent: "center",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.18,
      shadowRadius: 3,
      elevation: 2,
    },
    quickCardBadgeTxt: {
      color: "#FFFFFF",
      fontSize: 12,
      fontWeight: "800",
      letterSpacing: 0.2,
      lineHeight: 14,
      includeFontPadding: false,
    },

    // ---- Rewards tile add-ons (extends NavFlipTile visual language) ----
    // The Rewards tile uses the same base `quickCard` + `quickIconChip`
    // + `quickCardLabel` as its NavFlipTile siblings. These extra
    // styles just add the live balance row + progress bar + sub-label
    // below the standard label so the tile stays visually consistent
    // with Get Cover / Billing / History while surfacing live data.
    rewardsBalanceRow: {
      flexDirection: "row",
      alignItems: "baseline",
      gap: 3,
      marginTop: 2,
    },
    rewardsBalanceNum: {
      fontSize: isWide ? 22 : 20,
      fontWeight: "900",
      letterSpacing: -0.6,
      lineHeight: isWide ? 24 : 22,
      includeFontPadding: false,
    },
    rewardsBalanceUnit: {
      fontSize: 11,
      fontWeight: "800",
      letterSpacing: 0.4,
      textTransform: "uppercase",
    },
    // Thin (4px) progress track — reads as a precise indicator, not a
    // game HUD. Sits at ~70% width so it feels like a subtle detail on
    // the tile instead of dominating it.
    rewardsProgressTrack: {
      width: "72%",
      height: 4,
      borderRadius: 999,
      overflow: "hidden",
      marginTop: 6,
      alignSelf: "center",
    },
    rewardsProgressFill: {
      height: "100%",
      borderRadius: 999,
    },
    // Same styling as `quickCardHint` on sibling NavFlipTiles so the
    // vertical rhythm matches perfectly. Uses `textSecondary` so the
    // meta info stays subtle relative to the balance number above.
    rewardsProgressLabel: {
      color: colors.textSecondary,
      fontSize: 12,
      lineHeight: 16,
      textAlign: "center",
      paddingHorizontal: 4,
      marginTop: 4,
    },
    // Legacy CTA styles (kept for backwards-compat in case a caller uses
    // them elsewhere — unused by NavFlipTile now).
    quickCardCta: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      marginTop: spacing.sm,
    },
    quickCardCtaText: {
      color: colors.text,
      fontSize: 11,
      fontWeight: "700",
      letterSpacing: 1,
      textTransform: "uppercase",
    },

    // Section head above tiles (web only) --------------------------------
    sectionHead: {
      marginTop: spacing.sm,
    },
    sectionEyebrow: {
      color: colors.textSecondary,
      fontSize: 11,
      letterSpacing: 2.2,
      fontWeight: "700",
      marginBottom: 4,
    },
    sectionTitle: {
      ...fonts.h1,
      color: colors.text,
      fontSize: isWide ? 24 : 20,
      letterSpacing: -0.3,
    },

    // Tile grid ----------------------------------------------------------
    // Compact iOS-style app-icon grid for the quick-nav tiles. Sizing
    // follows a strict n-columns × 100% width per row using CSS Grid on
    // web / flex-basis on native. The gap keeps the tiles from touching
    // even at very narrow widths.
    //
    // On wide screens (web) the row spans the SAME full width as every
    // other section on the page (welcome header, hero logo panel,
    // live-covers banner, etc.) so the layout reads as a coherent
    // centred column. Tiles keep their app-icon size (~120 px squares)
    // and use `justifyContent: "space-between"` to spread evenly across
    // the whole row rather than clumping at the left.
    appIconGrid: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: spacing.md,
      marginBottom: spacing.lg,
      ...(isWide
        ? {
            width: "100%" as const,
            justifyContent: "space-between" as const,
          }
        : null),
    },
    // Phones: 3 tiles per row so each icon is ~30% width (~110px on a
    // 390px viewport), giving them enough presence to read as app icons.
    appIconCell: {
      flexBasis: "30%" as any,
      flexGrow: 0,
      flexShrink: 1,
      maxWidth: "32%" as any,
    },
    // Wide screens: fixed tile width around ~120 px so each squircle
    // reads at a proper app-icon size (not the tiny 80 px we had while
    // constraining to the logo width). With `justifyContent:
    // space-between` on the grid the tiles spread evenly across the
    // full page-column width, matching the rest of the layout.
    appIconCellWide: {
      width: 120,
      flexBasis: 120 as any,
      flexGrow: 0,
      flexShrink: 0,
    },

    cardsWrap: {
      flexDirection: isWide ? "row" : "column",
      flexWrap: "wrap",
      gap: spacing.md,
    },
    tileCol: isWide
      ? {
          // 3-up on wide screens (each ~1/3 minus gap). `flexGrow: 0`
          // stops the last tile in a row from stretching to fill the
          // whole remaining width — important now that the hero tile
          // occupies its own full-width row and the Advertising tile
          // otherwise ended up spread across ~1200px, dwarfing its
          // partner logo.
          flexBasis: `${(100 - 2 * 2) / 3}%`,
          flexGrow: 0,
          maxWidth: `${(100 - 2 * 2) / 3}%`,
          minWidth: 280,
        }
      : {
          // On phones the wrap is column-oriented — full-width per tile.
          width: "100%",
        },
    // Hero tile override — always full-row-width with a strict 2:1
    // aspect ratio so the cinematic hero images (which have important
    // marketing copy on the left AND a UI-preview mock on the right)
    // render at their intended proportions. On wide screens this
    // pushes any sibling tiles below to a new row; on mobile it
    // behaves like the default full-width column.
    tileColHero: {
      flexBasis: "100%",
      width: "100%",
      minWidth: "100%",
      flexGrow: 0,
    },

    tileOuter: {
      height: TILE_HEIGHT,
      borderRadius: radius.lg,
      backgroundColor: colors.paper,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: "hidden",
      ...Platform.select({
        ios: { shadowColor: "#000", shadowOpacity: 0.14, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
        android: { elevation: 3 },
      }),
    },
    // Hero flip-tile — swap the compact fixed height for an explicit
    // large one that matches the 2:1 aspect ratio of the hero images
    // at typical viewport widths. On wide (≤1200px inner column, 3-col
    // grid × 3 = ~1168px wide when spanning full row) we render at
    // ~560px tall — comfortably matches the 2:1 image without
    // dominating the screen. On phones the tile shrinks proportionally
    // to keep the whole image visible above the fold.
    //
    // `aspectRatio: 2` alone doesn't fully control layout on
    // react-native-web when the parent has row constraints, so we
    // provide a min/max height as a safety net.
    tileOuterHero: {
      height: isWide ? 480 : heroMobileHeight,
      backgroundColor: "#000",
      borderColor: "transparent",
    },
    tileFace: {
      position: "absolute",
      top: 0, left: 0, right: 0, bottom: 0,
      backfaceVisibility: "hidden",
      padding: spacing.md,
    },
    // Applied to the "next" face on top of tileFace. Guarantees the back
    // face is invisible on first paint on web (before reanimated has a
    // chance to set the animated opacity), so full-bleed content on the
    // back face doesn't bleed through the current front page.
    tileFaceHiddenInitial: { opacity: 0 },

    // Front page
    pageFront: {
      flex: 1,
      padding: spacing.sm,
      justifyContent: "center",
      alignItems: "flex-start",
      gap: spacing.sm,
    },
    iconChip: {
      width: 44, height: 44, borderRadius: 22,
      backgroundColor: "#fff",
      alignItems: "center", justifyContent: "center",
    },
    frontTitle: { ...fonts.h1, color: colors.text, fontSize: 22 },
    frontSub: { ...fonts.small, color: colors.textSecondary, fontSize: 13 },

    // Bullet point page
    pagePoint: { flex: 1, padding: spacing.sm, gap: spacing.md, justifyContent: "space-between" },
    pointNumRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    pointNumChip: {
      width: 28, height: 28, borderRadius: 14,
      backgroundColor: colors.primary,
      alignItems: "center", justifyContent: "center",
    },
    pointNumText: { color: colors.onPrimary || "#000", fontSize: 13, fontWeight: "800" },
    pointEyebrow: { ...fonts.eyebrow, color: colors.textSecondary, fontSize: 11, letterSpacing: 1 },
    pointBody: { flex: 1, flexDirection: "row", gap: spacing.md, alignItems: "flex-start", paddingRight: spacing.sm },
    pointIconChip: {
      width: 40, height: 40, borderRadius: 20,
      backgroundColor: "#fff",
      alignItems: "center", justifyContent: "center",
      marginTop: 4,
    },
    pointText: { flex: 1, color: colors.text, fontSize: 15, lineHeight: 21, fontWeight: "500" },

    // Footer page
    pageFooter: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm, padding: spacing.md },
    footerText: {
      color: colors.text,
      fontSize: 17,
      fontStyle: "italic",
      fontWeight: "600",
      textAlign: "center",
      lineHeight: 24,
    },

    // Full-bleed hero page — used by the "Trade with Confidence" 5-page
    // cinematic cycle. Extends past the tile's inner padding so the
    // image fills the entire card (matching the ad page's bleed logic).
    // Rounded corners are inherited from the parent `tileFace` clip.
    pageHero: {
      position: "absolute",
      top: -spacing.md,
      left: -spacing.md,
      right: -spacing.md,
      bottom: -spacing.md,
      overflow: "hidden",
      backgroundColor: "#000",
      alignItems: "center",
      justifyContent: "center",
    },
    heroImg: { width: "100%", height: "100%" },

    // Ad page — full-bleed image with a small "ADVERTISING" pill top-left.
    // Uses `resizeMode="contain"` (see TilePage) so the advertiser's whole
    // image is always visible, matching the 16:10 upload spec, and centres
    // on a black backdrop when the aspect ratio doesn't perfectly match
    // the tile. Prevents important content (logos, headlines, callouts)
    // from being cropped off the edges on phones.
    pageAd: {
      position: "absolute",
      top: -spacing.md,
      left: -spacing.md,
      right: -spacing.md,
      bottom: -spacing.md,
      overflow: "hidden",
      backgroundColor: "#000",
      alignItems: "center",
      justifyContent: "center",
    },
    adBadge: {
      position: "absolute",
      top: spacing.md + 4,
      left: spacing.md + 4,
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: radius.pill,
      backgroundColor: "rgba(0,0,0,0.55)",
      zIndex: 2,
    },
    adBadgeText: { color: "#fff", fontSize: 9, fontWeight: "800", letterSpacing: 0.6 },
    adImg: { width: "100%", height: "100%" },

    // Lifestyle-image front (Trade with Confidence tile).
    pageFrontImageWrap: {
      position: "absolute",
      top: -spacing.md,
      left: -spacing.md,
      right: -spacing.md,
      bottom: -spacing.md,
      overflow: "hidden",
    },
    frontBgImage: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, width: "100%", height: "100%" },
    pageFrontOverlay: {
      position: "absolute",
      top: spacing.md + spacing.sm,
      left: spacing.md + spacing.sm,
      right: "45%",
      bottom: spacing.lg + 8,
      justifyContent: "flex-end",
      gap: spacing.xs,
    },
    iconChipOnImage: {
      width: 36, height: 36, borderRadius: 18,
      backgroundColor: "#FFFFFF",
      alignItems: "center", justifyContent: "center",
      marginBottom: spacing.xs,
    },
    frontTitleOnImage: {
      ...fonts.h1,
      color: "#FFFFFF",
      fontSize: 22,
      lineHeight: 26,
      textShadowColor: "rgba(0,0,0,0.55)",
      textShadowRadius: 6,
    },
    frontSubOnImage: {
      ...fonts.small,
      color: "rgba(255,255,255,0.88)",
      fontSize: 13,
      lineHeight: 18,
      textShadowColor: "rgba(0,0,0,0.55)",
      textShadowRadius: 4,
    },

    // Pagination dots at the bottom-centre of every tile.
    dots: {
      position: "absolute",
      bottom: 10, left: 0, right: 0,
      flexDirection: "row",
      gap: 5,
      justifyContent: "center",
    },
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.borderLight },
    dotActive: { backgroundColor: colors.text, width: 14 },

    hintRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: spacing.sm, opacity: 0.85 },
    hintText: { ...fonts.small, color: colors.textSecondary, fontSize: 12 },

    // 2-column row on wide: Verified Dealer Network (heroes) + Advertising.
    // Both tiles share the same total width as every other section on
    // the page and the SAME vertical height so the row reads as
    // balanced. On mobile the two tiles fall through the flip-tile
    // grid above (stacked full-width) so this row is wide-only.
    heroAdRow: {
      flexDirection: "row" as const,
      gap: spacing.md,
      alignItems: "stretch" as const,
      width: "100%" as const,
    },
    // Heroes column — a hair wider than the ads column because the
    // baked-in 2:1 cinematic images carry marketing copy on the left
    // AND a UI preview mock on the right. A 50/50 split cropped the
    // mock; 58/42 gives the mock enough headroom to render legibly.
    heroAdLeftCol: {
      flex: 0.58,
      minHeight: 360,
    },
    heroAdRightCol: {
      flex: 0.42,
      minHeight: 360,
      gap: spacing.xs,
    },
    // Applied to both FlipTile outer Pressables in the row so they
    // stretch to fill their column height (matching each other) rather
    // than using the default fixed TILE_HEIGHT.
    heroAdTileOuter: {
      height: 360,
      width: "100%" as const,
      flex: 1,
    },

    // Bottom Advertising banner (LEGACY — kept for the section-eyebrow
    // heading typography used in the heroAdRow right column). No
    // longer rendered as a standalone bottom banner now that the ads
    // tile sits beside the trade heroes on wide.
    bottomAdsWrap: {
      marginTop: spacing.xl,
      gap: spacing.sm,
    },
    bottomAdsHead: {
      gap: 2,
      marginBottom: spacing.xs,
    },
    bottomAdsTitle: {
      color: colors.text,
      fontSize: isWide ? 20 : 17,
      fontWeight: "800" as const,
      letterSpacing: -0.3,
    },
    bottomAdsTile: {
      width: "100%" as const,
      height: isWide ? 260 : TILE_HEIGHT,
    },
  });
};
