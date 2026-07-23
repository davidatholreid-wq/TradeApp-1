import { useMemo, useState, useCallback } from "react";
import { Pressable } from "@/src/components/HapticButtons";
import { View, Text, StyleSheet, ScrollView, ImageBackground, Image, useWindowDimensions, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  interpolate,
  Easing,
} from "react-native-reanimated";
import { Ionicons } from "@expo/vector-icons";

import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { useAuth } from "@/src/context/AuthContext";
import BrandLogo from "@/src/components/BrandLogo";

// Local brand assets for partner cards.
const TAKEALOT_LOGO = require("../../assets/brands/takealot.png");
const VAPSSA_LOGO = require("../../assets/brands/vapssa.png");

// ---------------------------------------------------------------------------
// Home / Landing screen (dealer + admin)
// ---------------------------------------------------------------------------
// Shown as the initial route after login. The bottom tab bar remains
// visible for direct access to "My Vehicles / Submit / Billing / History /
// Rewards / Profile" — this screen deliberately does NOT surface the
// vehicle list. Instead it's a marketing dashboard with three flip-cards
// that give the app a proper landing feel and reinforce the Fourbuy value
// proposition on every login.
//
// Card taps FLIP the card in place (no navigation) so the dealer can read
// a short "why this matters" blurb and tap again to flip back.

type CardKey = "cover_price" | "rewards" | "ad_vaps";

// A card can render one of two front-face variants:
//  - "photo":  hero image with a dark tint overlay + white copy
//  - "brand":  solid brand-colour background with the partner's own logo
//              (used when the *partner's* identity should be the visual
//              hero — Takealot for rewards, VAPS SA for the ad spot).
// The back face is the same shape either way: a themed info panel with
// bullets, so dealers get a consistent flip experience.
type FrontVariant =
  | {
      kind: "photo";
      image: string;
      accent: string;
      frontIcon: keyof typeof Ionicons.glyphMap;
    }
  | {
      kind: "brand";
      /** Solid background colour for the branded card. */
      bg: string;
      /** Optional secondary colour for a soft top→bottom gradient feel. */
      bgAccent?: string;
      /** Local require(...) for the partner logo. */
      logo: number;
      /** Preferred logo width in the card header (height auto). */
      logoWidth: number;
      /** Colour for eyebrow / body copy on the branded background. */
      fg: string;
      /** Optional darker highlight colour for the title/CTA text. */
      fgTitle?: string;
      /** Optional decorative Ionicon shown in the corner chip. */
      chipIcon?: keyof typeof Ionicons.glyphMap;
      /** Icon chip background — leave undefined to hide the chip. */
      chipBg?: string;
      /** Icon chip foreground colour. */
      chipFg?: string;
    };

type CardCopy = {
  key: CardKey;
  eyebrow: string;
  title: string;
  subtitle: string;
  cta: string;
  front: FrontVariant;
  back: {
    heading: string;
    icon: keyof typeof Ionicons.glyphMap;
    bullets: string[];
    footer?: string;
  };
  badge?: string;
};

