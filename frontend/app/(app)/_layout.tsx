import { Tabs, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Platform, useWindowDimensions, View } from "react-native";

import { useThemeColors } from "@/src/theme/ThemeContext";
import { useAuth } from "@/src/context/AuthContext";
import WebAdminDashboard from "@/src/components/WebAdminDashboard";
import AgreementModal from "@/src/components/AgreementModal";
import { WalletSuspendBanner } from "@/src/components/billing/WalletCard";

export default function AppLayout() {
  const colors = useThemeColors();
  const { user, logout } = useAuth();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const isDealer = user?.role === "dealer";
  const isAdmin = user?.role === "admin";

  // Wide-screen web admin cockpit
  if (Platform.OS === "web" && isAdmin && width >= 1024) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <WebAdminDashboard
          onLogout={async () => {
            await logout();
            router.replace("/(auth)/login");
          }}
        />
        <AgreementModal />
      </View>
    );
  }

  // Streamlined bottom tab bar — only the three primary destinations  // (My Vehicles, Submit, Profile) live in the bar so it stays uncluttered
  // and thumb-friendly. Everything else (Billing, History, Rewards, Dealers,
  // Kredo, Give Cover, Advertising) is surfaced as flip-tiles on the home
  // screen — see /app/(app)/index.tsx for the tile grid.
  return (
    <View style={{ flex: 1 }}>
      <WalletSuspendBanner />
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.textSecondary,
          tabBarStyle: {
            backgroundColor: colors.paper,
            borderTopColor: colors.border,
            borderTopWidth: 1,
            // Web-specific tab-bar sizing. Expo Router's default
            // tabBarStyle inherits a mobile-first height (~49dp) that
            // doesn't reserve room for the label under the icon in
            // browsers — the "Home / Profile / …" labels + descenders
            // were being clipped at the viewport bottom edge. Enough
            // padding + height so descenders (y / p / g) have room.
            ...(Platform.OS === "web"
              ? { height: 84, paddingTop: 8, paddingBottom: 16 }
              : {}),
          },
          // Don't add extra padding on the individual item on web — it
          // shrinks the inner content area and clipped the labels of
          // every tab except Submit to 1px. The container's own padding
          // above is enough.
          tabBarLabelStyle: {
            fontSize: 11,
            fontWeight: "600",
            // Web: give the label a full 16dp line-height so descenders
            // (the "y" in "My Vehicles" was getting clipped) render in
            // full. `includeFontPadding` is intentionally omitted so
            // RN Web's natural font metrics apply.
            ...(Platform.OS === "web"
              ? { marginTop: 2, marginBottom: 2, lineHeight: 16, minHeight: 16 }
              : {}),
          },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            // Home landing page — first tab so users always have a
            // one-tap route back to the main menu / hero panel.
            title: "Home",
            tabBarIcon: ({ color, size }) => <Ionicons name="home" color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="history"
          options={{
            // Bottom tab now routes dealers/admins straight into the
            // History screen (priced + archived vehicles) instead of the
            // legacy submissions inbox. Requested Nov 2026 — "My Vehicles"
            // was clicking through to submissions.tsx but the dealer
            // actually wanted the fuller history view.
            title: "History",
            tabBarIcon: ({ color, size }) => <Ionicons name="time" color={color} size={size} />,
          }}
        />
        {/* Legacy submissions inbox — hidden from the tab bar but still
            reachable via deep-links (e.g. /submissions/... after a
            push notification) so we don't break any existing routes. */}
        <Tabs.Screen name="submissions" options={{ href: null }} />
        <Tabs.Screen
          name="submit"
          options={{
            title: "Submit",
            // Dealers only — admins don't submit vehicles.
            href: isDealer ? "/submit" : null,
            tabBarIcon: ({ color, size }) => <Ionicons name="add-circle" color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="billing"
          options={{
            // Billing lives in the bottom tab bar (moved out of the
            // home-screen flip-tiles Nov 2026). Kept visible for both
            // dealers and admins so it's always one tap away.
            title: "Billing",
            tabBarIcon: ({ color, size }) => <Ionicons name="cash-outline" color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="profile"
          options={{
            title: "Profile",
            tabBarIcon: ({ color, size }) => <Ionicons name="person-circle" color={color} size={size} />,
          }}
        />
        {/* All secondary destinations are hidden from the tab bar and
            reachable via the home-page tiles or their deep-links. */}
        <Tabs.Screen name="dealers" options={{ href: null }} />
        <Tabs.Screen name="rewards" options={{ href: null }} />
        <Tabs.Screen name="deal-outcomes" options={{ href: null }} />
        <Tabs.Screen name="vehicle/[id]" options={{ href: null }} />
        <Tabs.Screen name="scan" options={{ href: null }} />
        <Tabs.Screen name="cover" options={{ href: null }} />
        <Tabs.Screen name="cover/[id]" options={{ href: null }} />
        <Tabs.Screen name="kredo-test" options={{ href: null }} />
        <Tabs.Screen name="suppliers" options={{ href: null }} />
        <Tabs.Screen name="stock" options={{ href: null }} />
        <Tabs.Screen name="vin-reports/index" options={{ href: null }} />
        <Tabs.Screen name="vin-reports/new" options={{ href: null }} />
        <Tabs.Screen name="partner-api" options={{ href: null }} />
      </Tabs>
      <AgreementModal />
    </View>
  );
}
