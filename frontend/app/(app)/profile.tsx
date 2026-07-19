import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Image, TextInput, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { useAuth } from "@/src/context/AuthContext";
import { colors, spacing, radius, fonts, BRAND } from "@/src/theme";
import BrandLogo from "@/src/components/BrandLogo";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useState } from "react";
import { apiFetch } from "@/src/api";

export default function Profile() {
  const { user, logout, refreshUser } = useAuth();
  const router = useRouter();
  const tabBarHeight = useBottomTabBarHeight();
  const [editingJob, setEditingJob] = useState(false);
  const [jobTitleDraft, setJobTitleDraft] = useState(user?.dealer_info?.job_title ?? "");
  const [savingJob, setSavingJob] = useState(false);

  const saveJobTitle = async () => {
    setSavingJob(true);
    try {
      await apiFetch("/api/auth/me", { method: "PATCH", body: JSON.stringify({ job_title: jobTitleDraft.trim() }) });
      if (refreshUser) await refreshUser();
      setEditingJob(false);
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Could not update job title");
    } finally {
      setSavingJob(false);
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
        <BrandLogo size="sm" />
      </View>
      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: tabBarHeight + spacing.md }]}>
        {/* WhatsApp Business-style banner: cover photo + overlaid profile pic */}
        <View style={styles.banner}>
          {user.cover_photo ? (
            <Image source={{ uri: user.cover_photo }} style={styles.coverImg} resizeMode="cover" />
          ) : (
            <View style={styles.coverPlaceholder}>
              <Ionicons name="business-outline" size={36} color={colors.textDisabled} />
              <Text style={styles.placeholderText}>NO COVER PHOTO</Text>
            </View>
          )}
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
            {editingJob ? (
              <View style={styles.jobEditRow}>
                <TextInput
                  testID="job-title-input"
                  style={styles.jobInput}
                  value={jobTitleDraft}
                  onChangeText={setJobTitleDraft}
                  placeholder="e.g. Sales Manager"
                  placeholderTextColor={colors.textDisabled}
                  autoFocus
                  editable={!savingJob}
                />
                <TouchableOpacity
                  style={[styles.jobBtn, styles.jobBtnPrimary]}
                  onPress={saveJobTitle}
                  disabled={savingJob}
                  testID="job-title-save"
                >
                  <Text style={styles.jobBtnPrimaryText}>{savingJob ? "…" : "Save"}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.jobBtn}
                  onPress={() => {
                    setEditingJob(false);
                    setJobTitleDraft(user.dealer_info?.job_title ?? "");
                  }}
                  disabled={savingJob}
                >
                  <Text style={styles.jobBtnText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Job Title</Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <Text style={styles.rowValue}>
                    {user.dealer_info?.job_title || <Text style={{ color: colors.textDisabled }}>Not set</Text>}
                  </Text>
                  <TouchableOpacity
                    testID="job-title-edit"
                    onPress={() => {
                      setJobTitleDraft(user.dealer_info?.job_title ?? "");
                      setEditingJob(true);
                    }}
                  >
                    <Ionicons name="pencil-outline" size={16} color={colors.textSecondary} />
                  </TouchableOpacity>
                </View>
              </View>
            )}
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

        {user.role === "dealer" && !user.profile_pic && !user.cover_photo ? (
          <View style={styles.hintBox}>
            <Ionicons name="information-circle-outline" size={16} color={colors.textSecondary} />
            <Text style={styles.hintText}>
              Your profile picture and cover photo are managed by Fourbuy. Contact us to update
              your dealership branding.
            </Text>
          </View>
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

const styles = StyleSheet.create({
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
    height: 160,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginBottom: 60,
    position: "relative",
  },
  coverImg: { width: "100%", height: "100%" },
  coverPlaceholder: { flex: 1, alignItems: "center", justifyContent: "center", gap: 6 },
  placeholderText: { color: colors.textDisabled, fontSize: 10, fontWeight: "800", letterSpacing: 2 },

  avatarWrap: {
    position: "absolute",
    bottom: -50,
    left: spacing.lg,
    padding: 4,
    backgroundColor: colors.bg,
    borderRadius: 60,
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
  jobBtnPrimaryText: { color: "#fff", fontWeight: "700" },
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
    alignItems: "flex-start",
    paddingVertical: 8,
    gap: spacing.md,
  },
  rowLabel: { color: colors.textSecondary, fontSize: 13 },
  rowValue: { color: colors.text, fontSize: 14, flex: 1, textAlign: "right" },

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
  },
  hintText: { color: colors.textSecondary, fontSize: 12, flex: 1, lineHeight: 17 },

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
