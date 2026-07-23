import { useEffect, useRef, useState, useMemo } from "react";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { View, Text, Modal, ScrollView, StyleSheet, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

type Props = {
  visible: boolean;
  // ISO date string (YYYY-MM-DD) or null
  value: string | null;
  onSelect: (isoDate: string) => void;
  onClose: () => void;
  // Oldest allowed year (defaults to current - 25)
  minYear?: number;
  // Newest allowed year (defaults to current)
  maxYear?: number;
  title?: string;
};

const ITEM_HEIGHT = 44;
const VISIBLE_COUNT = 5; // odd number so one row is centered
const PICKER_HEIGHT = ITEM_HEIGHT * VISIBLE_COUNT;

// Two-column iOS-style scroll picker: month on the left, year on the right.
// Snaps to the selected row and always returns a well-formed ISO date
// (defaults day to 01 since the app only needs month+year granularity).
export default function MonthYearPicker({
  visible,
  value,
  onSelect,
  onClose,
  minYear,
  maxYear,
  title = "Last Service Date",
}: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const nowYear = new Date().getFullYear();
  const yMin = minYear ?? nowYear - 25;
  const yMax = maxYear ?? nowYear;
  const years: number[] = [];
  for (let y = yMax; y >= yMin; y--) years.push(y);

  const parsed = parseIso(value);
  const [monthIndex, setMonthIndex] = useState<number>(parsed?.month ?? new Date().getMonth());
  const [yearIndex, setYearIndex] = useState<number>(() => {
    const y = parsed?.year ?? nowYear;
    const idx = years.indexOf(y);
    return idx >= 0 ? idx : 0;
  });

  const monthScrollRef = useRef<ScrollView | null>(null);
  const yearScrollRef = useRef<ScrollView | null>(null);

  // Sync scroll offsets whenever the modal opens.
  useEffect(() => {
    if (!visible) return;
    const parsedNow = parseIso(value);
    const m = parsedNow?.month ?? new Date().getMonth();
    const y = parsedNow?.year ?? nowYear;
    const yi = years.indexOf(y);
    setMonthIndex(m);
    setYearIndex(yi >= 0 ? yi : 0);
    // Defer scroll until the ScrollView has laid out.
    setTimeout(() => {
      monthScrollRef.current?.scrollTo({ y: m * ITEM_HEIGHT, animated: false });
      yearScrollRef.current?.scrollTo({ y: (yi >= 0 ? yi : 0) * ITEM_HEIGHT, animated: false });
    }, 30);
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleConfirm = () => {
    const yr = years[yearIndex] ?? nowYear;
    const mm = String((monthIndex ?? 0) + 1).padStart(2, "0");
    onSelect(`${yr}-${mm}-01`);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <TouchableOpacity onPress={onClose} testID="monthyear-close">
              <Text style={styles.cancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.title}>{title}</Text>
            <TouchableOpacity onPress={handleConfirm} testID="monthyear-confirm">
              <Text style={styles.done}>Done</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.wheels}>
            {/* Highlight bar behind both wheels */}
            <View style={styles.selectionBar} />

            {/* Month wheel */}
            <View style={styles.wheel}>
              <ScrollView
                ref={monthScrollRef}
                showsVerticalScrollIndicator={false}
                snapToInterval={ITEM_HEIGHT}
                decelerationRate="fast"
                bounces={false}
                onMomentumScrollEnd={(e) => {
                  const i = Math.round(e.nativeEvent.contentOffset.y / ITEM_HEIGHT);
                  setMonthIndex(clamp(i, 0, 11));
                }}
                contentContainerStyle={{ paddingVertical: (PICKER_HEIGHT - ITEM_HEIGHT) / 2 }}
              >
                {MONTHS.map((m, i) => (
                  <TouchableOpacity
                    key={m}
                    activeOpacity={0.6}
                    onPress={() => {
                      setMonthIndex(i);
                      monthScrollRef.current?.scrollTo({ y: i * ITEM_HEIGHT, animated: true });
                    }}
                    style={styles.item}
                  >
                    <Text
                      style={[
                        styles.itemText,
                        i === monthIndex ? styles.itemTextActive : styles.itemTextDim,
                      ]}
                    >
                      {m}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            {/* Year wheel */}
            <View style={styles.wheel}>
              <ScrollView
                ref={yearScrollRef}
                showsVerticalScrollIndicator={false}
                snapToInterval={ITEM_HEIGHT}
                decelerationRate="fast"
                bounces={false}
                onMomentumScrollEnd={(e) => {
                  const i = Math.round(e.nativeEvent.contentOffset.y / ITEM_HEIGHT);
                  setYearIndex(clamp(i, 0, years.length - 1));
                }}
                contentContainerStyle={{ paddingVertical: (PICKER_HEIGHT - ITEM_HEIGHT) / 2 }}
              >
                {years.map((y, i) => (
                  <TouchableOpacity
                    key={y}
                    activeOpacity={0.6}
                    onPress={() => {
                      setYearIndex(i);
                      yearScrollRef.current?.scrollTo({ y: i * ITEM_HEIGHT, animated: true });
                    }}
                    style={styles.item}
                  >
                    <Text
                      style={[
                        styles.itemText,
                        styles.itemTextMono,
                        i === yearIndex ? styles.itemTextActive : styles.itemTextDim,
                      ]}
                    >
                      {y}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          </View>

          <TouchableOpacity
            style={styles.tbcBtn}
            onPress={() => {
              onSelect("TBC");
              onClose();
            }}
            testID="monthyear-tbc"
          >
            <Ionicons name="help-circle-outline" size={14} color={colors.textSecondary} />
            <Text style={styles.tbcText}>Mark as TBC (unknown)</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function parseIso(v: string | null): { month: number; year: number } | null {
  if (!v || v === "TBC") return null;
  const m = /^(\d{4})-(\d{2})/.exec(v);
  if (!m) return null;
  return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) - 1 };
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function formatIsoMonthYear(v: string | null | undefined): string {
  if (!v || v === "TBC") return "";
  const p = parseIso(v);
  if (!p) return v;
  return `${MONTHS[p.month]} ${p.year}`;
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.65)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.paper,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    paddingBottom: Platform.OS === "ios" ? 24 : spacing.md,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { color: colors.text, fontSize: 15, fontWeight: "700", letterSpacing: 0.3 },
  cancel: { color: colors.textSecondary, fontSize: 15, fontWeight: "500" },
  done: { color: "#fff", fontSize: 15, fontWeight: "800" },
  wheels: {
    flexDirection: "row",
    height: PICKER_HEIGHT,
    position: "relative",
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  wheel: { flex: 1 },
  selectionBar: {
    position: "absolute",
    left: spacing.md,
    right: spacing.md,
    top: (PICKER_HEIGHT - ITEM_HEIGHT) / 2,
    height: ITEM_HEIGHT,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: "rgba(255,255,255,0.03)",
    pointerEvents: "none",
  },
  item: { height: ITEM_HEIGHT, alignItems: "center", justifyContent: "center" },
  itemText: { fontSize: 18, textAlign: "center" },
  itemTextActive: { color: colors.text, fontWeight: "800" },
  itemTextDim: { color: colors.textDisabled, fontWeight: "500" },
  itemTextMono: { fontFamily: fonts.mono, letterSpacing: 0.5 },
  tbcBtn: {
    marginTop: spacing.sm,
    marginHorizontal: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border,
    borderRadius: radius.sm,
  },
  tbcText: { color: colors.textSecondary, fontSize: 13, letterSpacing: 0.2 },
});
