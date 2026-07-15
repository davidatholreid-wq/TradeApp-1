import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { LogBox, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Linking from "expo-linking";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";
import { AuthProvider, useAuth } from "@/src/context/AuthContext";

LogBox.ignoreAllLogs(true);

SplashScreen.preventAutoHideAsync();

// Push notification: foreground handler (module scope)
if (Platform.OS !== "web") {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

// Android channel (module scope)
if (Platform.OS === "android") {
  Notifications.setNotificationChannelAsync("default", {
    name: "Default",
    importance: Notifications.AndroidImportance.MAX,
    sound: "default",
  });
}

function RootNavigation() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === "(auth)";
    const inAppGroup = segments[0] === "(app)";
    if (!user && !inAuthGroup) {
      router.replace("/(auth)/login");
    } else if (user && !inAppGroup) {
      // Covers both /(auth)/* AND the bare root "/" splash landing
      router.replace("/(app)");
    }
  }, [user, loading, segments, router]);

  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#050505" } }} />;
}

export default function RootLayout() {
  const [loaded, error] = useIconFonts();
  const router = useRouter();

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync();
    }
  }, [loaded, error]);

  // Safety net: on slow connections icon fonts can take 20+ seconds to arrive
  // from jsdelivr on Expo Go. Force-hide splash after 2.5s so users see the
  // app immediately; icons will fade in when the fonts finish loading.
  useEffect(() => {
    const t = setTimeout(() => {
      SplashScreen.hideAsync().catch(() => {});
    }, 2500);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (Platform.OS === "web") return;
    const tapSub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = (response.notification.request.content.data as any) || {};
      const url = data.deeplink || data.action_url;
      if (!url) return;
      if (typeof url === "string" && url.startsWith("http")) {
        Linking.openURL(url);
      } else {
        router.push(url as any);
      }
    });

    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (!response) return;
      const data = (response.notification.request.content.data as any) || {};
      const url = data.deeplink || data.action_url;
      if (url) {
        if (typeof url === "string" && url.startsWith("http")) {
          Linking.openURL(url);
        } else {
          router.push(url as any);
        }
      }
    });

    return () => {
      tapSub.remove();
    };
  }, [router]);

  // Do NOT block the whole tree on font loading — on slow networks the CDN
  // icon fonts can take 20+ seconds. Render the app immediately; icons will
  // fall back to Unicode boxes until the ttf files arrive, then re-render.
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <AuthProvider>
        <RootNavigation />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
