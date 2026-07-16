import { Modal, View, Text, ScrollView, TouchableOpacity, StyleSheet, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius, fonts } from "@/src/theme";

type Props = {
  visible: boolean;
  onClose: () => void;
};

type Pillar = {
  title: string;
  weight: number;
  bullets: { heading: string; body: string }[];
};

// Reusable "Condition Rating Guide" modal. Tapping the Overall Condition
// hero on either the mobile or desktop admin view opens this. Content is
// dealer-facing but currently only surfaced in the admin flow — the user
// asked for a tap-to-reveal breakdown of what each pillar means and how it
// contributes to the overall score.
const PILLARS: Pillar[] = [
  {
    title: "Mechanical & Drivability",
    weight: 30,
    bullets: [
      {
        heading: "Engine & Transmission",
        body: "Smooth shifting, no unusual noises, no smoking, and no active fluid leaks.",
      },
      {
        heading: "Suspension & Steering",
        body: "No clunks over bumps; the car tracks straight without pulling.",
      },
      {
        heading: "Brakes",
        body: "Firm pedal feel, adequate pad life, and no warping or pulsation when stopping.",
      },
    ],
  },
  {
    title: "Exterior & Bodywork",
    weight: 25,
    bullets: [
      {
        heading: "Paint & Clear Coat",
        body: "Original factory paint with a deep gloss, free from major fading, oxidation, or deep scratches.",
      },
      {
        heading: "Body Panels",
        body: "No signs of past accidents, frame damage, or rust. Panel gaps must be factory-spec and uniform.",
      },
      {
        heading: "Glass & Trim",
        body: "Uncracked windshield, clear headlights, and undamaged trim pieces.",
      },
    ],
  },
  {
    title: "Interior Condition",
    weight: 25,
    bullets: [
      {
        heading: "Upholstery & Carpets",
        body: "No rips, tears, or deep stains in the seats, carpets, or headliner.",
      },
      {
        heading: "Electronics",
        body: "All windows, locks, lights, A/C, and infotainment systems must function perfectly.",
      },
      {
        heading: "Smell",
        body: "No lingering odours from pets, smoke, or water damage.",
      },
    ],
  },
  {
    title: "History & Maintenance",
    weight: 20,
    bullets: [
      {
        heading: "Service Records",
        body: "Consistent, documented oil changes and preventative maintenance.",
      },
      {
        heading: "Title Status",
        body: "Clean title (not rebuilt, salvaged, or flooded).",
      },
      {
        heading: "Ownership & Mileage",
        body: "Lower mileage for the vehicle's age, with fewer previous owners.",
      },
    ],
  },
];

export default function ConditionRatingInfoModal({ visible, onClose }: Props) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Condition Rating Guide</Text>
              <Text style={styles.subtitle}>
                How the overall score is weighted across four pillars.
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} testID="condition-info-close" style={styles.closeBtn}>
              <Ionicons name="close" size={22} color={colors.text} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
            {PILLARS.map((p, i) => (
              <View key={p.title} style={styles.pillarBlock}>
                <View style={styles.pillarHead}>
                  <Text style={styles.pillarIndex}>{i + 1}.</Text>
                  <Text style={styles.pillarTitle}>{p.title}</Text>
                  <View style={styles.weightPill}>
                    <Text style={styles.weightText}>{p.weight}%</Text>
                  </View>
                </View>
                {p.bullets.map((b) => (
                  <View key={b.heading} style={styles.bullet}>
                    <Text style={styles.bulletHeading}>{b.heading}</Text>
                    <Text style={styles.bulletBody}>{b.body}</Text>
                  </View>
                ))}
              </View>
            ))}
            <View style={styles.footer}>
              <Ionicons name="calculator-outline" size={14} color={colors.textSecondary} />
              <Text style={styles.footerText}>
                Overall score = Mech × 0.30 + Cosm × 0.25 + Int × 0.25 + Hist × 0.20
              </Text>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.8)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.paper,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: colors.borderLight,
    maxHeight: "92%",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { color: colors.text, fontSize: 18, fontWeight: "800", fontFamily: fonts.heading, letterSpacing: 0.3 },
  subtitle: { color: colors.textSecondary, fontSize: 13, marginTop: 2, letterSpacing: 0.1 },
  closeBtn: { padding: 4 },
  body: { padding: spacing.md, paddingBottom: Platform.OS === "ios" ? 40 : spacing.lg },
  pillarBlock: {
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    marginBottom: spacing.md,
  },
  pillarHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: spacing.sm,
  },
  pillarIndex: { color: colors.textSecondary, fontFamily: fonts.mono, fontSize: 13, fontWeight: "800" },
  pillarTitle: { color: colors.text, fontSize: 15, fontWeight: "800", flex: 1, letterSpacing: 0.2 },
  weightPill: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.paper,
  },
  weightText: { color: colors.text, fontSize: 12, fontWeight: "800", fontFamily: fonts.mono, letterSpacing: 0.5 },
  bullet: {
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  bulletHeading: { color: colors.text, fontSize: 13, fontWeight: "700", letterSpacing: 0.1, marginBottom: 2 },
  bulletBody: { color: colors.textSecondary, fontSize: 13, lineHeight: 18, letterSpacing: 0.1 },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  footerText: { color: colors.textSecondary, fontSize: 12, fontStyle: "italic", flex: 1 },
});
