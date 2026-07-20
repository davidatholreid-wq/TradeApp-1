import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import BrandLogo from "@/src/components/BrandLogo";
import { colors, spacing, radius, fonts, BRAND } from "@/src/theme";

/**
 * Public dealer self-registration is disabled — every dealer account is
 * created by a Fourbuy administrator. This screen is kept in the router so
 * any existing bookmarks / QR codes still land somewhere friendly, and it
 * explains what the user should do next.
 */
export default function RegisterInvitationOnly() {
  const router = useRouter();

  const emailFourbuy = () => {
    Linking.openURL(
      "mailto:admin@fourbuy.co.za?subject=New%20dealer%20account%20request",
    ).catch(() => {});
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.logoWrap}>
          <BrandLogo size="lg" />
        </View>

        <View style={styles.card}>
          <View style={styles.iconWrap}>
            <Ionicons name="lock-closed" size={26} color={colors.text} />
          </View>

          <Text style={styles.title}>Invitation only</Text>
          <Text style={styles.sub}>
            Fourbuy dealer accounts are created by a Fourbuy administrator so
            we can verify each dealership before you go live.
          </Text>

          <View style={styles.stepsBox}>
            <View style={styles.step}>
              <Text style={styles.stepIndex}>1</Text>
              <Text style={styles.stepText}>
                Contact your Fourbuy admin (or email us) with your dealership
                name, address, and the users you&apos;d like added.
              </Text>
            </View>
            <View style={styles.step}>
              <Text style={styles.stepIndex}>2</Text>
              <Text style={styles.stepText}>
                We&apos;ll create your dealership and each team member&apos;s
                login, and send you the credentials.
              </Text>
            </View>
            <View style={styles.step}>
              <Text style={styles.stepIndex}>3</Text>
              <Text style={styles.stepText}>
                Sign in on this app and start submitting vehicles for valuation.
              </Text>
            </View>
          </View>

          <TouchableOpacity
            testID="register-email-admin-btn"
            style={styles.primaryBtn}
            onPress={emailFourbuy}
          >
            <Ionicons name="mail-outline" size={16} color="#000" />
            <Text style={styles.primaryBtnText}>Email Fourbuy admin</Text>
          </TouchableOpacity>

          <TouchableOpacity
            testID="register-back-btn"
            style={styles.ghostBtn}
            onPress={() => router.replace("/(auth)/login")}
          >
            <Ionicons name="arrow-back" size={14} color={colors.text} />
            <Text style={styles.ghostBtnText}>Back to sign in</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.footerTag}>{BRAND.tagline}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: {
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    alignItems: "center",
  },
  logoWrap: {
    alignItems: "center",
    marginTop: spacing.xl,
    marginBottom: spacing.lg,
  },
  card: {
    width: "100%",
    maxWidth: 460,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    alignItems: "center",
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  title: {
    color: colors.text,
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: 0.4,
    fontFamily: fonts.heading,
    marginBottom: 6,
  },
  sub: {
    color: colors.textSecondary,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
    marginBottom: spacing.lg,
  },
  stepsBox: {
    width: "100%",
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  step: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
  },
  stepIndex: {
    width: 22,
    height: 22,
    lineHeight: 22,
    borderRadius: 11,
    backgroundColor: colors.primary,
    color: "#000",
    fontWeight: "900",
    textAlign: "center",
    fontFamily: fonts.mono,
    fontSize: 12,
  },
  stepText: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
    lineHeight: 19,
  },
  primaryBtn: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.primary,
    paddingVertical: 14,
    borderRadius: radius.sm,
  },
  primaryBtnText: {
    color: "#000",
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 1,
  },
  ghostBtn: {
    marginTop: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  ghostBtnText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  footerTag: {
    marginTop: spacing.xl,
    color: colors.textSecondary,
    fontSize: 11,
    letterSpacing: 2,
    textTransform: "uppercase",
  },
});
