import { useMemo, useState } from "react";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { View, Text, StyleSheet, ScrollView, Image, Share, Platform, useWindowDimensions } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { useAuth } from "@/src/context/AuthContext";
import { spacing, radius, fonts, BRAND } from "@/src/theme";
import { useThemeColors, useTheme, type Palette } from "@/src/theme/ThemeContext";
import BrandLogo from "@/src/components/BrandLogo";
import NotificationPreferencesSection from "@/src/components/profile/NotificationPreferencesSection";
import SupplierListSection from "@/src/components/profile/SupplierListSection";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

export default function Profile() {
  const colors = useThemeColors();
  const { width: winW } = useWindowDimensions();
  // Desktop web: the cover photo was designed as a phone-width banner
  // (aspect ratio ~2.3:1 at 160dp tall). At >900dp viewports it stretched
  // horrifically wide, so we cap the banner inside a padded, centered
  // rounded card at desktop widths.
  const isWide = Platform.OS === "web" && winW >= 900;
  const styles = useMemo(() => makeStyles(colors, isWide), [colors, isWide]);
  const { mode, toggle } = useTheme();
  const { user, logout } = useAuth();
  const router = useRouter();
  const tabBarHeight = useBottomTabBarHeight();
  const [sharing, setSharing] = useState(false);

  // Referral code is auto-generated for every dealer at account creation
  // (and lazily on /auth/me for accounts that pre-date the feature). It's
  // a lifetime code — the same one for the entire duration of the account.
  const referralCode: string | null = (user as any)?.referral_code ?? null;
  // Backend enriches /auth/me with `referred_by` for dealers that were
  // signed up via another dealer's referral link. Payload shape:
  //   { name: string, dealership?: string|null, code?: string|null }
  const referredBy = (user as any)?.referred_by as
    | { name: string; dealership?: string | null; code?: string | null }
    | null
    | undefined;

  const buildShareUrl = (code: string): string => {
    // In dev we rely on the packager proxy URL; in production this becomes
    // the deployed domain (rewritten by Publish). Either way the /register
    // route accepts a `ref` query param to prefill the referrer name.
    const base =
      (process.env as any).EXPO_PUBLIC_BACKEND_URL ||
      "https://fourbuy-admin.preview.emergentagent.com";
    return `${base.replace(/\/$/, "")}/register?ref=${encodeURIComponent(code)}`;
  };

  const handleShare = async () => {
    if (!referralCode || sharing) return;
    setSharing(true);
    try {
      const url = buildShareUrl(referralCode);
      const message =
        `Join Fourbuy Car Buying Co. — the vehicle valuation app for dealers.\n\n` +
        `Use my referral code when you sign up:  ${referralCode}\n\n` +
        `${url}`;
      // React Native's cross-platform Share API — falls back to the OS
      // share sheet on native and copy-to-clipboard on web (Share is a
      // no-op there, so we also copy manually).
      if (Platform.OS === "web") {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const nav: any = (globalThis as any).navigator;
          if (nav?.share) {
            await nav.share({ title: "Fourbuy Car Buying Co.", text: message, url });
          } else if (nav?.clipboard?.writeText) {
            await nav.clipboard.writeText(message);
            // eslint-disable-next-line no-alert
            (globalThis as any).alert?.("Referral message copied to clipboard.");
          }
        } catch {
          /* user cancelled — no-op */
        }
      } else {
        await Share.share({ message, url, title: "Fourbuy Car Buying Co." });
      }
    } finally {
      setSharing(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    router.replace("/(auth)/login");
  };

  if (!user) return null;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Profile</Text>
          <Text style={styles.brandTag}>{BRAND.name}</Text>
        </View>
        <BrandLogo size="sm" linkToHome />
      </View>
      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: tabBarHeight + spacing.md }]}>
        {/* WhatsApp Business-style banner: cover photo + overlaid profile pic.
            On desktop we need TWO wrappers — an outer positioning wrapper
            (no overflow) so the avatar can hang below the banner, and an
            inner clip wrapper with border-radius + overflow:hidden that
            constrains the cover image only. Otherwise the avatar gets
            clipped by the rounded banner. */}
        <View style={styles.banner}>
          <View style={styles.coverClip}>
            {user.cover_photo ? (
              <Image
                source={{ uri: user.cover_photo }}
                style={styles.coverImg}
                resizeMode="cover"
                testID="profile-cover-img"
              />
            ) : (
              <View style={styles.coverPlaceholder}>
                <Ionicons name="business-outline" size={36} color={colors.textDisabled} />
                <Text style={styles.placeholderText}>NO COVER PHOTO</Text>
              </View>
            )}
          </View>
          <View style={styles.avatarWrap}>
            {user.profile_pic ? (
              <Image source={{ uri: user.profile_pic }} style={styles.avatarImg} testID="profile-avatar-img" />
            ) : (
              <View style={styles.avatar}>
                <Ionicons
                  name={user.role === "admin" ? "shield-checkmark" : "person"}
                  size={44}
                  color={colors.primary}
                />
              </View>
            )}
          </View>
        </View>

        <View style={styles.identity}>
          <Text style={styles.name} testID="profile-name">
            {user.dealer_info?.first_name} {user.dealer_info?.last_name}
          </Text>
          {user.dealer_info?.job_title ? (
            <Text style={styles.jobTitle} testID="profile-job-title">
              {user.dealer_info.job_title}
            </Text>
          ) : null}
          <Text style={styles.email}>{user.email}</Text>
          <View style={styles.roleBadge}>
            <Text style={styles.roleText}>{user.role.toUpperCase()}</Text>
          </View>
        </View>

        {user.role === "dealer" ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Your role</Text>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Job Title</Text>
              <View style={styles.rowValueGroup}>
                <Text
                  style={styles.rowValue}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {user.dealer_info?.job_title || (
                    <Text style={{ color: colors.textDisabled }}>Not set</Text>
                  )}
                </Text>
                <Ionicons
                  name="lock-closed-outline"
                  size={14}
                  color={colors.textDisabled}
                />
              </View>
            </View>
          </View>
        ) : null}

        {user.role === "dealer" && user.company_info ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Company</Text>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Company</Text>
              <Text style={styles.rowValue}>{user.company_info.company_name}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Address</Text>
              <Text style={styles.rowValue}>{user.company_info.company_address}</Text>
            </View>
            {user.dealer_info?.phone ? (
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Phone</Text>
                <Text style={styles.rowValue}>{user.dealer_info.phone}</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {user.role === "dealer" ? (
          <View style={styles.hintBox}>
            <Ionicons name="information-circle-outline" size={16} color={colors.textSecondary} />
            <Text style={styles.hintText}>
              Your profile details, job title, photos and dealership branding are managed by Fourbuy. Please contact your Fourbuy administrator to request any changes.
            </Text>
          </View>
        ) : null}

        {/* Share Fourbuy — dealer-only referral code + native share sheet.
            Every referred dealer earns THEIR referrer a matching Fourbuy
            Reward point for every point they earn — indefinitely. */}
        {user.role === "dealer" && referralCode ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Share Fourbuy</Text>
            <Text style={styles.hintText}>
              Invite another dealer to Fourbuy. When they&apos;re onboarded and earn a Fourbuy Rewards point, you earn one too — for the lifetime of their account.
            </Text>
            {referredBy ? (
              <View style={styles.referredByRow} testID="profile-referred-by">
                <Ionicons name="ribbon" size={14} color={colors.textSecondary} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.referredByLabel}>REFERRED BY</Text>
                  <Text style={styles.referredByName} numberOfLines={1} ellipsizeMode="tail">
                    {referredBy.name}
                    {referredBy.dealership ? `  ·  ${referredBy.dealership}` : ""}
                  </Text>
                  {referredBy.code ? (
                    <Text style={styles.referredByCode}>Code: {referredBy.code}</Text>
                  ) : null}
                </View>
              </View>
            ) : null}
            <View style={styles.referralCodeRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.referralCodeLabel}>YOUR REFERRAL CODE</Text>
                <Text style={styles.referralCodeValue} selectable testID="referral-code-value">
                  {referralCode}
                </Text>
              </View>
              <TouchableOpacity
                onPress={handleShare}
                style={styles.shareBtn}
                testID="share-fourbuy-btn"
                disabled={sharing}
                accessibilityLabel="Share Fourbuy with a dealer"
              >
                <Ionicons name="share-outline" size={16} color={colors.onPrimary} />
                <Text style={styles.shareBtnText}>Share</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}

        {/* Appearance / theme toggle */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Appearance</Text>
          <View style={styles.themeRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.themeLabel}>Theme</Text>
              <Text style={styles.themeSub}>
                {mode === "dark"
                  ? "Night mode is on — dark backgrounds, light text."
                  : "Day mode is on — light backgrounds, dark text."}
              </Text>
            </View>
            <View style={styles.themeToggleGroup}>
              <TouchableOpacity
                testID="theme-toggle-dark"
                onPress={() => { if (mode !== "dark") toggle(); }}
                style={[
                  styles.themeToggleBtn,
                  mode === "dark" && styles.themeToggleBtnActive,
                ]}
                accessibilityLabel="Enable dark (night) mode"
              >
                <Ionicons
                  name="moon"
                  size={16}
                  color={mode === "dark" ? colors.onPrimary : colors.textSecondary}
                />
                <Text
                  style={[
                    styles.themeToggleText,
                    mode === "dark" && styles.themeToggleTextActive,
                  ]}
                >
                  Night
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="theme-toggle-light"
                onPress={() => { if (mode !== "light") toggle(); }}
                style={[
                  styles.themeToggleBtn,
                  mode === "light" && styles.themeToggleBtnActive,
                ]}
                accessibilityLabel="Enable light (day) mode"
              >
                <Ionicons
                  name="sunny"
                  size={16}
                  color={mode === "light" ? colors.onPrimary : colors.textSecondary}
                />
                <Text
                  style={[
                    styles.themeToggleText,
                    mode === "light" && styles.themeToggleTextActive,
                  ]}
                >
                  Day
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>

        {/* Push notification preferences — per-type opt-in toggles.
            Only useful for dealers (admins have their own console);
            hide from admin to keep the screen focused. */}
        {user?.role !== "admin" ? (
          <NotificationPreferencesSection colors={colors} />
        ) : null}

        {/* Recon Suppliers — dealership-scoped supplier catalog. Only
            managerial users (backend flag `is_pricing_agent`) can
            add / edit / delete; the section is hidden entirely for
            everyone else. */}
        {user?.role !== "admin" && (user as any)?.is_pricing_agent ? (
          <SupplierListSection colors={colors} />
        ) : null}

        <TouchableOpacity
          testID="logout-button"
          style={styles.logoutBtn}
          onPress={handleLogout}
        >
          <Ionicons name="log-out-outline" size={20} color={colors.danger} />
          <Text style={styles.logoutText}>Sign Out</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: Palette, isWide: boolean) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.paper,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: { color: colors.text, fontSize: 24, fontWeight: "800", letterSpacing: 0.3 },
  brandTag: { color: colors.textSecondary, fontSize: 12, marginTop: 4, letterSpacing: 0.4 },
  scroll: { padding: 0 },

  banner: {
    // Outer positioning wrapper. On desktop we constrain the width and
    // centre the banner, but crucially we DO NOT clip overflow here so
    // that the avatar (position:absolute, bottom:-50) can hang below.
    // The rounded/clipped cover image lives inside `coverClip`. Width
    // is capped at 720 so the banner + avatar + identity block all
    // share the same visual column and the page doesn't push the
    // profile below the fold on desktop.
    ...(isWide
      ? {
          maxWidth: 720,
          width: "100%",
          alignSelf: "center",
          marginTop: spacing.md,
        }
      : {}),
    marginBottom: 60,
    position: "relative",
  },
  coverClip: {
    // Inner container that actually holds the cover image (or placeholder)
    // and clips it to a rounded rectangle on desktop / full-bleed banner
    // on mobile. We anchor on aspectRatio 16/9 (rather than fixed
    // heights) so the SAME uploaded photo crops identically across
    // phones, tablets, and desktop web — no more "top of the dealership
    // cut off on web". On desktop we cap the width so the banner
    // doesn't hog the whole viewport and push the profile below the
    // fold; the aspect ratio is preserved so nothing gets cropped.
    width: "100%",
    aspectRatio: 16 / 9,
    backgroundColor: colors.card,
    overflow: "hidden",
    ...(isWide
      ? {
          maxWidth: 720,
          alignSelf: "center",
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: colors.border,
        }
      : {
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }),
  },
  coverImg: {
    width: "100%",
    height: "100%",
  },
  coverPlaceholder: { flex: 1, alignItems: "center", justifyContent: "center", gap: 6 },
  placeholderText: { color: colors.textDisabled, fontSize: 10, fontWeight: "800", letterSpacing: 2 },

  avatarWrap: {
    position: "absolute",
    bottom: -50,
    left: isWide ? spacing.lg * 2 : spacing.lg,
    padding: 4,
    backgroundColor: colors.bg,
    borderRadius: 60,
    // Elevate above the cover clip so we don't get clipped by any parent
    // stacking context. On web this also helps ensure the avatar renders
    // above the banner border/shadow.
    zIndex: 2,
    ...(Platform.OS === "web" ? { boxShadow: "0 2px 8px rgba(0,0,0,0.15)" } as any : { elevation: 4 }),
  },
  avatarImg: {
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 2,
    borderColor: colors.borderLight,
  },
  avatar: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: colors.card,
    borderWidth: 2,
    borderColor: colors.borderLight,
    alignItems: "center",
    justifyContent: "center",
  },

  identity: {
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.lg,
    marginTop: spacing.sm,
    ...(isWide
      ? { maxWidth: 720, width: "100%", alignSelf: "center", paddingHorizontal: spacing.lg * 2 }
      : {}),
  },
  name: { color: colors.text, fontSize: 24, fontWeight: "800", fontFamily: fonts.heading, letterSpacing: 0.3 },
  jobTitle: { color: colors.textSecondary, fontSize: 13, marginTop: 2, letterSpacing: 0.2, fontStyle: "italic" },
  email: { color: colors.textSecondary, fontSize: 15, marginTop: 4, letterSpacing: 0.1 },
  jobEditRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  jobInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    color: colors.text,
    backgroundColor: colors.paper,
  },
  jobBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.paper,
  },
  jobBtnPrimary: { backgroundColor: colors.text, borderColor: colors.text },
  jobBtnPrimaryText: { color: colors.onPrimary, fontWeight: "700" },
  jobBtnText: { color: colors.text, fontWeight: "600" },
  roleBadge: {
    marginTop: spacing.sm,
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.card,
  },
  roleText: { color: colors.text, fontSize: 12, fontWeight: "700", letterSpacing: 0.5 },

  section: {
    marginHorizontal: spacing.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    ...(isWide
      ? { maxWidth: 720, width: "100%", alignSelf: "center", marginHorizontal: "auto" }
      : {}),
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.3,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
    gap: spacing.md,
  },
  rowLabel: { color: colors.textSecondary, fontSize: 13 },
  rowValue: { color: colors.text, fontSize: 14, flex: 1, textAlign: "right" },
  rowValueGroup: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: spacing.sm,
  },

  hintBox: {
    marginHorizontal: spacing.lg,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: "dashed",
    borderRadius: radius.md,
    backgroundColor: colors.card,
    marginBottom: spacing.md,
    ...(isWide ? { maxWidth: 720, width: "100%", alignSelf: "center" } : {}),
  },
  hintText: { color: colors.textSecondary, fontSize: 12, flex: 1, lineHeight: 17 },

  // Referral / share card
  referralCodeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  referredByRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.paper,
  },
  referredByLabel: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
  },
  referredByName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "800",
    marginTop: 2,
  },
  referredByCode: {
    color: colors.textSecondary,
    fontSize: 11,
    marginTop: 2,
    fontFamily: fonts.mono,
    letterSpacing: 1,
  },
  referralCodeLabel: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
  },
  referralCodeValue: {
    color: colors.text,
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: 3,
    fontFamily: fonts.mono,
    marginTop: 4,
  },
  shareBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
  },
  shareBtnText: {
    color: colors.onPrimary,
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },

  // Appearance / theme toggle
  themeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  themeLabel: { color: colors.text, fontSize: 14, fontWeight: "700", letterSpacing: 0.2 },
  themeSub: { color: colors.textSecondary, fontSize: 12, marginTop: 2, lineHeight: 16 },
  themeToggleGroup: {
    flexDirection: "row",
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    padding: 3,
    gap: 2,
  },
  themeToggleBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  themeToggleBtnActive: {
    backgroundColor: colors.primary,
  },
  themeToggleText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  themeToggleTextActive: {
    color: colors.onPrimary,
  },

  logoutBtn: {
    marginHorizontal: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.danger + "55",
    backgroundColor: colors.danger + "11",
    marginTop: spacing.md,
  },
  logoutText: { color: colors.danger, fontWeight: "700", fontSize: 15 },
});
