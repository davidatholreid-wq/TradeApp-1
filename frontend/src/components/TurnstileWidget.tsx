/**
 * Cloudflare Turnstile widget — web-only.
 *
 * This portal is a mobile-web funnel; on native (Expo Go / built app) we
 * render a soft-fail notice pointing the user at the web URL, because
 * Turnstile has no supported native SDK (a WebView-based bridge is out
 * of scope for the MVP).
 *
 * Usage:
 *   <TurnstileWidget
 *     siteKey={process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY}
 *     action="public_valuation"
 *     onVerify={(token) => setToken(token)}
 *     onExpire={() => setToken(null)}
 *   />
 */
import { useEffect, useRef, useCallback } from "react";
import { Platform, View, Text, StyleSheet } from "react-native";

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: any) => string;
      remove: (id: string) => void;
      reset: (id?: string) => void;
    };
    __fbTurnstileCbCounter?: number;
  }
}

const SCRIPT_ID = "cf-turnstile-script";
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";

function ensureScriptLoaded(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined") return reject(new Error("no dom"));
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      if ((existing as any)._loaded) return resolve();
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("script error")));
      return;
    }
    const s = document.createElement("script");
    s.id = SCRIPT_ID;
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.addEventListener("load", () => {
      (s as any)._loaded = true;
      resolve();
    });
    s.addEventListener("error", () => reject(new Error("script error")));
    document.head.appendChild(s);
  });
}

type Props = {
  siteKey: string;
  action?: string;
  theme?: "light" | "dark" | "auto";
  onVerify: (token: string) => void;
  onExpire?: () => void;
  onError?: (err?: string) => void;
};

export default function TurnstileWidget({
  siteKey,
  action = "public_valuation",
  theme = "light",
  onVerify,
  onExpire,
  onError,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);

  const setContainer = useCallback((node: any) => {
    containerRef.current = node as HTMLDivElement | null;
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    let cancelled = false;
    (async () => {
      try {
        await ensureScriptLoaded();
      } catch {
        if (!cancelled) onError?.("Anti-abuse widget failed to load");
        return;
      }
      // Wait a tick — the api.js exposes window.turnstile after eval.
      const waitStart = Date.now();
      while (!window.turnstile && Date.now() - waitStart < 5000) {
        await new Promise((r) => setTimeout(r, 60));
      }
      if (cancelled || !window.turnstile || !containerRef.current) return;
      try {
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action,
          theme,
          callback: (token: string) => onVerify(token),
          "expired-callback": () => onExpire?.(),
          "error-callback": (err: any) => onError?.(String(err || "turnstile error")),
        });
      } catch (e: any) {
        onError?.(e?.message || "turnstile render failed");
      }
    })();
    return () => {
      cancelled = true;
      try {
        if (widgetIdRef.current && window.turnstile?.remove) {
          window.turnstile.remove(widgetIdRef.current);
        }
      } catch {}
      widgetIdRef.current = null;
    };
    // We intentionally re-run only when the key/action change — callbacks
    // are captured by closure inside render() and shouldn't retrigger
    // re-init on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, action, theme]);

  if (Platform.OS !== "web") {
    return (
      <View style={styles.nativeFallback}>
        <Text style={styles.nativeText}>
          For anti-abuse reasons, this form must be completed in a web browser.
          Please open the link on your phone{"\u2019"}s browser to continue.
        </Text>
      </View>
    );
  }

  // React Native Web treats a bare <View> as a <div>. To make the
  // Turnstile script happy we need a real DOM node reference — react-dom
  // gives us that via `ref` on a View which forwards to the underlying
  // div. We use a nested JSX pass-through div for maximum compatibility.
  return (
    // @ts-ignore — DOM-only prop path is fine on web
    <div ref={setContainer as any} style={{ display: "inline-block", minHeight: 65 }} />
  );
}

const styles = StyleSheet.create({
  nativeFallback: {
    padding: 12,
    borderRadius: 8,
    backgroundColor: "#FFF8E1",
    borderColor: "#F0C33C",
    borderWidth: 1,
  },
  nativeText: {
    fontSize: 13,
    color: "#5D4300",
    lineHeight: 18,
  },
});
