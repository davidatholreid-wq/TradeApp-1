/**
 * Kredo (partner) API — public docs page.
 *
 * Deliberately kept as a single self-contained screen using plain
 * React Native primitives so it renders identically on the web preview
 * *and* if we later choose to expose it inside the mobile app.
 *
 * The page is intentionally NOT gated — anyone with the URL can view
 * it (that's the point of API docs). No sensitive data appears.
 */
import { View, Text, ScrollView, StyleSheet, Platform } from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { spacing, radius } from "@/src/theme";

export default function PartnerApiDocsScreen() {
  const colors = useThemeColors();
  const s = makeStyles(colors);
  const openPdf = () => {
    // Docs PDF is public — safe to open directly. Uses expo-router-
    // friendly URL so it works on both web preview and the deployed
    // production domain.
    const url = `${process.env.EXPO_PUBLIC_BACKEND_URL || ""}/api/partner-api/docs.pdf`;
    if (Platform.OS === "web") {
      window.open(url, "_blank");
    } else {
      // Native — hand off to system browser via Linking would be ideal,
      // but the docs page is web-only in practice.
      window.open?.(url);
    }
  };
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={["top"]}>
      <ScrollView contentContainerStyle={{ padding: spacing.md, paddingBottom: 96 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Fourbuy VIN Data API</Text>
            <Text style={s.subtitle}>
              Whitelabel VIN factory-options decode service. Base URL:
              {"\n"}
              <Text style={s.mono}>https://api.fourbuy.co.za/api/partner/v1</Text>
            </Text>
          </View>
          <TouchableOpacity style={s.pdfBtn} onPress={openPdf} activeOpacity={0.85}>
            <Ionicons name="download-outline" size={16} color={colors.onPrimary} />
            <Text style={s.pdfBtnTxt}>Download PDF</Text>
          </TouchableOpacity>
        </View>

        {/* Auth */}
        <Text style={s.h2}>Authentication</Text>
        <Text style={s.p}>
          Every request must include your API key in an{" "}
          <Text style={s.mono}>Authorization</Text> header using the
          Bearer scheme:
        </Text>
        <View style={s.code}>
          <Text style={s.codeText}>Authorization: Bearer fbp_XXXXXXXXXXXX</Text>
        </View>
        <Text style={s.p}>
          Keys are provisioned per client. Contact your Fourbuy account
          manager to receive one. Keep it server-side — never embed in a
          browser or mobile app.
        </Text>

        {/* Health */}
        <Text style={s.h2}>Health check</Text>
        <View style={s.code}>
          <Text style={s.codeText}>GET /api/partner/v1/health</Text>
        </View>
        <Text style={s.p}>Returns 200 OK if the service is available. No auth required.</Text>
        <View style={s.code}>
          <Text style={s.codeText}>{`{
  "ok": true,
  "service": "Fourbuy VIN Data API",
  "version": "1.0"
}`}</Text>
        </View>

        {/* VIN lookup */}
        <Text style={s.h2}>VIN Lookup</Text>
        <View style={s.code}>
          <Text style={s.codeText}>GET /api/partner/v1/vin-lookup/{`{vin}`}</Text>
        </View>
        <Text style={s.p}>
          Returns factory-options data (OEM datacard) for the supplied VIN.
          Successful calls are billed to your account at your contracted
          per-lookup rate. Failed calls (404 / 502 / 500) are NOT billed.
        </Text>

        <Text style={s.h3}>Example</Text>
        <View style={s.code}>
          <Text style={s.codeText}>{`curl -H "Authorization: Bearer $FOURBUY_API_KEY" \\
  https://api.fourbuy.co.za/api/partner/v1/vin-lookup/WVGZZZ5NZJW402485`}</Text>
        </View>

        <Text style={s.h3}>Response 200 OK</Text>
        <View style={s.code}>
          <Text style={s.codeText}>{`{
  "vin": "WVGZZZ5NZJW402485",
  "data": {
    "model": "Touareg III",
    "series": "CR7",
    "build_date": "2018-04-11",
    "colour_code": "LB7W",
    "options": [
      { "code": "0YR", "description": "Panoramic sunroof" },
      { "code": "8IU", "description": "LED Matrix headlights" },
      ...
    ]
  },
  "source": "Fourbuy VIN Data API",
  "cached": false,
  "call_id": "6a30…"
}`}</Text>
        </View>

        <Text style={s.h3}>Response codes</Text>
        <View style={s.tbl}>
          {[
            ["200 OK", "Data returned. Call is billed."],
            ["400 Bad Request", "VIN missing or malformed (must be 11–25 chars)."],
            ["401 Unauthorized", "Missing / invalid / revoked API key."],
            ["403 Forbidden", "IP address not on the client's allowlist."],
            ["404 Not Found", "No factory data available for this VIN. Not billed."],
            ["429 Too Many Requests", "Upstream rate limit. Not billed."],
            ["500 Internal Error", "Fourbuy-side error. Not billed."],
            ["502 Bad Gateway", "Upstream vendor error. Not billed."],
          ].map(([code, desc], i) => (
            <View key={i} style={s.tblRow}>
              <Text style={[s.mono, { width: 140 }]}>{code}</Text>
              <Text style={[s.p, { flex: 1, marginBottom: 0 }]}>{desc}</Text>
            </View>
          ))}
        </View>

        {/* Usage */}
        <Text style={s.h2}>Usage summary</Text>
        <View style={s.code}>
          <Text style={s.codeText}>GET /api/partner/v1/usage/current-month</Text>
        </View>
        <Text style={s.p}>
          Returns your calling account's usage in the current calendar
          month so you can reconcile against your invoice.
        </Text>
        <View style={s.code}>
          <Text style={s.codeText}>{`{
  "client": "Kredo",
  "month": "2026-11",
  "cost_zar_per_lookup": 10,
  "successful_lookups": 1240,
  "failed_lookups": 17,
  "amount_zar": 12400
}`}</Text>
        </View>

        {/* Caching */}
        <Text style={s.h2}>Caching</Text>
        <Text style={s.p}>
          Every VIN lookup is cached forever on our side (factory build
          data does not change for a given VIN). Repeat lookups for the
          same VIN return the same payload with{" "}
          <Text style={s.mono}>"cached": true</Text> and are still billed —
          this is the value of the reseller service.
        </Text>

        {/* Rate limits */}
        <Text style={s.h2}>Rate limits</Text>
        <Text style={s.p}>
          Currently: 30 requests / minute per API key. Contact your account
          manager if you need higher throughput. Bursts above the limit
          receive HTTP 429 and are not billed.
        </Text>

        {/* Billing */}
        <Text style={s.h2}>Billing</Text>
        <Text style={s.p}>
          Post-paid, invoiced monthly. Only successful lookups (HTTP 200)
          are counted; all failure responses are free of charge.
        </Text>

        {/* Support */}
        <Text style={s.h2}>Support</Text>
        <Text style={s.p}>
          <Text style={{ fontWeight: "800", color: colors.text }}>David Reid</Text> — WhatsApp only:{" "}
          <Text style={s.mono}>+27 84 881 9073</Text>
        </Text>
        <Text style={s.p}>
          Contact for API keys, IP allowlist changes, rate-limit increases, and monthly reconciliation.
        </Text>

        <Text style={[s.p, { marginTop: spacing.lg, color: colors.textSecondary, textAlign: "center" }]}>
          © TRADE AI powered by FOURBUY · Fourbuy VIN Data API v1.0
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: -0.5,
    marginBottom: 4,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 21,
    marginBottom: spacing.lg,
  },
  h2: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "800",
    marginTop: spacing.lg,
    marginBottom: 6,
    letterSpacing: -0.2,
  },
  h3: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "800",
    marginTop: spacing.md,
    marginBottom: 6,
    letterSpacing: 0.2,
    textTransform: "uppercase" as const,
  },
  p: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 6,
  },
  mono: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 12,
    color: colors.primary,
  },
  code: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 12,
    marginVertical: 8,
  },
  codeText: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 12,
    color: colors.text,
    lineHeight: 18,
  },
  tbl: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    overflow: "hidden" as const,
    marginVertical: 8,
  },
  tblRow: {
    flexDirection: "row",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 12,
  },
  pdfBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radius.md,
  },
  pdfBtnTxt: {
    color: colors.onPrimary,
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
});
