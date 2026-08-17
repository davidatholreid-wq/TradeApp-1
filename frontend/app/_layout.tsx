import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { Alert, LogBox, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Linking from "expo-linking";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";
import { AuthProvider, useAuth } from "@/src/context/AuthContext";
import { ThemeProvider, useTheme } from "@/src/theme/ThemeContext";

LogBox.ignoreAllLogs(true);

SplashScreen.preventAutoHideAsync();

// -----------------------------------------------------------------------------
// Web safety net: swallow @expo/vector-icons -> expo-font -> fontfaceobserver
// 6000ms timeout rejections. These fire when Metro's dev server (or the icon
// CDN) is momentarily slow to serve a .ttf file. The failure is transient and
// self-heals (icons render as boxes for a beat, then swap in once the font
// arrives), but the raw promise rejection surfaces in the RN Web error overlay
// as "Uncaught Error: 6000ms timeout exceeded" which looks like a crash to
// the user. Filter those specific rejections out so real errors still bubble.
// -----------------------------------------------------------------------------
if (Platform.OS === "web" && typeof window !== "undefined") {
  const looksLikeFontTimeout = (payload: unknown): boolean => {
    if (!payload) return false;
    const anyP = payload as any;
    const msg =
      (typeof payload === "string" ? payload : anyP?.message) ||
      String(payload);
    const stack: string = anyP?.stack || "";
    return (
      typeof msg === "string" &&
      (msg.includes("ms timeout exceeded") ||
        stack.includes("fontfaceobserver"))
    );
  };
  window.addEventListener("unhandledrejection", (event) => {
    if (looksLikeFontTimeout((event as any).reason)) {
      event.preventDefault();
      (event as any).stopImmediatePropagation?.();
    }
  });
  window.addEventListener("error", (event) => {
    if (
      looksLikeFontTimeout((event as any).error) ||
      looksLikeFontTimeout((event as any).message)
    ) {
      event.preventDefault();
      (event as any).stopImmediatePropagation?.();
    }
  });
  // Expo Dev Client's red-box overlay hooks into React Native's global
  // ErrorUtils.reportError / reportFatalError. Wrap those so the same
  // font-timeout swallow rule applies before the overlay ever renders.
  const eu: any = (globalThis as any).ErrorUtils;
  if (eu && typeof eu.setGlobalHandler === "function") {
    const prevHandler = eu.getGlobalHandler ? eu.getGlobalHandler() : null;
    eu.setGlobalHandler((error: any, isFatal?: boolean) => {
      if (looksLikeFontTimeout(error)) return;
      if (typeof prevHandler === "function") prevHandler(error, isFatal);
      else if (isFatal) throw error;
    });
  }
}

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
  const { colors } = useTheme();

  useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === "(auth)";
    const inAppGroup = segments[0] === "(app)";
    // Public, unauthenticated routes that are always accessible.
    const PUBLIC_ROUTES = new Set(["get-valuation", "valuation-success", "kredo-api"]);
    const inPublic = PUBLIC_ROUTES.has(segments[0] || "");
    if (inPublic) return; // never bounce a public visitor
    if (!user && !inAuthGroup) {
      router.replace("/(auth)/login");
    } else if (user && !inAppGroup) {
      // Covers both /(auth)/* AND the bare root "/" splash landing
      router.replace("/(app)");
    }
  }, [user, loading, segments, router]);

  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />;
}

function ThemedStatusBar() {
  const { mode } = useTheme();
  return <StatusBar style={mode === "dark" ? "light" : "dark"} />;
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

    // Denied-permission weekly nudge — when the user has denied push
    // permission and can no longer be re-prompted (`canAskAgain === false`),
    // once per week show a dialog with an "Open Settings" CTA that deep-
    // links to the OS settings so they can flip the toggle back on.
    (async () => {
      try {
        const { status, canAskAgain } = await Notifications.getPermissionsAsync();
        if (status !== "denied" || canAskAgain) return;
        const lastNudge = await AsyncStorage.getItem("pushNudgeAt");
        const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
        if (lastNudge && Date.now() - Number(lastNudge) <= oneWeekMs) return;
        Alert.alert(
          "Enable notifications",
          "Turn on push notifications to get instant alerts when your vehicles are priced and when Cover offers land — you can pick which types in Profile.",
          [
            {
              text: "Later",
              style: "cancel",
              onPress: () => {
                AsyncStorage.setItem("pushNudgeAt", String(Date.now())).catch(() => {});
              },
            },
            {
              text: "Open Settings",
              onPress: () => {
                AsyncStorage.setItem("pushNudgeAt", String(Date.now())).catch(() => {});
                Linking.openSettings().catch(() => {});
              },
            },
          ],
        );
      } catch {
        /* non-fatal */
      }
    })();

    return () => {
      tapSub.remove();
    };
  }, [router]);

  // Do NOT block the whole tree on font loading — on slow networks the CDN
  // icon fonts can take 20+ seconds. Render the app immediately; icons will
  // fall back to Unicode boxes until the ttf files arrive, then re-render.
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          <ThemeProvider>
            <ThemedStatusBar />
            <AuthProvider>
              <RootNavigation />
            </AuthProvider>
          </ThemeProvider>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
