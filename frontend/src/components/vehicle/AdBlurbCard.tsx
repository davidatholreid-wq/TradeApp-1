/**
 * AdBlurbCard — Feb 2027.
 *
 * Sits below the Vehicle Insights card on the vehicle detail screen.
 * Dealer taps "Write advert" → we call `POST /api/submissions/{id}/ad-blurb`
 * which asks GPT-5.2 to produce three ready-to-copy blurbs:
 *   • Facebook Marketplace
 *   • AutoTrader Listing
 *   • WhatsApp Broadcast
 *
 * The result is cached on the submission so revisiting the screen
 * doesn't re-bill LLM usage. A "Regenerate" button forces a refresh.
 */
import React, { useState } from "react";
import {
  View,
  Text,
  ActivityIndicator,
  Platform,
  Alert,
  Share,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import CollapsibleSection from "@/src/components/vehicle/CollapsibleSection";

export type AdBlurbPayload = {
  headline?: string;
  highlights?: string[];
  facebook?: string;
  autotrader?: string;
  whatsapp?: string;
  generated_at?: string;
  model?: string;
};

export type AdBlurbCardProps = {
  blurb: AdBlurbPayload | null | undefined;
  loading: boolean;
  onFetch: (refresh?: boolean) => void;
  colors: any;
  styles: any;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
};

type Channel = "facebook" | "autotrader" | "whatsapp";

const CHANNEL_META: Record<Channel, { label: string; icon: keyof typeof Ionicons.glyphMap; tint: string }> = {
  facebook:   { label: "Facebook",   icon: "logo-facebook", tint: "#1877F2" },
  autotrader: { label: "AutoTrader", icon: "car-sport",     tint: "#DC2626" },
  whatsapp:   { label: "WhatsApp",   icon: "logo-whatsapp", tint: "#25D366" },
};

export default function AdBlurbCard({
  blurb,
  loading,
  onFetch,
  colors,
  styles,
  collapsed = false,
  onToggleCollapsed,
}: AdBlurbCardProps) {
  const [active, setActive] = useState<Channel>("facebook");
  const hasData = !!(blurb && (blurb.facebook || blurb.autotrader || blurb.whatsapp));
  const activeText = (blurb?.[active] || "").trim();
  const [justCopied, setJustCopied] = useState(false);

  const rightSlot = (
    <TouchableOpacity
      testID="ad-blurb-button"
      style={[styles.analysisBtn, loading && { opacity: 0.6 }]}
      onPress={() => onFetch(hasData)}
      disabled={loading}
      accessibilityLabel={hasData ? "Regenerate advert copy" : "Write an advert for this vehicle"}
    >
      {loading ? (
        <ActivityIndicator size="small" color={colors.text} />
      ) : (
        <>
          <Ionicons name="megaphone-outline" size={14} color={colors.text} />
          <Text style={styles.analysisBtnText}>
            {hasData ? "Regenerate" : "Write advert"}
          </Text>
        </>
      )}
    </TouchableOpacity>
  );

  const summary = blurb?.generated_at
    ? `Generated ${new Date(blurb.generated_at).toLocaleString()}`
    : "AI-written marketing copy for Facebook, AutoTrader & WhatsApp";

  const handleCopy = async () => {
    if (!activeText) return;
    try {
      await Clipboard.setStringAsync(activeText);
      setJustCopied(true);
      setTimeout(() => setJustCopied(false), 1800);
    } catch (e: any) {
      Alert.alert("Copy failed", e?.message || "Please try again.");
    }
  };

  const handleShare = async () => {
    if (!activeText) return;
    try {
      if (Platform.OS === "web") {
        // Web: fall back to copy — Share API is unreliable in browsers.
        await handleCopy();
        return;
      }
      await Share.share({ message: activeText });
    } catch {
      // User cancelled — no toast.
    }
  };

  return (
    <CollapsibleSection
      testID="ad-blurb-section"
      title="Advertising Blurb"
      summary={summary}
      right={rightSlot}
      open={!collapsed}
      onToggle={() => onToggleCollapsed?.()}
      colors={colors}
      styles={styles}
    >
      {hasData ? (
        <View style={{ gap: 12 }}>
          {/* Headline + highlights preview */}
          {blurb?.headline ? (
            <View
              style={{
                backgroundColor: colors.card,
                borderWidth: 1,
                borderColor: colors.borderLight,
                borderRadius: 10,
                padding: 12,
              }}
            >
              <Text
                style={{
                  color: colors.text,
                  fontSize: 15,
                  fontWeight: "800",
                  letterSpacing: 0.1,
                }}
              >
                {blurb.headline}
              </Text>
              {Array.isArray(blurb.highlights) && blurb.highlights.length > 0 ? (
                <View style={{ marginTop: 8, gap: 4 }}>
                  {blurb.highlights.slice(0, 6).map((h, i) => (
                    <View key={`hl-${i}`} style={{ flexDirection: "row", gap: 6 }}>
                      <Ionicons name="sparkles-outline" size={12} color={colors.primary} style={{ marginTop: 2 }} />
                      <Text style={{ color: colors.text, fontSize: 12, flex: 1, lineHeight: 16 }}>
                        {h}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}

          {/* Channel tabs */}
          <View
            style={{
              flexDirection: "row",
              gap: 6,
              flexWrap: "wrap",
            }}
          >
            {(Object.keys(CHANNEL_META) as Channel[]).map((c) => {
              const meta = CHANNEL_META[c];
              const isActive = active === c;
              return (
                <TouchableOpacity
                  key={c}
                  testID={`ad-blurb-tab-${c}`}
                  onPress={() => setActive(c)}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    paddingHorizontal: 10,
                    paddingVertical: 7,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: isActive ? meta.tint : colors.borderLight,
                    backgroundColor: isActive ? meta.tint + "22" : colors.card,
                  }}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: isActive }}
                >
                  <Ionicons name={meta.icon} size={13} color={meta.tint} />
                  <Text
                    style={{
                      color: isActive ? meta.tint : colors.text,
                      fontSize: 12,
                      fontWeight: isActive ? "800" : "600",
                    }}
                  >
                    {meta.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Selected blurb body */}
          <View
            style={{
              backgroundColor: colors.card,
              borderWidth: 1,
              borderColor: colors.borderLight,
              borderRadius: 10,
              padding: 12,
            }}
          >
            <Text
              testID="ad-blurb-text"
              style={{ color: colors.text, fontSize: 13, lineHeight: 20 }}
              selectable
            >
              {activeText || "No copy generated for this channel yet."}
            </Text>
          </View>

          {/* Actions */}
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <TouchableOpacity
              testID="ad-blurb-copy"
              onPress={handleCopy}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: 14,
                paddingVertical: 10,
                borderRadius: 8,
                backgroundColor: justCopied ? "#16A34A" : colors.primary,
              }}
            >
              <Ionicons
                name={justCopied ? "checkmark" : "copy-outline"}
                size={14}
                color={colors.onPrimary}
              />
              <Text style={{ color: colors.onPrimary, fontSize: 12, fontWeight: "800", letterSpacing: 0.3 }}>
                {justCopied ? "Copied" : "Copy"}
              </Text>
            </TouchableOpacity>
            {Platform.OS !== "web" ? (
              <TouchableOpacity
                testID="ad-blurb-share"
                onPress={handleShare}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: colors.borderLight,
                  backgroundColor: colors.card,
                }}
              >
                <Ionicons name="share-social-outline" size={14} color={colors.text} />
                <Text style={{ color: colors.text, fontSize: 12, fontWeight: "700" }}>Share</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          <Text style={{ color: colors.textSecondary, fontSize: 10, fontStyle: "italic" }}>
            AI-generated. Review before posting — verify pricing, options and any factual claims.
          </Text>
        </View>
      ) : (
        <View style={styles.analysisEmpty}>
          <Ionicons name="megaphone-outline" size={20} color={colors.textSecondary} />
          <Text style={styles.analysisEmptyText}>
            Tap Write advert to generate ready-to-copy marketing blurbs for
            Facebook Marketplace, AutoTrader and WhatsApp — tuned to this
            vehicle&apos;s spec, options and warranty status.
          </Text>
        </View>
      )}
    </CollapsibleSection>
  );
}
