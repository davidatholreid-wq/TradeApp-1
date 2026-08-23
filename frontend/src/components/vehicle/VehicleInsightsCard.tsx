/**
 * VehicleInsightsCard — Aug 2026 addition.
 *
 * Sits below the Tyre Replacement Estimate on the vehicle detail
 * screen. When the dealer / admin taps "Fetch insights", we call
 * `POST /api/submissions/{id}/vehicle-insights` which asks GPT-5.2
 * to summarise:
 *   • published safety recalls for this exact make/model/year
 *   • common failure modes & known issues
 *   • pre-purchase checklist tuned to this specific vehicle
 *
 * The result is cached on the submission doc so revisiting the
 * screen doesn't re-bill LLM usage.
 */
import React from "react";
import { View, Text, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { TouchableOpacity, Pressable } from "@/src/components/HapticButtons";

type Severity = "low" | "medium" | "high";

type Recall = {
  title?: string;
  summary?: string;
  severity?: Severity;
  year_range?: string;
};

type Issue = {
  title?: string;
  summary?: string;
  typical_cost_zar?: string;
};

type InsightsPayload = {
  insights: {
    recalls?: Recall[];
    common_issues?: Issue[];
    buying_checklist?: string[];
    confidence?: Severity;
    disclaimer?: string;
    raw?: string;
  };
  generated_at?: string;
  model?: string;
};

export type VehicleInsightsCardProps = {
  insights: InsightsPayload | null | undefined;
  loading: boolean;
  onFetch: () => void;
  colors: any;
  styles: any;
  // Aug 2026: collapsible.
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
};

function severityColor(sev: Severity | undefined) {
  if (sev === "high") return "#B91C1C";
  if (sev === "medium") return "#B45309";
  return "#0369A1";
}

function severityBg(sev: Severity | undefined) {
  if (sev === "high") return "#FEE2E2";
  if (sev === "medium") return "#FEF3C7";
  return "#E0F2FE";
}

export default function VehicleInsightsCard({
  insights,
  loading,
  onFetch,
  colors,
  styles,
  collapsed = false,
  onToggleCollapsed,
}: VehicleInsightsCardProps) {
  const data = insights?.insights;
  const hasData = !!data && !data.raw;
  const recalls = data?.recalls || [];
  const issues = data?.common_issues || [];
  const checklist = data?.buying_checklist || [];

  return (
    <>
      <View style={styles.analysisHeader}>
        <Pressable
          style={{ flex: 1 }}
          onPress={onToggleCollapsed}
          accessibilityRole="button"
          accessibilityState={{ expanded: !collapsed }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {onToggleCollapsed ? (
              <Ionicons
                name={collapsed ? "chevron-down" : "chevron-up"}
                size={16}
                color={colors.textSecondary}
              />
            ) : null}
            <Text style={styles.sectionTitle}>Recalls & Known Issues</Text>
          </View>
          {insights?.generated_at ? (
            <Text style={styles.analysisTs}>
              Generated {new Date(insights.generated_at).toLocaleString()}
            </Text>
          ) : (
            <Text style={[styles.analysisTs, { color: colors.textSecondary }]}>
              GPT-5.2 checks published recalls & common failure modes for this make/model/year.
            </Text>
          )}
        </Pressable>
        <TouchableOpacity
          testID="vehicle-insights-button"
          style={[styles.analysisBtn, loading && { opacity: 0.6 }]}
          onPress={onFetch}
          disabled={loading}
          accessibilityLabel="Check recalls and known issues"
        >
          {loading ? (
            <ActivityIndicator size="small" color={colors.text} />
          ) : (
            <>
              <Ionicons name="warning-outline" size={14} color={colors.text} />
              <Text style={styles.analysisBtnText}>
                {hasData ? "Refresh" : "Check now"}
              </Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {!collapsed && hasData ? (
        <View style={{ gap: 12, marginTop: 8 }}>
          {/* Recalls */}
          <View>
            <Text style={styles.subsectionTitle}>Recalls</Text>
            {recalls.length === 0 ? (
              <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                No published recalls found for this vehicle.
              </Text>
            ) : (
              recalls.map((r, i) => (
                <View
                  key={`recall-${i}`}
                  style={{
                    marginTop: 6,
                    padding: 10,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: severityColor(r.severity),
                    backgroundColor: severityBg(r.severity),
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Ionicons
                      name="alert-circle-outline"
                      size={14}
                      color={severityColor(r.severity)}
                    />
                    <Text style={{ color: severityColor(r.severity), fontWeight: "800", flex: 1 }}>
                      {r.title || "Recall"}
                    </Text>
                    {r.year_range ? (
                      <Text style={{ color: severityColor(r.severity), fontSize: 10, fontWeight: "700" }}>
                        {r.year_range}
                      </Text>
                    ) : null}
                  </View>
                  {r.summary ? (
                    <Text style={{ color: severityColor(r.severity), fontSize: 12, marginTop: 4, lineHeight: 16 }}>
                      {r.summary}
                    </Text>
                  ) : null}
                </View>
              ))
            )}
          </View>

          {/* Common issues */}
          <View>
            <Text style={styles.subsectionTitle}>Common Issues</Text>
            {issues.length === 0 ? (
              <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
                No widely-reported issues for this vehicle.
              </Text>
            ) : (
              issues.map((it, i) => (
                <View
                  key={`issue-${i}`}
                  style={{
                    marginTop: 6,
                    padding: 10,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: colors.borderLight,
                    backgroundColor: colors.card,
                  }}
                >
                  <Text style={{ color: colors.text, fontWeight: "800" }}>
                    {it.title || "Issue"}
                  </Text>
                  {it.summary ? (
                    <Text style={{ color: colors.text, fontSize: 12, marginTop: 4, lineHeight: 16 }}>
                      {it.summary}
                    </Text>
                  ) : null}
                  {it.typical_cost_zar ? (
                    <Text style={{ color: colors.textSecondary, fontSize: 11, marginTop: 4 }}>
                      Typical repair cost: {it.typical_cost_zar}
                    </Text>
                  ) : null}
                </View>
              ))
            )}
          </View>

          {/* Buying checklist */}
          {checklist.length > 0 ? (
            <View>
              <Text style={styles.subsectionTitle}>Pre-purchase Checklist</Text>
              {checklist.map((c, i) => (
                <View
                  key={`chk-${i}`}
                  style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 6 }}
                >
                  <Ionicons name="checkmark-circle-outline" size={14} color={colors.primary} />
                  <Text style={{ color: colors.text, fontSize: 12, flex: 1, lineHeight: 16 }}>{c}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {data?.disclaimer ? (
            <Text style={{ color: colors.textSecondary, fontSize: 10, fontStyle: "italic", marginTop: 4 }}>
              {data.disclaimer}
            </Text>
          ) : null}
        </View>
      ) : data?.raw ? (
        <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 6 }}>
          Insights returned in an unexpected format — please try again.
        </Text>
      ) : null}
    </>
  );
}
