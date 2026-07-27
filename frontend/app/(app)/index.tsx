import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { Pressable, TouchableOpacity } from "@/src/components/HapticButtons";
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

import { spacing, radius, fonts } from "@/src/theme";
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
// Lifestyle image for the "Earn Rewards" tile front page — dealer holding a
// phone showing a Takealot voucher earned through the app.
const REWARDS_TILE_LIFESTYLE = require("../../assets/brands/rewards_lifestyle.jpg");

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
    key: "rewards",
    icon: "gift",
    title: "Earn Rewards",
    subtitle: "Get paid for every submission — tap to see how",
    footer: "Yours to keep — No Expiry, No Fineprint",
    frontImage: REWARDS_TILE_LIFESTYLE,
    points: [
      { icon: "cash", text: "Earn 1 Point (R10) for every valuation submission" },
      { icon: "people", text: "Refer another dealership with your code and earn an additional 1 Point (R10) for every valuation they submit (FOR LIFE)" },
      { icon: "gift", text: "Redeem your points in-app for R500 TakeAlot Vouchers, sent directly to your email" },
      { icon: "wallet", text: "Track your balance and referral link in the Rewards Tab" },
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
  // modes) opportunistically pause muted background <video> elements to
  // save battery / CPU. Because the hero video is decorative-but-critical
  // (product reads as broken if it's frozen), poll every 1.5 s and
  // re-issue `play()` if the underlying element has been paused by
  // anything other than the user themselves. Very cheap — a boolean read
  // plus a no-op play() when already playing. Cleaned up on unmount.
  useEffect(() => {
    if (Platform.OS !== "web") return;
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

  // Quick-action cards — the primary tasks a dealer/admin comes here to do.
  // Keeps parity with the bottom-tab bar but promotes them above the fold on
  // web so the landing page feels like a real dashboard.
  type QuickAction = {
    key: string;
    label: string;
    hint: string;
    icon: keyof typeof Ionicons.glyphMap;
    to: string;
  };
  const isAdmin = user?.role === "admin";
  const quickActions: QuickAction[] = isAdmin
    ? [
        { key: "subs", label: "Submissions", hint: "Price & review dealer submissions", icon: "list-outline", to: "/(app)/submissions" },
        { key: "dealers", label: "Dealers", hint: "Approve, edit and manage accounts", icon: "people-outline", to: "/(app)/dealers" },
        { key: "billing", label: "Billing", hint: "Invoices, credits & receipts", icon: "cash-outline", to: "/(app)/billing" },
        { key: "rewards", label: "Rewards", hint: "Points, referrals & voucher requests", icon: "gift-outline", to: "/(app)/rewards" },
      ]
    : [
        { key: "submit", label: "Submit a Vehicle", hint: "Get a confirmed cover price in 90 s", icon: "add-circle-outline", to: "/(app)/submit" },
        { key: "mine", label: "My Vehicles", hint: "Track submitted vehicles & prices", icon: "car-outline", to: "/(app)/submissions" },
        { key: "billing", label: "Billing", hint: "Invoices & report charges", icon: "receipt-outline", to: "/(app)/billing" },
        { key: "rewards", label: "Rewards", hint: "Earn points & vouchers", icon: "gift-outline", to: "/(app)/rewards" },
      ];

  // Live-loaded advertising slots — replace the hardcoded 3 ads on the
  // "Advertising" tile with whatever the admin has configured via the
  // Admin Cockpit → Advertising module. If none are configured yet we
  // fall back to the bundled sample ads so the tile is never empty.
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

  const tiles: Tile[] = useMemo(() => {
    if (!activeAds.length) return BASE_TILES;
    return BASE_TILES.map((t) => {
      if (t.key !== "ads") return t;
      return {
        ...t,
        ads: activeAds.map((a) => ({
          image: { uri: a.image_base64 },
          label: a.dealership_name || undefined,
        })),
      };
    });
  }, [activeAds]);

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

          {/* Hero video — capped height on wide screens so it stops swallowing
              the whole viewport, and full-bleed 16:9 on phones. */}
          <View style={styles.heroWrap}>
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
          </View>

          {/* Quick-actions grid — always visible on web, hidden on phones
              (they already have the bottom tab bar). */}
          {isWide ? (
            <View style={styles.quickGrid}>
              {quickActions.map((qa) => (
                <TouchableOpacity
                  key={qa.key}
                  style={styles.quickCard}
                  onPress={() => router.push(qa.to as never)}
                  accessibilityRole="button"
                  accessibilityLabel={qa.label}
                >
                  <View style={styles.quickIconChip}>
                    <Ionicons name={qa.icon} size={20} color={colors.text} />
                  </View>
                  <Text style={styles.quickCardLabel}>{qa.label}</Text>
                  <Text style={styles.quickCardHint} numberOfLines={2}>{qa.hint}</Text>
                  <View style={styles.quickCardCta}>
                    <Text style={styles.quickCardCtaText}>Open</Text>
                    <Ionicons name="arrow-forward" size={12} color={colors.text} />
                  </View>
                </TouchableOpacity>
              ))}
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

    // Quick-actions grid (web only) --------------------------------------
    quickGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing.md,
    },
    quickCard: {
      // 4-up on wide screens with the grid gap.
      flexBasis: `${(100 - 3 * 2) / 4}%`,
      flexGrow: 1,
      minWidth: 220,
      backgroundColor: colors.paper,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
      gap: spacing.xs,
    },
    quickIconChip: {
      width: 40, height: 40, borderRadius: 20,
      backgroundColor: colors.card,
      borderWidth: 1, borderColor: colors.border,
      alignItems: "center", justifyContent: "center",
      marginBottom: spacing.sm,
    },
    quickCardLabel: {
      color: colors.text,
      fontSize: 16,
      fontWeight: "800",
      letterSpacing: -0.2,
    },
    quickCardHint: {
      color: colors.textSecondary,
      fontSize: 12,
      lineHeight: 17,
    },
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
