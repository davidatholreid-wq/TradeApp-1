import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { Pressable } from "@/src/components/HapticButtons";
import { View, Text, StyleSheet, ScrollView, Image, Platform, useWindowDimensions } from "react-native";
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
import { LinearGradient } from "expo-linear-gradient";
import { useFocusEffect, useRouter } from "expo-router";

import { spacing, radius, fonts, BRAND } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { useAuth } from "@/src/context/AuthContext";
import { apiFetch } from "@/src/api";

// ---------------------------------------------------------------------------
// Home / Landing screen — dealer + admin.
// Video banner at the top, then three tap-to-flip tiles below. Each tile
// cycles through pages on tap (front → point 1 → point 2 → ... → loop).
// ---------------------------------------------------------------------------

// Bundled hero video (H.264 on native, VP9 on web).
const HERO_VIDEO = Platform.OS === "web"
  ? require("../../assets/video/home_banner.webm")
  : require("../../assets/video/home_banner.mp4");
const HERO_POSTER = require("../../assets/video/home_banner_poster.jpg");

// Advertising rotation — bundled bitmaps, cycled per-tap.
const AD_TCS = require("../../assets/brands/ad_tcs.jpeg");
const AD_SWIFT = require("../../assets/brands/ad_swift.jpeg");
const AD_MERCEDES = require("../../assets/brands/ad_mercedes.jpeg");

// Lifestyle image for the "Trade with Confidence" hero tile front page.
const HERO_TILE_LIFESTYLE = require("../../assets/brands/hero_lifestyle.jpg");
// Note: the "Earn Rewards" flip banner was removed at the user's request
// (the rewards content now lives only on the /rewards module). The
// rewards_lifestyle.jpg asset is kept in the repo but no longer imported.

type PagePoint = { icon?: keyof typeof Ionicons.glyphMap; text: string };
type PageAd = { image: number | { uri: string }; label?: string };

// A tile has ONE front page + N interior pages. Front = title/icon/CTA.
// Interior pages are either bullet points (Trade with Confidence + Earn
// Rewards) or a full-bleed ad image (Advertising slot).
type Tile = {
  key: "trade" | "rewards" | "ads";
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  footer?: string; // Trailing italic line after last bullet
  points?: PagePoint[];
  ads?: PageAd[];
  frontImage?: number; // Optional lifestyle image behind the front page.
};

