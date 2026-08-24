/**
 * OwnerTimelineModal — Feb 2027.
 *
 * Opened when the dealer/admin taps the green owner-history chip on
 * the Kredo CarTrust card. Displays a full vertical timeline of every
 * owner recorded in the NaTIS callback / PDF, including:
 *   • Owner name (dealership or private person as recorded on NaTIS)
 *   • Kind — current or previous
 *   • Ownership start date (dd MMM yyyy)
 *
 * The list is sorted newest → oldest and rendered as a proper timeline
 * with a coloured dot per row and a connector line between rows.
 */
import React from "react";
import {
  View,
  Text,
  Modal,
  ScrollView,
  StyleSheet,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { TouchableOpacity } from "@/src/components/HapticButtons";

export type OwnerRow = {
  name?: string;
  kind?: "current" | "previous";
  date_iso?: string | null;
};

export type OwnerTimelineModalProps = {
  visible: boolean;
  onClose: () => void;
  timeline: OwnerRow[];
  count?: number | null;
  colors: any;
};

function fmtDate(iso?: string | null): string {
  if (!iso || typeof iso !== "string" || iso.length < 7) return "Date unknown";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "Date unknown";
    return d.toLocaleDateString("en-ZA", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "Date unknown";
  }
}

export default function OwnerTimelineModal({
  visible,
  onClose,
  timeline,
  count,
  colors,
}: OwnerTimelineModalProps) {
  const rows = Array.isArray(timeline) ? timeline : [];
  const totalLabel =
    typeof count === "number" && count > 0
      ? `${count} ${count === 1 ? "owner" : "owners"} on record`
      : rows.length
      ? `${rows.length} ${rows.length === 1 ? "owner" : "owners"} on record`
      : "No owner records yet";

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: colors.paper,
              borderColor: colors.borderLight,
              shadowColor: "#000",
            },
          ]}
          testID="owner-timeline-modal"
        >
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerIconChip}>
              <Ionicons name="people" size={16} color="#065F46" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.headerTitle, { color: colors.text }]}>
                Ownership Timeline
              </Text>
              <Text style={[styles.headerSubtitle, { color: colors.textSecondary }]}>
                {totalLabel}
              </Text>
            </View>
            <TouchableOpacity
              onPress={onClose}
              style={[styles.closeBtn, { backgroundColor: colors.card, borderColor: colors.borderLight }]}
              accessibilityLabel="Close ownership timeline"
              testID="owner-timeline-close"
            >
              <Ionicons name="close" size={16} color={colors.text} />
            </TouchableOpacity>
          </View>

          {rows.length === 0 ? (
            <View style={styles.emptyBlock}>
              <Ionicons name="information-circle-outline" size={22} color={colors.textSecondary} />
              <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                Kredo hasn&apos;t returned a full ownership timeline for this vehicle
                yet. Owner names appear here as soon as NaTIS syncs the data.
              </Text>
            </View>
          ) : (
            <ScrollView
              style={{ maxHeight: 420 }}
              contentContainerStyle={{ paddingVertical: 4 }}
              showsVerticalScrollIndicator={false}
            >
              {rows.map((r, i) => {
                const isCurrent = r.kind === "current";
                const isLast = i === rows.length - 1;
                const dotColor = isCurrent ? "#22C55E" : "#6366F1";
                const dotBg = isCurrent ? "#DCFCE7" : "#E0E7FF";
                return (
                  <View
                    key={`owner-${i}`}
                    style={styles.row}
                    testID={`owner-timeline-row-${i}`}
                  >
                    {/* Left column: dot + connector */}
                    <View style={styles.leftCol}>
                      <View
                        style={[
                          styles.dot,
                          {
                            backgroundColor: dotBg,
                            borderColor: dotColor,
                          },
                        ]}
                      >
                        <View style={[styles.dotInner, { backgroundColor: dotColor }]} />
                      </View>
                      {!isLast ? (
                        <View
                          style={[styles.connector, { backgroundColor: colors.borderLight }]}
                        />
                      ) : null}
                    </View>

                    {/* Right column: card */}
                    <View
                      style={[
                        styles.card,
                        {
                          backgroundColor: colors.card,
                          borderColor: colors.borderLight,
                        },
                      ]}
                    >
                      <View style={styles.cardHead}>
                        <Text
                          style={[styles.ownerName, { color: colors.text }]}
                          numberOfLines={2}
                        >
                          {r.name || "Unknown owner"}
                        </Text>
                        <View
                          style={[
                            styles.kindPill,
                            {
                              backgroundColor: dotBg,
                              borderColor: dotColor,
                            },
                          ]}
                        >
                          <Text style={[styles.kindPillTxt, { color: dotColor }]}>
                            {isCurrent ? "CURRENT" : "PREVIOUS"}
                          </Text>
                        </View>
                      </View>
                      <View style={styles.cardMeta}>
                        <Ionicons
                          name="calendar-outline"
                          size={12}
                          color={colors.textSecondary}
                        />
                        <Text style={[styles.cardMetaTxt, { color: colors.textSecondary }]}>
                          {isCurrent ? "Registered on " : "Held until "}
                          {fmtDate(r.date_iso)}
                        </Text>
                      </View>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          )}

          <Text style={[styles.footer, { color: colors.textSecondary }]}>
            Source: Kredo CarTrust · NaTIS registered owner history
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
  },
  sheet: {
    width: "100%",
    maxWidth: 520,
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    ...Platform.select({
      web: { boxShadow: "0 10px 30px rgba(0,0,0,0.35)" as any },
      default: { shadowOpacity: 0.35, shadowRadius: 20, shadowOffset: { width: 0, height: 10 }, elevation: 12 },
    }),
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 12,
  },
  headerIconChip: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#DCFCE7",
    borderWidth: 1,
    borderColor: "#22C55E",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  headerSubtitle: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.4,
    marginTop: 2,
  },
  closeBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: 10,
  },
  leftCol: {
    width: 20,
    alignItems: "center",
  },
  dot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    marginTop: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  dotInner: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  connector: {
    width: 2,
    flex: 1,
    marginTop: 2,
    marginBottom: -2,
  },
  card: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
    marginBottom: 8,
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  ownerName: {
    flex: 1,
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.15,
  },
  kindPill: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
  },
  kindPillTxt: {
    fontSize: 9,
    fontWeight: "900",
    letterSpacing: 0.6,
  },
  cardMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: 4,
  },
  cardMetaTxt: {
    fontSize: 11,
    fontWeight: "600",
  },
  emptyBlock: {
    padding: 18,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  emptyText: {
    fontSize: 12,
    textAlign: "center",
    lineHeight: 18,
  },
  footer: {
    fontSize: 10,
    fontStyle: "italic",
    marginTop: 8,
    textAlign: "center",
  },
});