// Royalty-free photography (Unsplash) — hero shots that match the theme
// of each card. Loaded remote-first with a neutral fallback tint so the
// card renders instantly even on slow connections.
const CARDS: CardCopy[] = [
  {
    key: "cover_price",
    eyebrow: "Sell with confidence",
    title: "Get a Guaranteed Cover Price",
    subtitle: "Fourbuy Car Buying Co. commits a firm buy price, upfront.",
    cta: "Learn how it works",
    front: {
      kind: "photo",
      image:
        "https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1400&q=80",
      accent: "rgba(10,18,32,0.55)",
      frontIcon: "shield-checkmark",
    },
    back: {
      heading: "How the Cover Price works",
      icon: "shield-checkmark",
      bullets: [
        "Submit any vehicle in under 90 seconds from your phone.",
        "Fourbuy issues a firm, guaranteed cover price — no lowballing on collection.",
        "Backed by our national trade network, so you can commit to your customer today.",
        "One flat submission fee. Cover Price holds for 7 days.",
      ],
      footer: "Move stock faster. Reduce trade-in exposure.",
    },
  },
  {
    key: "rewards",
    // Takealot-branded card — the partner logo IS the identity.
    // Copy focuses on the tangible reward (Takealot vouchers) rather
    // than the abstract "points" so dealers instantly grasp the value.
    // We use a clean off-white surface so the supplied Takealot logo
    // (with its own iconic blue tile) reads as an authentic partner
    // lock-up rather than blending into a same-blue card background.
    eyebrow: "For every deal",
    title: "Earn Takealot Vouchers",
    subtitle: "Turn every submission into points. Redeem for real value.",
    cta: "See how you earn",
    front: {
      kind: "brand",
      bg: "#FFFFFF",
      bgAccent: "#F0F6FB",
      logo: TAKEALOT_LOGO,
      logoWidth: 180,
      fg: "#3F3F46",
      fgTitle: "#0F79B4", // Match Takealot brand blue for the headline.
      chipIcon: "gift",
      chipBg: "#0F79B4",
      chipFg: "#FFFFFF",
    },
    back: {
      heading: "Dealer Rewards",
      icon: "gift",
      bullets: [
        "Earn 1 point for every billable valuation you submit.",
        "Refer another dealer — earn bonus points when they submit their first vehicle.",
        "Redeem points for Takealot vouchers, delivered directly to you.",
        "Track your balance & referral link in the Rewards tab.",
      ],
      footer: "Yours to keep — no expiry, no fine print.",
    },
  },
  {
    key: "ad_vaps",
    // VAPS SA-branded card. The logo has red + dark grey lock-up on
    // white — so we keep the front face light with a soft off-white
    // gradient and use the VAPS red as the CTA accent to echo the
    // brand's own colour palette.
    eyebrow: "Advertising",
    title: "Innovative Dealer Value",
    subtitle: "Value-added products & extended warranties for dealer stock.",
    cta: "Learn more",
    front: {
      kind: "brand",
      bg: "#FFFFFF",
      bgAccent: "#F4F4F5",
      logo: VAPSSA_LOGO,
      logoWidth: 165,
      fg: "#3F3F46", // Cool grey for body copy on the white card.
      fgTitle: "#111111", // Near-black for the headline.
    },
    badge: "Sponsored",
    back: {
      heading: "About VAPS SA",
      icon: "shield-outline",
      bullets: [
        "South Africa's independent VAPS provider for the used-car trade.",
        "Extended warranties, service plans, tyre & rim, deposit protection.",
        "Fast dealer sign-up and monthly settlement.",
        "Boost your F&I income per unit sold.",
      ],
      footer: "Sponsored placement — not affiliated with Fourbuy.",
    },
  },
];

export default function HomeScreen() {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { user } = useAuth();
  const insets = useBottomTabBarHeight();
  const { width } = useWindowDimensions();

  const greetingName = useMemo(() => {
    const info = user?.dealer_info;
    if (info?.first_name) {
      return info.first_name.trim();
    }
    const raw = user?.email || "";
    if (!raw) return "";
    const cleaned = raw.split("@")[0].replace(/[._-]+/g, " ").trim();
    return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : "";
  }, [user]);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets + spacing.xl }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <BrandLogo size="md" />
        </View>

        {/* Welcome */}
        <View style={styles.welcomeBlock}>
          <Text style={styles.welcomeEyebrow}>Welcome back{greetingName ? "," : ""}</Text>
          {greetingName ? <Text style={styles.welcomeName}>{greetingName}</Text> : null}
          <Text style={styles.welcomeSub}>Explore what Fourbuy has to offer today.</Text>
        </View>

        {/* Flip cards */}
        <View style={styles.cardsWrap}>
          {CARDS.map((c) => (
            <FlipCard key={c.key} card={c} styles={styles} colors={colors} widthAvailable={width} />
          ))}
        </View>

        {/* Small hint */}
        <View style={styles.hintRow}>
          <Ionicons name="finger-print-outline" size={14} color={colors.textSecondary} />
          <Text style={styles.hintText}>Tap any card to flip it and read more.</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// FlipCard