const BASE_TILES: Tile[] = [
  {
    key: "trade",
    icon: "shield-checkmark",
    title: "Trade with Confidence",
    subtitle: "Reduce your risks — tap to see how",
    footer: "Reduce your risks",
    frontImage: HERO_TILE_LIFESTYLE,
    points: [
      { icon: "flash", text: "Submit a vehicle for a Confirmed Cover Price in under 90 Seconds" },
      { icon: "shield-checkmark", text: "Fourbuy Car Buying Co, will issue you a guarantee (Subject to final inspection)" },
      { icon: "business", text: "Backed by the Fourbuy Group so you can commit to your customer TODAY!" },
      { icon: "cash", text: "One Flat Submission Fee — Cover Price holds for 14-Days" },
    ],
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
  const styles = useMemo(() => makeStyles(colors, isWide), [colors, isWide]);
  const insets = useBottomTabBarHeight();
  const router = useRouter();
  const { user } = useAuth();

  const firstName =
    user?.dealer_info?.first_name?.trim() ||
    user?.name?.split(" ")[0] ||
    (user?.email ? user.email.split("@")[0] : "");

  const heroPlayer = useVideoPlayer(HERO_VIDEO, (p) => {
    // Client-supplied 10-second cinematic. We loop it so the hero panel
    // is always showing motion rather than freezing on the (dark) final
    // frame — especially important on web, where the tab may sit on
    // Home for extended periods and a static black rectangle reads as
    // "video is broken".
    p.loop = true;
    p.muted = true;
    p.play();
  });

  // Watchdog: some web browsers (Safari, and Chrome in restricted power
  // modes) opportunistically pause muted background <video> elements. On
  // web we now render a static brand logo instead of the video (see the
  // hero panel below), so this watchdog only runs on native — where the
  // OS video pipeline generally honours `loop = true`, but a belt-and-
  // braces re-play() keeps the panel alive if the player is ever paused
  // by a system-level interruption (incoming call, PiP switch, etc.).
  useEffect(() => {
    if (Platform.OS === "web") return;
    const id = setInterval(() => {
      try {
        if (!heroPlayer.playing) heroPlayer.play();
      } catch { /* no-op */ }
    }, 1500);
    return () => clearInterval(id);
  }, [heroPlayer]);

  useFocusEffect(
    useCallback(() => {
      // Rewind and play once every time the Home tab is re-focused so
      // dealers see the intro from the start, not mid-way through.
      // NOTE: we intentionally do NOT pause on unfocus — pausing here
      // was causing the hero panel to sometimes stay stopped when
      // React Navigation re-focused the tab out-of-order on web.
      try {
        heroPlayer.currentTime = 0;
        heroPlayer.play();
      } catch { /* no-op */ }
    }, [heroPlayer]),
  );

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
  };
  const isAdmin = user?.role === "admin";
  const isPricingAgent = !!user?.is_pricing_agent;
  const quickActions: QuickAction[] = isAdmin
    ? [
        { key: "dealers", label: "Dealers", hint: "Approve, edit & manage accounts", icon: "people", to: "/(app)/dealers", tint: "#5B8DEF" },
        { key: "billing", label: "Billing", hint: "Invoices, credits & receipts", icon: "cash", to: "/(app)/billing", tint: "#22C55E" },
        { key: "rewards", label: "Rewards", hint: "Points, referrals & vouchers", icon: "gift", to: "/(app)/rewards", tint: "#F97316" },
        { key: "history", label: "History", hint: "Priced & archived vehicles", icon: "time", to: "/(app)/history", tint: "#A78BFA" },
        { key: "kredo", label: "Kredo", hint: "VIN reports & CarTrust tools", icon: "pricetag", to: "/(app)/kredo-test", tint: "#F43F5E" },
      ]
    : [
        // "Get Cover" — headline dealer action (mirrors the Submit tab).
        // Routes to /submit so the dealer can submit a vehicle and get
        // a Fourbuy cover in <90 seconds. Uses the brand primary tint
        // so it visibly reads as the primary CTA on the home page.
        { key: "get-cover", label: "Get Cover", hint: "Submit a vehicle · confirmed cover in 90 s", icon: "flash" as const, to: "/(app)/submit", tint: colors.primary },
        ...(isPricingAgent
          ? [{ key: "cover", label: "Give Cover", hint: "Price blind submissions · R10 each", icon: "shield-checkmark" as const, to: "/(app)/cover", tint: "#5B8DEF" }]
          : []),
        { key: "billing", label: "Billing", hint: "Invoices & report charges", icon: "cash" as const, to: "/(app)/billing", tint: "#22C55E" },
        { key: "history", label: "History", hint: "Priced & archived vehicles", icon: "time" as const, to: "/(app)/history", tint: "#A78BFA" },
        { key: "rewards", label: "Rewards", hint: "Earn points & vouchers", icon: "gift" as const, to: "/(app)/rewards", tint: "#F97316" },
      ];

  const tiles: Tile[] = dynamicTiles;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets + spacing.xl }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.pageMax}>
          {/* Welcome header — greets the user by first name and grounds the
              page as a proper dashboard rather than a marketing splash. */}
          <View style={styles.welcomeRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.welcomeEyebrow}>
                {isAdmin ? "ADMIN COCKPIT" : "DEALER PORTAL"}
              </Text>
              <Text style={styles.welcomeTitle} numberOfLines={1}>
                {firstName ? `Welcome back, ${firstName}` : "Welcome back"}
              </Text>
              <Text style={styles.welcomeSub} numberOfLines={2}>
                {isAdmin
                  ? "Manage submissions, dealers and rewards from one place."
                  : "Submit a vehicle for a guaranteed cover price in under 90 seconds."}
              </Text>
            </View>
          </View>

          {/* Hero panel — capped height on wide screens so it stops swallowing
              the whole viewport, and full-bleed 16:9 on phones.
              • Native (iOS / Android): looping cinematic video.
              • Web: static Fourbuy Car Buying Co. logo on a solid brand
                backdrop. Web video autoplay is unreliable across
                browsers / power modes, and the client asked to fall
                back to a clean logo lockup there. */}
          <View style={styles.heroWrap}>
            {Platform.OS === "web" ? (
              <View style={styles.heroLogoBg}>
                <Image
                  source={BRAND.logo}
                  style={styles.heroLogoImg}
                  resizeMode="contain"
                  accessibilityLabel="Fourbuy Car Buying Co."
                />
              </View>
            ) : (
              <>
                <Image source={HERO_POSTER} style={styles.heroPoster} resizeMode="cover" />
                <VideoView
                  player={heroPlayer}
                  style={styles.hero}
                  contentFit="cover"
                  nativeControls={false}
                  allowsFullscreen={false}
                  allowsPictureInPicture={false}
                  accessibilityLabel="Fourbuy Car Buying Co. hero video"
                />
              </>
            )}
          </View>

          {/* Quick-nav tiles — the primary secondary-destinations
              (Billing, History, Rewards, Dealers, Kredo, Give Cover…).
              Rendered on every viewport so this replaces most of what
              used to sit in the bottom tab bar. Tapping a tile briefly
              flips it before navigating, giving the tap a satisfying
              feel and a clear affordance that this is a portal into
              another section of the app. */}
          <View style={styles.quickGrid}>
            {quickActions.map((qa) => (
              <View key={qa.key} style={styles.quickCardCol}>
                {qa.key === "rewards" ? (
                  <TakealotRewardsTile
                    onNavigate={() => router.push(qa.to as never)}
                    styles={styles}
                  />
                ) : (
                  <NavFlipTile
                    label={qa.label}
                    hint={qa.hint}
                    icon={qa.icon}
                    tint={qa.tint}
                    onNavigate={() => router.push(qa.to as never)}
                    styles={styles}
                    colors={colors}
                  />
                )}
              </View>
            ))}
          </View>

          {/* Live "Value of Cars Covered in the last 30 Days" banner —
              standalone stat card that sits above the marketing tiles.
              Deliberately NOT a flip tile / not tied to rewards — it's a
              running figure of Fourbuy's real cover activity, formatted
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
              <View style={styles.dealStatHead}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.dealStatEyebrow}>
                    {isAdmin ? "ALL DEALERSHIPS" : "YOUR DEALERSHIP"}
                  </Text>
                  <Text style={styles.dealStatTitle}>Deal Outcomes</Text>
                  <Text style={styles.dealStatSub}>
                    Track which submissions still need an outcome recorded.
                  </Text>
                </View>
                <View style={styles.dealStatTotalChip}>
                  <Text style={styles.dealStatTotalNum}>{dealOutcomes.total}</Text>
                  <Text style={styles.dealStatTotalLbl}>TOTAL</Text>
                </View>
              </View>
              <View style={styles.dealStatRow}>
                <Pressable
                  style={[styles.dealStatCard, styles.dealStatCardPending]}
                  onPress={() => router.push("/(app)/history" as never)}
                  testID="deal-outcome-pending"
                >
                  <Ionicons name="hourglass-outline" size={16} color="#B67900" />
                  <Text style={[styles.dealStatValue, { color: "#B67900" }]}>
                    {dealOutcomes.pending}
                  </Text>
                  <Text style={styles.dealStatLabel}>PENDING</Text>
                  <Text style={styles.dealStatHint} numberOfLines={1}>
                    Awaiting outcome
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.dealStatCard, styles.dealStatCardDone]}
                  onPress={() => router.push("/(app)/history" as never)}
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
                  onPress={() => router.push("/(app)/history" as never)}
                  testID="deal-outcome-no"
                >
                  <Ionicons name="close-circle" size={16} color={colors.textSecondary} />
                  <Text style={[styles.dealStatValue, { color: colors.textSecondary }]}>
                    {dealOutcomes.no_deal}
                  </Text>
                  <Text style={styles.dealStatLabel}>NO DEAL</Text>
                  <Text style={styles.dealStatHint} numberOfLines={1}>
                    Not proceeded
                  </Text>
                </Pressable>
              </View>
              {dealOutcomes.sold > 0 ? (
                <View style={styles.dealStatProfitStrip}>
                  <Ionicons
                    name={dealOutcomes.gross_profit_zar >= 0 ? "trending-up" : "trending-down"}
                    size={14}
                    color={dealOutcomes.gross_profit_zar >= 0 ? "#1F7A3A" : "#B3261E"}
                  />
                  <Text style={styles.dealStatProfitLbl}>
                    {dealOutcomes.gross_profit_zar >= 0 ? "Gross profit on sold cars" : "Loss on sold cars"}
                  </Text>
                  <Text
                    style={[
                      styles.dealStatProfitVal,
                      { color: dealOutcomes.gross_profit_zar >= 0 ? "#1F7A3A" : "#B3261E" },
                    ]}
                    testID="deal-outcome-profit"
                  >
                    R{Math.abs(dealOutcomes.gross_profit_zar).toLocaleString("en-ZA")}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}

          {/* Section heading above the marketing tiles on wide — helps
              signpost that the below area is the pitch, not primary UI. */}
          {isWide ? (
            <View style={styles.sectionHead}>
              <Text style={styles.sectionEyebrow}>WHY FOURBUY</Text>
              <Text style={styles.sectionTitle}>Everything you need to trade with confidence</Text>
            </View>
          ) : null}

          {/* Flip-tiles */}
          <View style={styles.cardsWrap}>
            {tiles.map((t) => (
              <View key={t.key} style={styles.tileCol}>
                <FlipTile
                  tile={t}
                  styles={styles}
                  colors={colors}
                  autoRotateMs={t.key === "ads" ? 5000 : 0}
                />
              </View>
            ))}
          </View>

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
// TakealotRewardsTile — dedicated co-branded tile for the Rewards module.
//
// Same size/position as the other NavFlipTiles in the quickActions grid so
// the layout doesn't reflow, but styled with Takealot's signature blue
// backdrop and the takealot.com wordmark so dealers instantly recognise
// where their vouchers can be spent. Preserves the flip-on-tap navigation
// gesture used by NavFlipTile for a consistent feel across the grid.
// ---------------------------------------------------------------------------
function TakealotRewardsTile({
  onNavigate,
  styles,
}: {
  onNavigate: () => void;
  styles: ReturnType<typeof makeStyles>;
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

  // Takealot brand blue lifted directly from the assets/brands/takealot.png
  // background — kept on-file so we don't drift from the partner's colour
  // system if the PNG is ever refreshed.
  const takealotBlue = "#0F73B8";

  return (
    <Pressable
      onPress={onTap}
      accessibilityRole="button"
      accessibilityLabel="Fourbuy Rewards, powered by takealot.com"
      testID="rewards-takealot-tile"
      style={({ pressed }) => [{ opacity: pressed ? 0.92 : 1 }]}
    >
      <Animated.View
        style={[
          styles.quickCard,
          styles.takealotCard,
          { backgroundColor: takealotBlue, borderColor: takealotBlue },
          faceStyle,
        ]}
      >
        {/* Subtle radial highlight so the tile has depth even though it's
            a flat brand-blue block. Top-left to bottom-right for a soft
            gloss effect. */}
        <LinearGradient
          colors={["#ffffff22", "#ffffff08", "transparent"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        {/* Small eyebrow badge — mirrors the "LIVE" / eyebrow styling
            used elsewhere on the home page so this tile feels native. */}
        <View style={styles.takealotEyebrowWrap}>
          <Ionicons name="gift" size={12} color="#ffffffcc" />
          <Text style={styles.takealotEyebrow}>REWARDS</Text>
        </View>

        {/* Wordmark — we intentionally use a text lockup rather than a
            second copy of the PNG so we control the type scale + colour
            contrast against the blue backdrop. The `.com` badge lives
            beside it just like the official mark. */}
        <View style={styles.takealotWordmarkRow}>
          <Text style={styles.takealotWord}>takealot</Text>
          <View style={styles.takealotComPill}>
            <Text style={styles.takealotComText}>com</Text>
          </View>
        </View>

        {/* Primary label + subtitle: makes the co-brand relationship
            explicit — "Fourbuy Rewards" is the product, "Powered by
            takealot.com" is the fulfilment partner. */}
        <Text style={styles.takealotTitle}>Fourbuy Rewards</Text>
        <Text style={styles.takealotSubtitle}>Powered by takealot.com</Text>
      </Animated.View>
    </Pressable>
  );
}


function NavFlipTile({
  label, hint, icon, tint, onNavigate, styles, colors,
}: {
  label: string;
  hint: string;
  icon: keyof typeof Ionicons.glyphMap;
  tint: string;
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
        <Text style={styles.quickCardHint} numberOfLines={2}>{hint}</Text>
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
};

function FlipTile({ tile, styles, colors, autoRotateMs = 0 }: FlipTileProps) {
  // Total pages = 1 (front) + points/ads + optional footer.
  const totalPages = 1 + (tile.points?.length ?? tile.ads?.length ?? 0) + (tile.footer ? 1 : 0);
  const [idx, setIdx] = useState(0);
  const rot = useSharedValue(0); // 0..1 flip progress
  const scale = useSharedValue(1);

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
      flipToNext();
    }, autoRotateMs);
    return () => clearInterval(id);
  }, [autoRotateMs, flipToNext, totalPages]);

  const onTap = useCallback(() => {
    lastTapAtRef.current = Date.now();
    flipToNext();
  }, [flipToNext]);

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

  // Current & next page content — pre-compute so both faces stay in sync
  // during the animation without stale-closure surprises.
  const nextIdx = (idx + 1) % totalPages;
  const CurrentContent = <TilePage tile={tile} pageIdx={idx} styles={styles} colors={colors} />;
  const NextContent = <TilePage tile={tile} pageIdx={nextIdx} styles={styles} colors={colors} />;

  return (
    <Pressable onPress={onTap} style={styles.tileOuter} accessibilityRole="button" accessibilityLabel={`${tile.title} card. Tap to see next.`}>
      {/* Next face rendered first (below), starts fully hidden and only
          fades in via nextFaceStyle when rot >= 0.5. This ordering + the
          initial opacity: 0 stops a full-bleed ad from bleeding through
          the front page on web where reanimated may apply its animated
          style on the next paint frame. */}
      <Animated.View style={[styles.tileFace, styles.tileFaceHiddenInitial, nextFaceStyle]} pointerEvents="none">
        {NextContent}
      </Animated.View>
      <Animated.View style={[styles.tileFace, faceStyle]} pointerEvents="none">
        {CurrentContent}
      </Animated.View>

      {/* Pagination dots — always show, help dealers know they're mid-tour. */}
      <View style={styles.dots} pointerEvents="none">
        {Array.from({ length: totalPages }).map((_, i) => (
          <View key={i} style={[styles.dot, i === idx && styles.dotActive]} />
        ))}
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// TilePage — renders a single page inside a FlipTile.
// pageIdx 0 = front (title/subtitle). 1..N = point/ad. Last = footer text.
// ---------------------------------------------------------------------------
function TilePage({ tile, pageIdx, styles, colors }: { tile: Tile; pageIdx: number; styles: ReturnType<typeof makeStyles>; colors: Palette }) {
  // Front page
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

  // Ad page
  if (tile.ads) {
    const ad = tile.ads[pageIdx - 1];
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

const makeStyles = (colors: Palette, isWide: boolean) => {
  const TILE_HEIGHT = isWide ? TILE_HEIGHT_WIDE : TILE_HEIGHT_MOBILE;
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
    heroWrap: {
      width: "100%",
      aspectRatio: 16 / 9,
      maxHeight: isWide ? 360 : undefined,
      borderRadius: radius.lg,
      overflow: "hidden",
      backgroundColor: colors.paper,
      ...Platform.select({
        ios: { shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } },
        android: { elevation: 3 },
      }),
    },
    hero: { width: "100%", height: "100%" },
    heroPoster: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, width: "100%", height: "100%" },
    // Web-only fallback — a full-bleed brand lockup replaces the video
    // there because muted autoplay is unreliable across browsers /
    // power modes. Dark backdrop matches the app's cinematic feel and
    // lets the white-text logo read cleanly.
    heroLogoBg: {
      width: "100%",
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "#0A0A0A",
      paddingHorizontal: spacing.xl,
    },
    heroLogoImg: {
      width: "70%",
      height: "70%",
      maxWidth: 520,
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
    dealStatCardPending: {
      borderColor: "#B67900" + "55",
      backgroundColor: "#B67900" + "14",
    },
    dealStatCardDone: {
      borderColor: "#1F7A3A" + "55",
      backgroundColor: "#1F7A3A" + "14",
    },
    dealStatCardNo: {
      borderColor: colors.border,
      backgroundColor: colors.paper,
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

    // ---- Takealot co-branded rewards tile ----
    // Same minHeight/padding footprint as quickCard so it slots into the
    // grid perfectly, but with a solid brand-blue backdrop and a bespoke
    // vertical layout: eyebrow → wordmark → title → subtitle.
    takealotCard: {
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      gap: 6,
      shadowColor: "#0F73B8",
      shadowOpacity: Platform.OS === "web" ? 0.12 : 0.25,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 4 },
    },
    takealotEyebrowWrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: "#ffffff22",
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 999,
      marginBottom: 2,
    },
    takealotEyebrow: {
      color: "#ffffffcc",
      fontSize: 10,
      fontWeight: "900",
      letterSpacing: 1.2,
    },
    takealotWordmarkRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    takealotWord: {
      color: "#fff",
      // Bold rounded feel to approximate the takealot.com wordmark.
      // Explicit `fontWeight: "900"` looks right on both iOS system font
      // and the web fallback stack.
      fontSize: isWide ? 30 : 26,
      fontWeight: "900",
      letterSpacing: -1,
      // Slight italic tightening reads more like the real wordmark.
      // Keep the built-in system font — good enough without shipping
      // an extra font file just for a tile.
    },
    takealotComPill: {
      backgroundColor: "#fff",
      borderRadius: 999,
      paddingHorizontal: 6,
      paddingVertical: 2,
      minWidth: 26,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 4,
    },
    takealotComText: {
      color: "#0F73B8",
      fontSize: 10,
      fontWeight: "900",
      letterSpacing: 0.3,
    },
    takealotTitle: {
      color: "#fff",
      fontSize: isWide ? 15 : 14,
      fontWeight: "800",
      marginTop: 6,
      textAlign: "center",
    },
    takealotSubtitle: {
      color: "#ffffffcc",
      fontSize: 11,
      fontWeight: "600",
      textAlign: "center",
      letterSpacing: 0.2,
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
    cardsWrap: {
      flexDirection: isWide ? "row" : "column",
      flexWrap: "wrap",
      gap: spacing.md,
    },
    tileCol: isWide
      ? {
          // 3-up on wide screens (each ~1/3 minus gap).
          flexBasis: `${(100 - 2 * 2) / 3}%`,
          flexGrow: 1,
          minWidth: 280,
        }
      : {
          // On phones the wrap is column-oriented — full-width per tile.
          width: "100%",
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
  });
};
