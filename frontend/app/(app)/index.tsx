import { useMemo, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ImageBackground,
  Pressable,
  useWindowDimensions,
  Platform,
} from "react-native";
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

type CardCopy = {
  key: CardKey;
  eyebrow: string;
  title: string;
  subtitle: string;
  cta: string;
  image: string;
  accent: string; // Overlay tint for photo (RGBA)
  frontIcon: keyof typeof Ionicons.glyphMap;
  back: {
    heading: string;
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
    image:
      "https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1400&q=80",
    accent: "rgba(10,18,32,0.55)",
    frontIcon: "shield-checkmark",
    back: {
      heading: "How the Cover Price works",
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
    eyebrow: "For every deal",
    title: "Earn with the Dealer Reward Programme",
    subtitle: "Turn every submission into points. Redeem for real value.",
    cta: "See how you earn",
    image:
      "https://images.unsplash.com/photo-1607083206968-13611e3d76db?auto=format&fit=crop&w=1400&q=80",
    accent: "rgba(20,10,32,0.55)",
    frontIcon: "gift",
    back: {
      heading: "Dealer Rewards",
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
    eyebrow: "Advertising",
    title: "VAPS SA — Cover Your Deals",
    subtitle: "Value-added products & extended warranties for dealer stock.",
    cta: "Learn more",
    image:
      "https://images.unsplash.com/photo-1450101499163-c8848c66ca85?auto=format&fit=crop&w=1400&q=80",
    accent: "rgba(6,24,20,0.55)",
    frontIcon: "megaphone",
    badge: "Sponsored",
    back: {
      heading: "About VAPS SA",
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

  return (
    <Pressable
      onPress={flip}
      accessibilityRole="button"
      accessibilityLabel={`${card.title}. Tap to ${flipped ? "hide details" : "read more"}.`}
      style={styles.cardOuter}
    >
      {/* FRONT */}
      <Animated.View style={[styles.cardFace, frontStyle]} pointerEvents={flipped ? "none" : "auto"}>
        <ImageBackground
          source={{ uri: card.image }}
          style={styles.cardBg}
          imageStyle={styles.cardBgImg}
          resizeMode="cover"
        >
          <View style={[styles.cardOverlay, { backgroundColor: card.accent }]}>
            <View style={styles.cardTopRow}>
              <View style={styles.cardIconChip}>
                <Ionicons name={card.frontIcon} size={16} color="#fff" />
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
      </Animated.View>

      {/* BACK */}
      <Animated.View
        style={[styles.cardFace, styles.cardFaceBack, backStyle]}
        pointerEvents={flipped ? "auto" : "none"}
      >
        <View style={styles.cardBackInner}>
          <View style={styles.cardTopRow}>
            <View style={[styles.cardIconChip, { backgroundColor: colors.primary }]}>
              <Ionicons name={card.frontIcon} size={16} color={colors.onPrimary || "#fff"} />
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