// ---------------------------------------------------------------------------
type FlipCardProps = {
  card: CardCopy;
  styles: ReturnType<typeof makeStyles>;
  colors: Palette;
  widthAvailable: number;
};

function FlipCard({ card, styles, colors }: FlipCardProps) {
  const [flipped, setFlipped] = useState(false);
  const rot = useSharedValue(0); // 0 = front, 1 = back

  const flip = useCallback(() => {
    const next = !flipped;
    setFlipped(next);
    rot.value = withTiming(next ? 1 : 0, {
      duration: 480,
      easing: Easing.out(Easing.cubic),
    });
  }, [flipped, rot]);

  const frontStyle = useAnimatedStyle(() => {
    const deg = interpolate(rot.value, [0, 1], [0, 180]);
    // Fade out crisply just past 90° so the label doesn't ghost through
    // the mirror-image side while the back face is rotating in.
    const opacity = rot.value < 0.5 ? 1 : 0;
    return {
      transform: [{ perspective: 1000 }, { rotateY: `${deg}deg` }],
      opacity,
    };
  });

  const backStyle = useAnimatedStyle(() => {
    const deg = interpolate(rot.value, [0, 1], [180, 360]);
    const opacity = rot.value >= 0.5 ? 1 : 0;
    return {
      transform: [{ perspective: 1000 }, { rotateY: `${deg}deg` }],
      opacity,
    };
  });

  const frontFace = card.front.kind === "photo" ? (
    <PhotoFrontFace card={card} styles={styles} />
  ) : (
    <BrandFrontFace card={card} styles={styles} />
  );

  return (
    <Pressable
      onPress={flip}
      accessibilityRole="button"
      accessibilityLabel={`${card.title}. Tap to ${flipped ? "hide details" : "read more"}.`}
      style={styles.cardOuter}
    >
      {/* FRONT */}
      <Animated.View style={[styles.cardFace, frontStyle]} pointerEvents={flipped ? "none" : "auto"}>
        {frontFace}
      </Animated.View>

      {/* BACK */}
      <Animated.View
        style={[styles.cardFace, styles.cardFaceBack, backStyle]}
        pointerEvents={flipped ? "auto" : "none"}
      >
        <View style={styles.cardBackInner}>
          <View style={styles.cardTopRow}>
            <View style={[styles.cardIconChip, { backgroundColor: colors.primary }]}>
              <Ionicons name={card.back.icon} size={16} color={colors.onPrimary || "#fff"} />
            </View>
            <Text style={[styles.cardEyebrow, { color: colors.primary }]}>{card.eyebrow}</Text>
          </View>

          <Text style={[styles.cardTitle, { color: colors.text, marginTop: spacing.sm }]}>
            {card.back.heading}
          </Text>

          <View style={styles.bulletList}>
            {card.back.bullets.map((b, i) => (
              <View key={i} style={styles.bulletRow}>
                <Ionicons
                  name="checkmark-circle"
                  size={16}
                  color={colors.primary}
                  style={{ marginTop: 2 }}
                />
                <Text style={styles.bulletText}>{b}</Text>
              </View>
            ))}
          </View>

          {card.back.footer ? <Text style={styles.cardBackFooter}>{card.back.footer}</Text> : null}

          <View style={styles.cardBackFlipHint}>
            <Ionicons name="return-up-back" size={14} color={colors.textSecondary} />
            <Text style={styles.cardBackFlipHintText}>Tap to flip back</Text>
          </View>
        </View>
      </Animated.View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Front-face renderers
// ---------------------------------------------------------------------------
function PhotoFrontFace({
  card,
  styles,
}: {
  card: CardCopy;
  styles: ReturnType<typeof makeStyles>;
}) {
  if (card.front.kind !== "photo") return null;
  const { image, accent, frontIcon } = card.front;
  return (
    <ImageBackground
      source={{ uri: image }}
      style={styles.cardBg}
      imageStyle={styles.cardBgImg}
      resizeMode="cover"
    >
      <View style={[styles.cardOverlay, { backgroundColor: accent }]}>
        <View style={styles.cardTopRow}>
          <View style={styles.cardIconChip}>
            <Ionicons name={frontIcon} size={16} color="#fff" />
          </View>
          <Text style={styles.cardEyebrow}>{card.eyebrow}</Text>
          {card.badge ? (
            <View style={styles.cardBadge}>
              <Text style={styles.cardBadgeText}>{card.badge}</Text>
            </View>
          ) : null}
        </View>

        <View style={{ flex: 1 }} />

        <Text style={styles.cardTitle}>{card.title}</Text>
        <Text style={styles.cardSubtitle}>{card.subtitle}</Text>

        <View style={styles.cardCtaRow}>
          <Text style={styles.cardCtaText}>{card.cta}</Text>
          <Ionicons name="chevron-forward" size={14} color="#fff" />
        </View>
      </View>
    </ImageBackground>
  );
}

function BrandFrontFace({
  card,
  styles,
}: {
  card: CardCopy;
  styles: ReturnType<typeof makeStyles>;
}) {
  if (card.front.kind !== "brand") return null;
  const { bg, bgAccent, logo, logoWidth, fg, fgTitle, chipIcon, chipBg, chipFg } = card.front;
  const titleColor = fgTitle ?? fg;
  const isDarkText = titleColor.toLowerCase() === "#111111" || titleColor.toLowerCase().startsWith("#0") || titleColor.toLowerCase().startsWith("#1") || titleColor.toLowerCase().startsWith("#2") || titleColor.toLowerCase().startsWith("#3");
  // Badge / eyebrow contrast helpers on the branded surface.
  const badgeBg = isDarkText ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.18)";
  const badgeFg = isDarkText ? "#111111" : "#FFFFFF";

  return (
    <View style={[styles.brandFace, { backgroundColor: bg }]}>
      {/* Optional soft top→bottom secondary tint for depth. Placed as a
         separate overlay so we don't need a gradient dependency. */}
      {bgAccent ? (
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: "55%",
            backgroundColor: bgAccent,
            opacity: 0.55,
          }}
          pointerEvents="none"
        />
      ) : null}

      {/* Logo watermark — big and centred as the hero. */}
      <View style={styles.brandLogoWrap} pointerEvents="none">
        <Image source={logo} style={{ width: logoWidth, height: logoWidth * 0.5 }} resizeMode="contain" />
      </View>

      {/* Content sits above the logo, aligned to bottom. */}
      <View style={styles.brandContent}>
        <View style={styles.cardTopRow}>
          {chipIcon && chipBg ? (
            <View style={[styles.cardIconChip, { backgroundColor: chipBg }]}>
              <Ionicons name={chipIcon} size={16} color={chipFg || "#fff"} />
            </View>
          ) : null}
          <Text style={[styles.cardEyebrow, { color: fg }]}>{card.eyebrow}</Text>
          {card.badge ? (
            <View style={[styles.cardBadge, { backgroundColor: badgeBg }]}>
              <Text style={[styles.cardBadgeText, { color: badgeFg }]}>{card.badge}</Text>
            </View>
          ) : null}
        </View>

        <Text style={[styles.cardTitle, { color: titleColor, marginTop: spacing.sm }]}>
          {card.title}
        </Text>
        <Text style={[styles.cardSubtitle, { color: fg, opacity: isDarkText ? 0.75 : 0.9 }]}>
          {card.subtitle}
        </Text>

        <View style={styles.cardCtaRow}>
          <Text style={[styles.cardCtaText, { color: titleColor }]}>{card.cta}</Text>
          <Ionicons name="chevron-forward" size={14} color={titleColor} />
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const CARD_HEIGHT = 260;

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: colors.bg,
    },
    scroll: {
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
    },
    header: {
      alignItems: "center",
      paddingVertical: spacing.md,
    },
    welcomeBlock: {
      paddingHorizontal: spacing.xs,
      paddingBottom: spacing.lg,
    },
    welcomeEyebrow: {
      ...fonts.eyebrow,
      color: colors.textSecondary,
      marginBottom: 2,
    },
    welcomeName: {
      ...fonts.hero,
      color: colors.text,
      marginBottom: 4,
    },
    welcomeSub: {
      ...fonts.body,
      color: colors.textSecondary,
    },
    cardsWrap: {
      gap: spacing.md,
    },
    cardOuter: {
      height: CARD_HEIGHT,
      borderRadius: radius.lg,
      // Perspective/backface tricks require overflow so rotated back face
      // clips cleanly inside the card silhouette.
      overflow: "hidden",
      // Subtle floating shadow — same feel across day/night by using the
      // paper elevation border in dark mode.
      ...Platform.select({
        ios: {
          shadowColor: "#000",
          shadowOpacity: 0.18,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 6 },
        },
        android: { elevation: 4 },
      }),
    },
    cardFace: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      borderRadius: radius.lg,
      // Not all RN targets support `backfaceVisibility`; we hide via
      // opacity in the animated style anyway, so this is defensive.
      backfaceVisibility: "hidden",
    },
    cardFaceBack: {
      backgroundColor: colors.paper,
      borderWidth: 1,
      borderColor: colors.border,
    },
    cardBg: {
      flex: 1,
      justifyContent: "flex-end",
    },
    cardBgImg: {
      borderRadius: radius.lg,
    },
    // ------ Brand-front-face variant ------
    brandFace: {
      // Fill the parent card face explicitly rather than relying on
      // `flex: 1` inside a `position: absolute` parent, which can render
      // as zero-height on react-native-web in some Metro configs.
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      borderRadius: radius.lg,
      overflow: "hidden",
      padding: spacing.md,
    },
    brandLogoWrap: {
      // The logo is our hero — centre it in the top half of the card
      // so it reads instantly as "this is Takealot / VAPS SA territory"
      // before the dealer even reads the copy.
      position: "absolute",
      top: spacing.md,
      left: 0,
      right: 0,
      alignItems: "center",
    },
    brandContent: {
      position: "absolute",
      left: spacing.md,
      right: spacing.md,
      bottom: spacing.md,
    },
    cardOverlay: {
      flex: 1,
      padding: spacing.md,
      justifyContent: "flex-end",
    },
    cardTopRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
    },
    cardIconChip: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(255,255,255,0.16)",
    },
    cardEyebrow: {
      ...fonts.eyebrow,
      color: "#fff",
      flexShrink: 1,
    },
    cardBadge: {
      marginLeft: "auto",
      backgroundColor: "rgba(255,255,255,0.16)",
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
      borderRadius: radius.pill,
    },
    cardBadgeText: {
      ...fonts.small,
      color: "#fff",
      fontWeight: "700",
    },
    cardTitle: {
      ...fonts.h1,
      color: "#fff",
      marginTop: spacing.sm,
    },
    cardSubtitle: {
      ...fonts.small,
      color: "rgba(255,255,255,0.85)",
      marginTop: 4,
    },
    cardCtaRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      marginTop: spacing.md,
    },
    cardCtaText: {
      ...fonts.smallStrong,
      color: "#fff",
    },
    // Back face
    cardBackInner: {
      flex: 1,
      padding: spacing.md,
    },
    bulletList: {
      marginTop: spacing.sm,
      gap: 6,
    },
    bulletRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: spacing.sm,
      paddingRight: spacing.sm,
    },
    bulletText: {
      ...fonts.small,
      color: colors.text,
      flex: 1,
      lineHeight: 18,
    },
    cardBackFooter: {
      ...fonts.small,
      color: colors.textSecondary,
      fontStyle: "italic",
      marginTop: spacing.sm,
    },
    cardBackFlipHint: {
      position: "absolute",
      right: spacing.md,
      bottom: spacing.sm,
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    cardBackFlipHintText: {
      ...fonts.small,
      color: colors.textSecondary,
      fontSize: 11,
    },
    hintRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      marginTop: spacing.lg,
      opacity: 0.85,
    },
    hintText: {
      ...fonts.small,
      color: colors.textSecondary,
      fontSize: 12,
    },
  });
