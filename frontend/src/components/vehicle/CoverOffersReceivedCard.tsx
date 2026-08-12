// -----------------------------------------------------------------------------
// CoverOffersReceivedCard — collapsible list of binding cover offers
// placed on this submission by pricing agents. Visible to the owning
// dealer + admins only (backend returns [] to everyone else).
//
// Extracted from `/app/frontend/app/(app)/vehicle/[id].tsx` during the
// P3 modularization pass — Round C (Aug 2026).
// -----------------------------------------------------------------------------
import React from "react";
import { View, Text, Image, Platform } from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import type { Submission } from "@/src/types/vehicle";

export type CoverOffer = {
  id: string;
  price_zar: number;
  note?: string | null;
  status?: string;
  created_at: string;
  agent_name?: string | null;
  agent_phone?: string | null;
  agent_dealership_name?: string | null;
  agent_profile_pic?: string | null;
  binding_caveat?: string | null;
};

export type CoverOffersReceivedCardProps = {
  sub: Submission;
  coverOffers: CoverOffer[];
  isCoverMode: boolean;
  open: boolean;
  onToggle: () => void;
  colors: any;
  styles: any;
};

export function CoverOffersReceivedCard({
  sub,
  coverOffers,
  isCoverMode,
  open,
  onToggle,
  colors,
  styles,
}: CoverOffersReceivedCardProps) {
  if (!(coverOffers.length > 0 && !isCoverMode)) return null;

  return (
    <View style={styles.coverOffersBox} testID="cover-offers-received">
      <TouchableOpacity
        testID="cover-offers-toggle"
        style={styles.coverOffersHeader}
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={open ? "Collapse cover offers" : "Expand cover offers"}
      >
        <Ionicons name="shield-checkmark" size={18} color={colors.primary} />
        <View style={{ flex: 1 }}>
          <Text style={styles.coverOffersTitle}>
            Cover Offers Received ({coverOffers.length})
          </Text>
          {!open && coverOffers[0] ? (
            <Text style={styles.coverOffersPeek} numberOfLines={1}>
              Top: <Text style={{ color: colors.text, fontWeight: "800" }}>
                R{coverOffers[0].price_zar.toLocaleString()}
              </Text>
              {coverOffers[0].agent_name ? ` · ${coverOffers[0].agent_name}` : ""}
              {coverOffers[0].agent_dealership_name
                ? ` · ${coverOffers[0].agent_dealership_name}`
                : ""}
            </Text>
          ) : null}
        </View>
        <Ionicons
          name={open ? "chevron-up" : "chevron-down"}
          size={18}
          color={colors.textSecondary}
        />
      </TouchableOpacity>
      {open ? (
        <>
          <Text style={styles.coverOffersSub}>
            Binding Cover from Registered Dealer · subject to physical inspection.
          </Text>
          {coverOffers.map((c, idx) => {
            const phoneDigits = (c.agent_phone || "").replace(/[^0-9]/g, "");
            const waNumber =
              phoneDigits.startsWith("27")
                ? phoneDigits
                : phoneDigits.startsWith("0")
                  ? "27" + phoneDigits.slice(1)
                  : phoneDigits;
            const waMessage = encodeURIComponent(
              `Hi ${c.agent_name || "there"}, this is regarding your cover of R${c.price_zar.toLocaleString()} on ${sub.reference || "our vehicle"} (${[sub.make_name, sub.derivative_name || sub.model_name].filter(Boolean).join(" ")}).`,
            );
            const waUrl = waNumber ? `https://wa.me/${waNumber}?text=${waMessage}` : null;
            return (
              <View
                key={c.id}
                style={[
                  styles.coverOfferRow,
                  idx === coverOffers.length - 1 && { borderBottomWidth: 0 },
                ]}
                testID={`cover-offer-${c.id}`}
              >
                {c.agent_profile_pic ? (
                  <Image
                    source={{ uri: c.agent_profile_pic }}
                    style={styles.coverOfferAvatar}
                    resizeMode="cover"
                  />
                ) : (
                  <View style={styles.coverOfferAvatarFallback}>
                    <Text style={styles.coverOfferAvatarInitial}>
                      {(c.agent_name || "?").trim().charAt(0).toUpperCase()}
                    </Text>
                  </View>
                )}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.coverOfferPrice}>
                    R{c.price_zar.toLocaleString()}
                  </Text>
                  <Text style={styles.coverOfferAgent} numberOfLines={1}>
                    {c.agent_name || "Pricing agent"}
                    {c.agent_dealership_name ? ` · ${c.agent_dealership_name}` : ""}
                  </Text>
                  <Text style={styles.coverOfferDate}>
                    {new Date(c.created_at).toLocaleString()}
                  </Text>
                  {c.note ? (
                    <Text style={styles.coverOfferNote}>{c.note}</Text>
                  ) : null}
                </View>
                {waUrl ? (
                  <TouchableOpacity
                    testID={`cover-offer-whatsapp-${c.id}`}
                    style={styles.whatsappBtn}
                    onPress={() => {
                      if (Platform.OS === "web") {
                        (globalThis as any).window?.open?.(waUrl, "_blank");
                      } else {
                        Linking.openURL(waUrl).catch(() => { });
                      }
                    }}
                  >
                    <Ionicons name="logo-whatsapp" size={18} color="#fff" />
                    <Text style={styles.whatsappBtnText}>WhatsApp</Text>
                  </TouchableOpacity>
                ) : c.agent_phone ? (
                  <Text style={styles.coverOfferPhone}>{c.agent_phone}</Text>
                ) : null}
              </View>
            );
          })}
          <View style={styles.coverOffersDisclaimer} testID="cover-offers-disclaimer">
            <Ionicons
              name="information-circle"
              size={14}
              color={colors.textSecondary}
              style={{ marginTop: 1 }}
            />
            <Text style={styles.coverOffersDisclaimerText}>
              All Cover Prices are subject to a physical inspection of the vehicle to ensure the vehicle is as per the valuation — please always confirm the cover with the dealer prior to going ahead with the deal.
            </Text>
          </View>
        </>
      ) : null}
    </View>
  );
}

export default CoverOffersReceivedCard;
