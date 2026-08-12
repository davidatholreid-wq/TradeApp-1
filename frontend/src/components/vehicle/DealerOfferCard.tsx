// -----------------------------------------------------------------------------
// DealerOfferCard — the owning dealer's "My Offer" panel.
//
// Standalone card visible to every user on the owning dealership (and
// admins). Only managerial (`is_pricing_agent`) users can enter/update.
// Once an offer is captured, the parent unlocks Deal Tracking below.
//
// Extracted from `/app/frontend/app/(app)/vehicle/[id].tsx` during the
// P3 modularization pass — Round C (Aug 2026).
// -----------------------------------------------------------------------------
import React from "react";
import { View, Text, TextInput, ActivityIndicator } from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import type { DealInfo } from "@/src/types/vehicle";

export type DealerOfferHistoryEntry = {
  price_zar: number;
  at: string;
  by_name?: string;
};

export type DealerOfferCardProps = {
  deal: DealInfo | null | undefined;
  isAdmin: boolean;
  canEditOffer: boolean;
  dealOfferInput: string;
  onOfferInputChange: (raw: string) => void;
  dealSaving: boolean;
  onSaveOffer: (parsed: number | null) => void;
  parseMoneyInput: (raw: string) => number | null;
  formatMoneyString: (raw: string) => string;
  fmtZar: (v: number | null | undefined) => string;
  dealerOfferHistoryOpen: boolean;
  onToggleHistory: () => void;
  colors: any;
  styles: any;
};

export function DealerOfferCard({
  deal,
  isAdmin,
  canEditOffer,
  dealOfferInput,
  onOfferInputChange,
  dealSaving,
  onSaveOffer,
  parseMoneyInput,
  formatMoneyString,
  fmtZar,
  dealerOfferHistoryOpen,
  onToggleHistory,
  colors,
  styles,
}: DealerOfferCardProps) {
  const savedOffer = deal?.dealer_offer_zar ?? null;
  const parsed = parseMoneyInput(dealOfferInput);
  const isDirty = parsed !== savedOffer && parsed != null;
  const offerHistory = ((deal as any)?.dealer_offer_history || [] as DealerOfferHistoryEntry[])
    .slice()
    .reverse() as DealerOfferHistoryEntry[]; // newest first

  return (
    <View style={styles.dealerOfferCard} testID="dealer-offer-card">
      <View style={styles.dealerOfferHeader}>
        <Ionicons name="cash-outline" size={16} color={colors.text} />
        <Text style={styles.dealerOfferTitle}>{isAdmin ? "Dealer Offer" : "My Offer"}</Text>
        {savedOffer != null ? (
          <View style={styles.dealerOfferPill} testID="dealer-offer-set-pill">
            <Ionicons name="checkmark-circle" size={11} color="#fff" />
            <Text style={styles.dealerOfferPillText}>OFFER SET</Text>
          </View>
        ) : (
          <View style={[styles.dealerOfferPill, { backgroundColor: colors.textDisabled }]}>
            <Text style={styles.dealerOfferPillText}>NOT SET</Text>
          </View>
        )}
      </View>
      {savedOffer != null ? (
        <Text style={styles.dealerOfferBigNumber} testID="dealer-offer-amount">
          {fmtZar(savedOffer)}
        </Text>
      ) : null}
      {savedOffer != null && deal?.dealer_offer_at ? (
        <Text style={styles.dealerOfferMeta}>
          Recorded {new Date(deal.dealer_offer_at).toLocaleDateString()}
        </Text>
      ) : null}
      <Text style={styles.dealerOfferHelp}>
        {canEditOffer
          ? "Your dealership's own offer to the seller. Save this to unlock the Deal Tracking section below."
          : savedOffer != null
            ? (isAdmin
                ? "This is the offer the dealership's manager has recorded for the seller."
                : "This is the offer your dealership's manager has recorded for the seller.")
            : (isAdmin
                ? "Waiting on the dealership's manager to record the offer."
                : "Waiting on your dealership's manager to record the offer.")}
      </Text>
      {canEditOffer ? (
        <View style={styles.dealerOfferInputRow}>
          <TextInput
            testID="dealer-offer-input"
            value={dealOfferInput}
            onChangeText={(v) => onOfferInputChange(formatMoneyString(v))}
            placeholder="e.g. 380,000"
            placeholderTextColor={colors.textDisabled}
            keyboardType="numeric"
            editable={!dealSaving}
            style={[styles.dealerOfferInput, { flex: 1 }]}
          />
          <TouchableOpacity
            testID="dealer-offer-save"
            disabled={dealSaving || !isDirty}
            style={[
              styles.dealerOfferSaveBtn,
              (!isDirty || dealSaving) && { opacity: 0.5 },
            ]}
            onPress={() => onSaveOffer(parsed)}
          >
            {dealSaving ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.dealerOfferSaveBtnText}>
                {savedOffer != null ? "Update" : "Save Offer"}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Collapsible offer history — shown when there are 2+ recorded amounts */}
      {offerHistory.length >= 2 ? (
        <TouchableOpacity
          testID="dealer-offer-history-toggle"
          onPress={onToggleHistory}
          style={styles.dealerOfferHistoryToggle}
          activeOpacity={0.7}
        >
          <Ionicons
            name={dealerOfferHistoryOpen ? "chevron-up" : "chevron-down"}
            size={13}
            color={colors.textSecondary}
          />
          <Text style={styles.dealerOfferHistoryToggleText}>
            {dealerOfferHistoryOpen ? "Hide" : "Show"} offer history · {offerHistory.length} update{offerHistory.length === 1 ? "" : "s"}
          </Text>
        </TouchableOpacity>
      ) : null}
      {offerHistory.length >= 2 && dealerOfferHistoryOpen ? (
        <View style={styles.dealerOfferHistoryList} testID="dealer-offer-history-list">
          {offerHistory.map((h, idx) => {
            const isCurrent = idx === 0;
            return (
              <View
                key={`${h.at}-${idx}`}
                style={[
                  styles.dealerOfferHistoryRow,
                  isCurrent && { borderColor: colors.primary + "88" },
                ]}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.dealerOfferHistoryAmount}>
                    {fmtZar(h.price_zar)}
                    {isCurrent ? (
                      <Text style={{ color: colors.primary, fontWeight: "800" }}>  · Current</Text>
                    ) : null}
                  </Text>
                  <Text style={styles.dealerOfferHistoryMeta}>
                    {new Date(h.at).toLocaleString()} · {h.by_name || "—"}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

export default DealerOfferCard;
