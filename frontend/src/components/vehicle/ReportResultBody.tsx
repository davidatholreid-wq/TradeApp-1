// -----------------------------------------------------------------------------
// ReportResultBody — renders a structured report result payload
// (Lightstone, CarVertical, BMW factory options via Bimmervin, JLR OSH
// service history via LandRover, Kredo VIN accident/claim history).
// Handles arbitrary shapes by branching on well-known keys first, then
// falling back to a generic sections renderer.
//
// Extracted from `/app/frontend/app/(app)/vehicle/[id].tsx` during the
// P1 modularization pass (Aug 2026).
// -----------------------------------------------------------------------------
import { useMemo } from "react";
import { View, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { spacing } from "@/src/theme";
import { useThemeColors } from "@/src/theme/ThemeContext";
import { makeStyles } from "@/src/styles/vehicleDetailStyles";

/**
 * Renders a structured report result payload. Handles arbitrary keys by
 * grouping known sections first and then dumping the remainder as key/value
 * rows. Arrays are rendered as bulleted lists, nested objects as sub-rows.
 */
export function ReportResultBody({ data }: { data: Record<string, any> }) {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const summary = data.summary as string | undefined;
  const sections = data.sections as
    | Record<string, Record<string, any> | any[]>
    | undefined;

  const renderValue = (v: any): string => {
    if (v == null) return "—";
    if (typeof v === "boolean") return v ? "Yes" : "No";
    if (Array.isArray(v)) return v.map((x) => renderValue(x)).join(", ");
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  };

  // BMW Factory Options result (from Bimmervin) has a different shape than
  // the Lightstone/CarVertical mock reports — no summary/sections, just
  // {status:"ok", vin, options:[{code, kind, description}], ...}. Render
  // it inline as a list of code + description pills instead of using the
  // generic sections renderer.
  const isBmwOptions =
    data && data.status === "ok" && Array.isArray(data.options) && !sections;
  if (isBmwOptions) {
    const options = (data.options || []) as { code: string; kind: string; description?: string | null }[];
    return (
      <View>
        <Text style={[styles.viewReportBody, { marginBottom: spacing.sm }]}>
          {options.length} factory-fitted option{options.length === 1 ? "" : "s"} against VIN {data.vin || "—"}.
        </Text>
        <View style={styles.bimmerOptionsList}>
          {options.map((o) => (
            <View
              key={`${o.kind}-${o.code}`}
              style={o.description ? styles.bimmerOptionRow : styles.bimmerOptionRowBare}
            >
              <View style={styles.bimmerOptionKindBadge}>
                <Text style={styles.bimmerOptionKindText}>{o.kind}</Text>
              </View>
              <Text style={styles.bimmerOptionCodeStrong}>{o.code}</Text>
              {o.description ? (
                <Text style={styles.bimmerOptionDesc} numberOfLines={2}>
                  {o.description}
                </Text>
              ) : (
                <Text style={styles.bimmerOptionDescMuted}>—</Text>
              )}
            </View>
          ))}
        </View>
      </View>
    );
  }

  // Kredo VIN accident / claim history — real payload shape from
  // services/kredo_client.py is:
  //   { claim_count, claims: [{ id, creation_date, accident_date,
  //     country, manufacturer, model, mileage_at_claim,
  //     damage_locations: string[], glass_damage }] }
  // Render each claim with its date, vehicle line, mileage, and a
  // chip strip of damage locations (matches the on-screen claim card
  // that used to live in the standalone panel).
  const isKredoVin =
    data && !sections &&
    (typeof data.claim_count === "number"
      || Array.isArray(data.claims)
      || Array.isArray(data.accident_claims));
  if (isKredoVin) {
    const claims = ((data.claims || data.accident_claims) || []) as Array<{
      id?: string;
      accident_date?: string | null;
      creation_date?: string | null;
      country?: string | null;
      manufacturer?: string | null;
      model?: string | null;
      mileage_at_claim?: string | number | null;
      damage_locations?: string[];
      glass_damage?: boolean;
    }>;
    const claimCount = typeof data.claim_count === "number" ? data.claim_count : claims.length;
    return (
      <View>
        {claimCount === 0 ? (
          <View style={styles.kredoClean}>
            <Ionicons name="checkmark-circle" size={22} color={colors.success} />
            <View style={{ flex: 1 }}>
              <Text style={styles.kredoCleanTitle}>No claims found</Text>
              <Text style={styles.kredoCleanSub}>
                Kredo has no insurance-claim records against this VIN.
              </Text>
            </View>
          </View>
        ) : (
          <>
            <Text style={styles.reportSectionHeader}>
              Claims on record ({claimCount})
            </Text>
            {claims.map((c, i) => {
              const dateStr = c.accident_date || c.creation_date || "Unknown date";
              const vehicleLine = [c.manufacturer, c.model].filter(Boolean).join(" · ");
              const mileageNum = typeof c.mileage_at_claim === "string"
                ? parseInt(c.mileage_at_claim, 10)
                : (typeof c.mileage_at_claim === "number" ? c.mileage_at_claim : NaN);
              const mileageStr = Number.isFinite(mileageNum)
                ? `${mileageNum.toLocaleString("en-ZA")} km at claim`
                : null;
              const locs = c.damage_locations || [];
              return (
                <View key={c.id || `kv-${i}`} style={styles.claimCard}>
                  <View style={styles.claimHead}>
                    <Text style={styles.claimDate}>{dateStr}</Text>
                    {c.country ? <Text style={styles.claimCountry}>{c.country}</Text> : null}
                  </View>
                  {vehicleLine ? (
                    <Text style={styles.claimVehicle}>{vehicleLine}</Text>
                  ) : null}
                  {mileageStr ? (
                    <Text style={styles.claimMeta}>{mileageStr}</Text>
                  ) : null}
                  {locs.length > 0 ? (
                    <View style={styles.damageRow}>
                      {locs.map((d) => (
                        <View key={d} style={styles.damageChip}>
                          <Text style={styles.damageChipText}>{d.replace(/-/g, " ").toUpperCase()}</Text>
                        </View>
                      ))}
                      {c.glass_damage ? (
                        <View style={[styles.damageChip, styles.damageChipGlass]}>
                          <Ionicons name="glasses-outline" size={10} color={colors.onPrimary} />
                          <Text style={[styles.damageChipText, { color: colors.onPrimary }]}>
                            WINDSCREEN
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  ) : (
                    <Text style={styles.claimMeta}>
                      Claim record present but no specific damage location recorded.
                    </Text>
                  )}
                  {c.id ? <Text style={styles.claimId}>Ref: {c.id}</Text> : null}
                </View>
              );
            })}
            {data.last_claim_date ? (
              <Text style={[styles.viewReportBody, { marginTop: spacing.sm }]}>
                Last claim: {String(data.last_claim_date)}
              </Text>
            ) : null}
          </>
        )}
      </View>
    );
  }

  // JLR OSH result — {status:"ok", vehicle, last_service, alerts[], services[]}.
  // Render the panels manually so admins see the structured data straight
  // away without having to fish it out of a generic sections block.
  const isJlrOsh =
    data && data.status === "ok" && (data.source || "").includes("landrover") && !sections;
  if (isJlrOsh) {
    const v = (data.vehicle || {}) as {
      vin?: string; model_name?: string; model_year?: string;
      engine?: string; colour?: string;
      warranty_start_date?: string; registration_country?: string;
    };
    const ls = data.last_service as
      | {
          type?: string; distance?: string; date?: string; job_number?: string;
          repairer_name?: string; repairer_location?: string; repairer_type?: string;
          service_items?: string[];
        }
      | null;
    const alerts = (data.alerts || []) as string[];
    const services = (data.services || []) as Array<{
      repairer?: string; job_number?: string; job_date?: string;
      odometer?: string; details?: string;
    }>;
    return (
      <View>
        <Text style={styles.reportSectionHeader}>Vehicle</Text>
        {[
          ["VIN", v.vin],
          ["Model", v.model_name],
          ["Model Year", v.model_year],
          ["Engine", v.engine],
          ["Colour", v.colour],
          ["Warranty Start Date", v.warranty_start_date],
          ["Registration Country", v.registration_country],
        ].map(([label, val]) =>
          val ? (
            <View key={String(label)} style={styles.reportRow}>
              <Text style={styles.reportRowLabel}>{label}</Text>
              <Text style={styles.reportRowValue}>{val}</Text>
            </View>
          ) : null,
        )}

        {services.length > 0 ? (
          <>
            <Text style={styles.reportSectionHeader}>
              Service History ({services.length})
            </Text>
            {services.map((s, i) => (
              <View key={`svc-${i}`} style={styles.serviceHistoryRow}>
                <View style={styles.serviceHistoryHeadRow}>
                  <Text style={styles.serviceHistoryDate}>
                    {s.job_date || "—"}
                  </Text>
                  <Text style={styles.serviceHistoryOdo}>
                    {s.odometer ? `${s.odometer} km` : ""}
                  </Text>
                </View>
                {s.repairer ? (
                  <Text style={styles.serviceHistoryRepairer}>{s.repairer}</Text>
                ) : null}
                <View style={styles.serviceHistoryMetaRow}>
                  {s.job_number ? (
                    <Text style={styles.serviceHistoryJob}>Job #{s.job_number}</Text>
                  ) : null}
                  {s.details ? (
                    <Text style={styles.serviceHistoryDetails} numberOfLines={3}>
                      {s.details}
                    </Text>
                  ) : null}
                </View>
              </View>
            ))}
          </>
        ) : null}

        {ls ? (
          <>
            <Text style={styles.reportSectionHeader}>
              {services.length > 0 ? "Latest Service Detail" : "Last Service Recorded"}
            </Text>
            {[
              ["Type", ls.type],
              ["Distance", ls.distance],
              ["Date", ls.date],
              ["Job Number", ls.job_number],
              ["Repairer", ls.repairer_name],
              ["Location", ls.repairer_location],
            ].map(([label, val]) =>
              val ? (
                <View key={String(label)} style={styles.reportRow}>
                  <Text style={styles.reportRowLabel}>{label}</Text>
                  <Text style={styles.reportRowValue}>{val}</Text>
                </View>
              ) : null,
            )}
            {Array.isArray(ls.service_items) && ls.service_items.length > 0 ? (
              <>
                <Text style={[styles.reportRowLabel, { marginTop: spacing.sm }]}>Service Items</Text>
                {ls.service_items.map((item, i) => (
                  <Text key={`si-${i}`} style={styles.reportBullet}>•  {item}</Text>
                ))}
              </>
            ) : null}
          </>
        ) : services.length === 0 ? (
          <Text style={[styles.viewReportBody, { marginTop: spacing.sm }]}>
            No service records found for this VIN in JLR&apos;s South African database.
          </Text>
        ) : null}

        {alerts.length > 0 ? (
          <>
            <Text style={styles.reportSectionHeader}>
              Outstanding Alerts ({alerts.length})
            </Text>
            {alerts.map((a, i) => (
              <Text key={`al-${i}`} style={styles.reportBullet}>•  {a}</Text>
            ))}
          </>
        ) : null}
      </View>
    );
  }

  return (
    <View>
      {summary ? (
        <Text style={[styles.viewReportBody, { marginBottom: spacing.sm }]}>{summary}</Text>
      ) : null}

      {sections && typeof sections === "object"
        ? Object.entries(sections).map(([sectionName, sectionValue]) => (
            <View key={sectionName}>
              <Text style={styles.reportSectionHeader}>{sectionName}</Text>
              {Array.isArray(sectionValue)
                ? sectionValue.map((item, i) => (
                    <Text key={`${sectionName}-${i}`} style={styles.reportBullet}>
                      •  {renderValue(item)}
                    </Text>
                  ))
                : Object.entries(sectionValue || {}).map(([k, v]) => (
                    <View key={`${sectionName}-${k}`} style={styles.reportRow}>
                      <Text style={styles.reportRowLabel}>{k}</Text>
                      <Text style={styles.reportRowValue}>{renderValue(v)}</Text>
                    </View>
                  ))}
            </View>
          ))
        : null}
    </View>
  );
}

export default ReportResultBody;
