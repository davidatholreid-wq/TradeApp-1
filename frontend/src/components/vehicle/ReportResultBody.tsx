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

  // BMW / Mercedes Factory Options result shares the same normalised
  // shape produced by our two client wrappers — no summary/sections,
  // just {status:"ok", vin, options:[{code, kind, description}], ...}.
  // Renders as a list of code + description pills. The Mercedes payload
  // also carries `series` (chassis), `year`, `fuel`, `headunit`, which
  // we tease into the intro caption when present.
  const isFactoryOptions =
    data && data.status === "ok" && Array.isArray(data.options) && !sections;
  if (isFactoryOptions) {
    const options = (data.options || []) as { code: string; kind: string; description?: string | null }[];
    const isMb = data.provider === "mbtools" || (!!data.series && !data.provider);
    const isOutvin = data.provider === "outvin";
    const captionBits: string[] = [];
    captionBits.push(`${options.length} factory-fitted option${options.length === 1 ? "" : "s"}`);
    if (data.vin) captionBits.push(`VIN ${data.vin}`);
    // Outvin — rich metadata block
    if (isOutvin) {
      if (data.make && data.model) captionBits.push(`${data.make} · ${data.model}`);
      else if (data.model) captionBits.push(String(data.model));
      if (data.production_date) captionBits.push(`Built ${data.production_date}`);
      const engineBits: string[] = [];
      if (data.engine_code) engineBits.push(`${data.engine_code}`);
      if (data.displacement) engineBits.push(`${data.displacement}L`);
      if (data.power_kw) engineBits.push(`${data.power_kw}kW`);
      if (data.fuel_type) engineBits.push(String(data.fuel_type));
      if (engineBits.length) captionBits.push(engineBits.join(" · "));
      if (data.colour) captionBits.push(`Colour ${data.colour}`);
      if (data.interior) captionBits.push(`Interior ${data.interior}`);
    }
    // mbtools — chassis / head-unit block
    if (isMb && !isOutvin) {
      if (data.series) captionBits.push(`Chassis W${data.series}`);
      if (data.year) captionBits.push(String(data.year));
      if (data.fuel) captionBits.push(data.fuel);
      if (data.headunit?.generation) captionBits.push(`Head Unit ${data.headunit.generation}`);
    }
    return (
      <View>
        <Text style={[styles.viewReportBody, { marginBottom: spacing.sm }]}>
          {captionBits.join(" · ")}
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

  // Porsche VIN Decode — rule-based decoder result. Payload has:
  //   { status, vin, model, generation, model_year, model_code,
  //     vehicle_class, market, factory, country, serial,
  //     check_digit, check_digit_computed, check_digit_valid,
  //     positions:{...}, warnings:[], disclaimer }
  const isPorscheVin =
    data && !sections && data.status === "ok" && data.manufacturer === "Porsche"
    && data.model_code && data.positions;
  if (isPorscheVin) {
    const positions = (data.positions || {}) as Record<string, string>;
    const posMeta: { key: string; label: string }[] = [
      { key: "1", label: "Country of origin (WMI)" },
      { key: "2", label: "Manufacturer (P = Porsche)" },
      { key: "3", label: "Vehicle class (0 = sports car, 1 = SUV)" },
      { key: "4-6", label: "ROW filler / NA body-engine-restraint" },
      { key: "7", label: "Model code high (ROW) / era (NA)" },
      { key: "8", label: "Model code middle" },
      { key: "9", label: "Filler (ROW) / check digit (NA)" },
      { key: "10", label: "Model year code" },
      { key: "11", label: "Factory / assembly plant" },
      { key: "12", label: "Model code low" },
      { key: "13-17", label: "Production serial sequence" },
    ];
    const identityRows: [string, any][] = [
      ["Model", data.model],
      ["Generation", data.generation || "—"],
      ["Model Year", data.model_year != null ? String(data.model_year) : "—"],
      ["Type Code", data.model_code],
      ["Vehicle Class", data.vehicle_class],
      ["Market", data.market],
      ["Manufacturer Country", data.country],
      ["Factory", data.factory],
      ["Production Serial", data.serial],
    ];
    if (data.check_digit_valid !== null && data.check_digit_valid !== undefined) {
      identityRows.push([
        "NA Check Digit",
        data.check_digit_valid
          ? "Valid"
          : `Invalid (computed ${data.check_digit_computed} vs printed ${data.check_digit})`,
      ]);
    }
    const getPosVal = (k: string) => {
      if (k === "4-6") {
        return `${positions["4"] || ""}${positions["5"] || ""}${positions["6"] || ""}`;
      }
      if (k === "13-17") return positions["13-17"] || "";
      return positions[k] || "";
    };
    return (
      <View>
        <Text style={styles.reportSectionHeader}>Decoded identity</Text>
        {identityRows.map(([k, v]) => (
          <View key={k} style={styles.reportRow}>
            <Text style={styles.reportRowLabel}>{k}</Text>
            <Text style={styles.reportRowValue}>{renderValue(v)}</Text>
          </View>
        ))}
        <Text style={styles.reportSectionHeader}>
          VIN position-by-position
        </Text>
        {posMeta.map(({ key, label }) => (
          <View key={key} style={styles.reportRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.reportRowLabel}>
                Pos {key} · {label}
              </Text>
            </View>
            <Text style={styles.reportRowValue}>
              {getPosVal(key) || "—"}
            </Text>
          </View>
        ))}
        {Array.isArray(data.warnings) && data.warnings.length > 0 ? (
          <>
            <Text style={styles.reportSectionHeader}>Notes</Text>
            {data.warnings.map((w: string, i: number) => (
              <View
                key={`w-${i}`}
                style={{
                  flexDirection: "row",
                  alignItems: "flex-start",
                  gap: 6,
                  paddingVertical: 6,
                }}
              >
                <Ionicons name="alert-circle-outline" size={14} color={colors.warning} />
                <Text style={[styles.reportBullet, { flex: 1 }]}>{w}</Text>
              </View>
            ))}
          </>
        ) : null}
        {data.disclaimer ? (
          <Text
            style={[
              styles.viewReportBody,
              { marginTop: spacing.md, opacity: 0.7, fontSize: 11, fontStyle: "italic" },
            ]}
          >
            {String(data.disclaimer)}
          </Text>
        ) : null}
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
