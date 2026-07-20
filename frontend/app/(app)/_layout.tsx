import { Tabs, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Platform, useWindowDimensions, View } from "react-native";
import { colors } from "@/src/theme";
import { useAuth } from "@/src/context/AuthContext";
import WebAdminDashboard from "@/src/components/WebAdminDashboard";
import AgreementModal from "@/src/components/AgreementModal";

export default function AppLayout() {
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

  return (
    <View style={{ flex: 1 }}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.textSecondary,
          tabBarStyle: {
            backgroundColor: colors.paper,
            borderTopColor: colors.border,
            borderTopWidth: 1,
          },
          tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: isAdmin ? "Submissions" : "My Vehicles",
            tabBarIcon: ({ color, size }) => <Ionicons name="list" color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="submit"
          options={{
            title: "Submit",
            href: isDealer ? "/submit" : null,
            tabBarIcon: ({ color, size }) => <Ionicons name="add-circle" color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="dealers"
          options={{
            title: "Dealers",
            href: isAdmin ? "/dealers" : null,
            tabBarIcon: ({ color, size }) => <Ionicons name="people" color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="billing"
          options={{
            title: "Billing",
            // Billing is available to everyone now — dealers see their own
            // monthly summary, admins see the aggregate across all dealers.
            tabBarIcon: ({ color, size }) => <Ionicons name="cash" color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="history"
          options={{
            title: "History",
            tabBarIcon: ({ color, size }) => <Ionicons name="time" color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="rewards"
          options={{
            title: "Rewards",
            // Dealers earn 1 point per billable valuation; admins view the
            // fulfillment queue from the web dashboard, not this tab.
            href: isDealer ? "/rewards" : null,
            tabBarIcon: ({ color, size }) => <Ionicons name="gift" color={color} size={size} />,
          }}
        />
        <Tabs.Screen
          name="profile"
          options={{
            title: "Profile",
            tabBarIcon: ({ color, size }) => <Ionicons name="person-circle" color={color} size={size} />,
          }}
        />
        <Tabs.Screen name="vehicle/[id]" options={{ href: null }} />
        <Tabs.Screen name="scan" options={{ href: null }} />
        <Tabs.Screen name="kredo-test" options={{ href: null }} />
      </Tabs>
      <AgreementModal />
    </View>
  );
}
