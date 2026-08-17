import { useEffect, useMemo, useState } from "react";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { View, Text, StyleSheet, ScrollView, Image, Share, Platform, useWindowDimensions, Modal, TextInput, ActivityIndicator, KeyboardAvoidingView, Alert } from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { apiFetch, TOKEN_KEY } from "@/src/api";
import { storage } from "@/src/utils/storage";
import { SafeAreaView } from "react-native-safe-area-context";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { useAuth } from "@/src/context/AuthContext";
import { spacing, radius, fonts, BRAND } from "@/src/theme";
import { useThemeColors, useTheme, type Palette } from "@/src/theme/ThemeContext";
import BrandLogo from "@/src/components/BrandLogo";
import NotificationPreferencesSection from "@/src/components/profile/NotificationPreferencesSection";
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

  // ---------------------------------------------------------------------
  // Company Invoice Details — separate un-branded PDF the dealer can
  // hand to suppliers or customers. The dealership doc holds banking +
  // contact fields that the dealer can self-manage (backend endpoints:
  // GET/PATCH /api/my-dealership; PDF at
  // /api/my-dealership/invoice-details.pdf).
  // ---------------------------------------------------------------------
  type DealershipInvoiceFields = {
    id?: string;
    name?: string | null;
    address?: string | null;
    company_reg_no?: string | null;
    vat_no?: string | null;
    contact_person?: string | null;
    contact_email?: string | null;
    contact_phone?: string | null;
    website?: string | null;
    bank_name?: string | null;
    bank_account_holder?: string | null;
    bank_account_no?: string | null;
    bank_branch_code?: string | null;
    bank_account_type?: string | null;
    bank_swift?: string | null;
    invoice_notes?: string | null;
  };
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [dealership, setDealership] = useState<DealershipInvoiceFields | null>(null);
  const [invoiceForm, setInvoiceForm] = useState<DealershipInvoiceFields>({});
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [invoiceSaving, setInvoiceSaving] = useState(false);
  const [invoiceDownloading, setInvoiceDownloading] = useState(false);

  useEffect(() => {
    if (user?.role !== "dealer") return;
    // Lazy-load the dealership record once per profile mount so the
    // Company Invoice Details section can show pre-existing values.
    // Failures are non-fatal — the modal will show an empty form and
    // the download button will surface any auth error at click time.
    (async () => {
      try {
        setInvoiceLoading(true);
        const r = await apiFetch("/api/my-dealership");
        const d = r?.dealership || null;
        if (d) {
          setDealership(d);
          setInvoiceForm({
            address: d.address ?? "",
            contact_person: d.contact_person ?? "",
            contact_email: d.contact_email ?? "",
            contact_phone: d.contact_phone ?? "",
            website: d.website ?? "",
            bank_name: d.bank_name ?? "",
            bank_account_holder: d.bank_account_holder ?? "",
            bank_account_no: d.bank_account_no ?? "",
            bank_branch_code: d.bank_branch_code ?? "",
            bank_account_type: d.bank_account_type ?? "",
            bank_swift: d.bank_swift ?? "",
            invoice_notes: d.invoice_notes ?? "",
          });
        }
      } catch {
        /* non-fatal — keep the section usable */
      } finally {
        setInvoiceLoading(false);
      }
    })();
  }, [user?.role]);

  const saveInvoiceDetails = async () => {
    try {
      setInvoiceSaving(true);
      // Send blanks as null so the backend can clear a field the dealer
      // deliberately wiped. `exclude_none=True` on the pydantic model
      // means empty strings still hit the DB (blanking works), while
      // omitted keys keep the existing value untouched.
      const body = { ...invoiceForm };
      const r = await apiFetch("/api/my-dealership", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setDealership(r?.dealership || null);
      setInvoiceOpen(false);
      Alert.alert("Saved", "Your company invoice details have been updated.");
    } catch (e: any) {
      Alert.alert("Could not save", e?.message || "Unknown error.");
    } finally {
      setInvoiceSaving(false);
    }
  };

  const downloadInvoicePdf = async () => {
    try {
      setInvoiceDownloading(true);
      const token = await storage.secureGet<string>(TOKEN_KEY, "");
      const base = process.env.EXPO_PUBLIC_BACKEND_URL || "";
      const ts = Date.now();
      const filename = `${(dealership?.name || "company").replace(/\s+/g, "_")}_invoice_details.pdf`;
      if (Platform.OS === "web") {
        // Web: fetch with header, blob → open in new tab. Safer than
        // putting the token in the URL (would leak into browser history).
        const res = await fetch(`${base}/api/my-dealership/invoice-details.pdf?t=${ts}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          cache: "no-store" as any,
        });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const blob = await res.blob();
        const objUrl = URL.createObjectURL(blob);
        // Trigger a download rather than an in-tab open — this is a
        // supplier/customer artefact, so a File download is friendlier
        // than a preview tab.
        const a = document.createElement("a");
        a.href = objUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
      } else {
        // Native: download to cache, then share. The share sheet is the
        // right primitive here — dealer wants to attach the PDF to a
        // WhatsApp / email to the supplier.
        const path = `${FileSystem.cacheDirectory}${filename}`;
        const dl = await FileSystem.downloadAsync(
          `${base}/api/my-dealership/invoice-details.pdf?t=${ts}&access_token=${encodeURIComponent(token || "")}`,
          path,
        );
        if (dl.status !== 200) throw new Error(`Server returned ${dl.status}`);
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(dl.uri, {
            mimeType: "application/pdf",
            dialogTitle: "Company Invoice Details",
            UTI: "com.adobe.pdf",
          });
        } else {
          await WebBrowser.openBrowserAsync(dl.uri);
        }
      }
    } catch (e: any) {
      Alert.alert("Download failed", e?.message || "Could not generate the PDF.");
    } finally {
      setInvoiceDownloading(false);
    }
  };

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
    // In dev this comes from the packager proxy URL; in production it
    // is the deployed domain (rewritten by Emergent's Publish step).
    // We deliberately have NO hardcoded fallback here — falling back
    // to a specific preview URL would send referral links to the wrong
    // domain post-deploy, so if the env var is missing we return an
    // empty string and the Share sheet will surface the code alone.
    const base = (process.env as any).EXPO_PUBLIC_BACKEND_URL;
    if (!base) return "";
    return `${base.replace(/\/$/, "")}/register?ref=${encodeURIComponent(code)}`;
  };

  const handleShare = async () => {
    if (!referralCode || sharing) return;
    setSharing(true);
    try {
      const url = buildShareUrl(referralCode);
      const message =
        `Join TRADE AI powered by FOURBUY — the vehicle valuation app for dealers.\n\n` +
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
            await nav.share({ title: "TRADE AI powered by FOURBUY", text: message, url });
          } else if (nav?.clipboard?.writeText) {
            await nav.clipboard.writeText(message);
            // eslint-disable-next-line no-alert
            (globalThis as any).alert?.("Referral message copied to clipboard.");
          }
        } catch {
          /* user cancelled — no-op */
        }
      } else {
        await Share.share({ message, url, title: "TRADE AI powered by FOURBUY" });
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

        {/* Company Invoice Details — un-branded PDF the dealer can hand to
            suppliers / customers. Deliberately separate from the Company
            section above so the "invoice-safe" nature is obvious. */}
        {user.role === "dealer" ? (
          <View style={styles.section}>
            <View style={styles.invoiceHeaderRow}>
              <Text style={styles.sectionTitle}>Company Invoice Details</Text>
              <TouchableOpacity
                style={styles.invoiceEditBtn}
                onPress={() => setInvoiceOpen(true)}
                disabled={invoiceLoading}
                testID="profile-invoice-edit"
              >
                <Ionicons name="create-outline" size={14} color={colors.textSecondary} />
                <Text style={styles.invoiceEditBtnText}>Edit</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.hintText}>
              A clean, un-branded PDF summary of your company&apos;s invoicing
              details (address, VAT, banking, contact). Send it to suppliers
              or customers who need your details on file.
            </Text>
            {/* Quick preview of what will render — surfaces empty state gently */}
            <View style={styles.invoicePreviewCard}>
              <Text style={styles.invoicePreviewCompany}>
                {dealership?.name || user.company_info?.company_name || "Your company"}
              </Text>
              {dealership?.contact_email ? (
                <Text style={styles.invoicePreviewMeta}>{dealership.contact_email}</Text>
              ) : null}
              {dealership?.bank_name ? (
                <Text style={styles.invoicePreviewMeta}>
                  {dealership.bank_name}
                  {dealership.bank_account_no ? ` · Acct ${dealership.bank_account_no}` : ""}
                </Text>
              ) : (
                <Text style={styles.invoicePreviewEmpty}>
                  No banking details added yet — tap Edit to add them.
                </Text>
              )}
            </View>
            <TouchableOpacity
              style={[styles.downloadInvoiceBtn, invoiceDownloading && { opacity: 0.6 }]}
              onPress={downloadInvoicePdf}
              disabled={invoiceDownloading}
              testID="profile-download-invoice-details"
            >
              {invoiceDownloading ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Ionicons name="document-text-outline" size={16} color={colors.onPrimary} />
              )}
              <Text style={styles.downloadInvoiceBtnText}>
                {invoiceDownloading ? "Preparing…" : "Download Company Invoice Details"}
              </Text>
            </TouchableOpacity>
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

        <TouchableOpacity
          testID="logout-button"
          style={styles.logoutBtn}
          onPress={handleLogout}
        >
          <Ionicons name="log-out-outline" size={20} color={colors.danger} />
          <Text style={styles.logoutText}>Sign Out</Text>
        </TouchableOpacity>
      </ScrollView>
      {/* Company Invoice Details editor — modal so we don't blow up
          the profile scroll surface for the many dealers who won't
          need this every session. */}
      <Modal
        visible={invoiceOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setInvoiceOpen(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.modalBackdrop}
        >
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Company Invoice Details</Text>
              <TouchableOpacity
                onPress={() => setInvoiceOpen(false)}
                style={styles.modalClose}
                testID="profile-invoice-close"
              >
                <Ionicons name="close" size={22} color={colors.text} />
              </TouchableOpacity>
            </View>
            <ScrollView
              contentContainerStyle={{ paddingBottom: 24 }}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={styles.modalHelper}>
                These details appear on the un-branded PDF you can send to
                suppliers and customers. Leave any field blank to hide it.
              </Text>

              <Text style={styles.modalGroupTitle}>Business address</Text>
              <TextInput
                style={[styles.modalInput, { minHeight: 68 }]}
                value={invoiceForm.address || ""}
                onChangeText={(v) => setInvoiceForm({ ...invoiceForm, address: v })}
                placeholder="Street address, suburb, city, postcode"
                placeholderTextColor={colors.textSecondary}
                multiline
              />

              <Text style={styles.modalGroupTitle}>Contact</Text>
              <TextInput
                style={styles.modalInput}
                value={invoiceForm.contact_person || ""}
                onChangeText={(v) => setInvoiceForm({ ...invoiceForm, contact_person: v })}
                placeholder="Contact person (e.g. John Smith)"
                placeholderTextColor={colors.textSecondary}
              />
              <TextInput
                style={styles.modalInput}
                value={invoiceForm.contact_email || ""}
                onChangeText={(v) => setInvoiceForm({ ...invoiceForm, contact_email: v })}
                placeholder="Email"
                autoCapitalize="none"
                keyboardType="email-address"
                placeholderTextColor={colors.textSecondary}
              />
              <TextInput
                style={styles.modalInput}
                value={invoiceForm.contact_phone || ""}
                onChangeText={(v) => setInvoiceForm({ ...invoiceForm, contact_phone: v })}
                placeholder="Phone"
                keyboardType="phone-pad"
                placeholderTextColor={colors.textSecondary}
              />
              <TextInput
                style={styles.modalInput}
                value={invoiceForm.website || ""}
                onChangeText={(v) => setInvoiceForm({ ...invoiceForm, website: v })}
                placeholder="Website (e.g. www.example.co.za)"
                autoCapitalize="none"
                placeholderTextColor={colors.textSecondary}
              />

              <Text style={styles.modalGroupTitle}>Banking</Text>
              <TextInput
                style={styles.modalInput}
                value={invoiceForm.bank_name || ""}
                onChangeText={(v) => setInvoiceForm({ ...invoiceForm, bank_name: v })}
                placeholder="Bank name"
                placeholderTextColor={colors.textSecondary}
              />
              <TextInput
                style={styles.modalInput}
                value={invoiceForm.bank_account_holder || ""}
                onChangeText={(v) => setInvoiceForm({ ...invoiceForm, bank_account_holder: v })}
                placeholder="Account holder"
                placeholderTextColor={colors.textSecondary}
              />
              <TextInput
                style={styles.modalInput}
                value={invoiceForm.bank_account_no || ""}
                onChangeText={(v) => setInvoiceForm({ ...invoiceForm, bank_account_no: v })}
                placeholder="Account number"
                keyboardType="number-pad"
                placeholderTextColor={colors.textSecondary}
              />
              <TextInput
                style={styles.modalInput}
                value={invoiceForm.bank_branch_code || ""}
                onChangeText={(v) => setInvoiceForm({ ...invoiceForm, bank_branch_code: v })}
                placeholder="Branch / universal code"
                keyboardType="number-pad"
                placeholderTextColor={colors.textSecondary}
              />
              <TextInput
                style={styles.modalInput}
                value={invoiceForm.bank_account_type || ""}
                onChangeText={(v) => setInvoiceForm({ ...invoiceForm, bank_account_type: v })}
                placeholder="Account type (e.g. Business Cheque)"
                placeholderTextColor={colors.textSecondary}
              />
              <TextInput
                style={styles.modalInput}
                value={invoiceForm.bank_swift || ""}
                onChangeText={(v) => setInvoiceForm({ ...invoiceForm, bank_swift: v })}
                placeholder="SWIFT / BIC (for international)"
                autoCapitalize="characters"
                placeholderTextColor={colors.textSecondary}
              />

              <Text style={styles.modalGroupTitle}>Notes</Text>
              <TextInput
                style={[styles.modalInput, { minHeight: 90 }]}
                value={invoiceForm.invoice_notes || ""}
                onChangeText={(v) => setInvoiceForm({ ...invoiceForm, invoice_notes: v })}
                placeholder="e.g. Payment terms: 30 days. Quote invoice number as reference."
                placeholderTextColor={colors.textSecondary}
                multiline
              />

              <TouchableOpacity
                style={[styles.modalPrimaryBtn, invoiceSaving && { opacity: 0.6 }]}
                onPress={saveInvoiceDetails}
                disabled={invoiceSaving}
                testID="profile-invoice-save"
              >
                {invoiceSaving ? (
                  <ActivityIndicator size="small" color={colors.onPrimary} />
                ) : (
                  <Text style={styles.modalPrimaryBtnText}>Save</Text>
                )}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
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

  // Company Invoice Details section
  invoiceHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.xs,
  },
  invoiceEditBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
  },
  invoiceEditBtnText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  invoicePreviewCard: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    // Palette uses `card`, not `surface` — the previous key resolved to
    // undefined which RN Web rendered as transparent.
    backgroundColor: colors.card,
    gap: 4,
  },
  invoicePreviewCompany: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  invoicePreviewMeta: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 16,
  },
  invoicePreviewEmpty: {
    color: colors.textSecondary,
    fontSize: 12,
    fontStyle: "italic",
    lineHeight: 16,
  },
  downloadInvoiceBtn: {
    marginTop: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
  },
  downloadInvoiceBtnText: {
    color: colors.onPrimary,
    fontWeight: "700",
    fontSize: 14,
  },
  // Invoice-editor modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    // The palette exposes `card` / `paper` / `cardElev` — NOT `surface`
    // or `background`. Using undefined values on RN Web renders as
    // transparent, which is what made the sheet see-through. `paper`
    // is our darkest "solid canvas" hue and the correct choice for a
    // full-height modal card.
    backgroundColor: colors.paper,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: Platform.OS === "ios" ? 24 : 12,
    maxHeight: "88%",
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.25,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: -4 },
      },
      android: { elevation: 24 },
      default: { boxShadow: "0 -6px 24px rgba(0,0,0,0.35)" as any },
    }),
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },
  modalTitle: { color: colors.text, fontSize: 18, fontWeight: "700" },
  modalClose: {
    padding: 6,
    borderRadius: 999,
  },
  modalHelper: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
    marginBottom: spacing.md,
  },
  modalGroupTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "700",
    marginTop: spacing.md,
    marginBottom: spacing.xs,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: colors.border,
    // `inputBg` is the palette's dedicated input surface — clearly
    // distinct from `paper` (the sheet) so each field visibly stands
    // out. Fixes the see-through look on both dark and light themes.
    backgroundColor: colors.inputBg,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === "ios" ? 12 : 8,
    color: colors.text,
    fontSize: 14,
    marginBottom: spacing.xs,
  },
  modalPrimaryBtn: {
    marginTop: spacing.lg,
    paddingVertical: 14,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  modalPrimaryBtnText: {
    color: colors.onPrimary,
    fontWeight: "700",
    fontSize: 15,
  },

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
