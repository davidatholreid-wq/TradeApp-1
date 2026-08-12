// -----------------------------------------------------------------------------
// IdentityLicenseSection — VIN / Engine identity + decoded License Disk block.
//
// Extracted from `/app/frontend/app/(app)/vehicle/[id].tsx` during the
// P3 modularization pass — Round C (Aug 2026). Includes the ownership
// heuristic derived from the disc's Date of Test.
// -----------------------------------------------------------------------------
import React from "react";
import { View, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import DetailRow from "@/src/components/vehicle/DetailRow";
import { decodeLicenseDisk } from "@/src/utils/licenseDisk";
import type { Submission } from "@/src/types/vehicle";

export type IdentityLicenseSectionProps = {
  sub: Submission;
  colors: any;
  styles: any;
};

export function IdentityLicenseSection({ sub, colors, styles }: IdentityLicenseSectionProps) {
  return (
    <>
      {/* Identity */}
      <Text style={styles.sectionTitle}>Identity</Text>
      <View style={styles.detailsList}>
        <DetailRow label="VIN" value={sub.vin || "TBC"} mono />
        <DetailRow label="Engine No" value={sub.engine_number || "TBC"} mono last />
      </View>

      {/* License disk */}
      {sub.license_disk_data ? (
        <>
          <Text style={styles.sectionTitle}>License Disk Data</Text>
          {(() => {
            const info = decodeLicenseDisk(sub.license_disk_data!);
            const hasFields =
              info.vin ||
              info.make ||
              info.model ||
              info.licenceNo ||
              info.vehicleRegisterNo ||
              info.engineNo ||
              info.expiryDate ||
              info.licenceDiscNo;
            if (!hasFields) {
              return (
                <View style={styles.diskBox}>
                  <Text style={styles.diskText}>{sub.license_disk_data}</Text>
                </View>
              );
            }
            const rows: [string, string | undefined][] = [
              ["Licence No", info.licenceNo],
              ["Register No", info.vehicleRegisterNo],
              ["Make", info.make],
              ["Model", info.model],
              ["Colour", info.colour],
              ["Description", info.vehicleDescription],
              ["VIN", info.vin],
              ["Engine No", info.engineNo],
              ["Date of Test", info.dateOfTest],
              ["Expires", info.expiryDate],
              ["Disc No", info.licenceDiscNo],
            ];
            // Ownership signal derived from disc's Date of Test.
            const submittedAtIso = sub.created_at || new Date().toISOString();
            let ownership: { text: string; oneOwner: boolean } | null = null;
            if (!info.dateOfTest) {
              ownership = { text: "1-Owner from new", oneOwner: true };
            } else {
              try {
                const test = new Date(info.dateOfTest);
                const now = new Date(submittedAtIso);
                let months =
                  (now.getFullYear() - test.getFullYear()) * 12 +
                  (now.getMonth() - test.getMonth());
                if (now.getDate() < test.getDate()) months -= 1;
                if (months < 0) months = 0;
                const yrs = Math.floor(months / 12);
                const mos = months % 12;
                const parts: string[] = [];
                if (yrs > 0) parts.push(`${yrs} ${yrs === 1 ? "year" : "years"}`);
                if (mos > 0 || yrs === 0) parts.push(`${mos} ${mos === 1 ? "month" : "months"}`);
                ownership = { text: `Owned approx. ${parts.join(" ")}`, oneOwner: false };
              } catch {
                ownership = null;
              }
            }
            return (
              <View style={styles.diskDecodedBox}>
                {ownership ? (
                  <View
                    style={[
                      styles.ownershipBadge,
                      ownership.oneOwner ? styles.ownershipBadgeOne : styles.ownershipBadgeMulti,
                    ]}
                    testID="license-disk-ownership-badge"
                  >
                    <Ionicons
                      name={ownership.oneOwner ? "ribbon" : "time-outline"}
                      size={16}
                      color={ownership.oneOwner ? "#065F46" : colors.text}
                    />
                    <Text
                      style={[
                        styles.ownershipBadgeText,
                        ownership.oneOwner
                          ? styles.ownershipBadgeTextOne
                          : styles.ownershipBadgeTextMulti,
                      ]}
                    >
                      {ownership.text}
                    </Text>
                  </View>
                ) : null}
                {rows
                  .filter(([, v]) => !!v)
                  .map(([label, value]) => (
                    <View key={label} style={styles.diskDecodedRow}>
                      <Text style={styles.diskDecodedLabel}>{label}</Text>
                      <Text style={styles.diskDecodedValue}>{value}</Text>
                    </View>
                  ))}
              </View>
            );
          })()}
        </>
      ) : null}
    </>
  );
}

export default IdentityLicenseSection;
