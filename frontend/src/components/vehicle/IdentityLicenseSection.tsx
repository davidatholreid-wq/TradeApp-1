// -----------------------------------------------------------------------------
// IdentityLicenseSection — VIN / Engine identity + decoded License Disk block.
//
// Extracted from `/app/frontend/app/(app)/vehicle/[id].tsx` during the
// P3 modularization pass — Round C (Aug 2026). The old "1-Owner from
// new" ownership badge derived from the disc's Date of Test was
// removed as unreliable.
// -----------------------------------------------------------------------------
import React from "react";
import { View, Text } from "react-native";
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
            // Aug 2026: removed the "1-Owner from new" / "Owned approx. X"
            // ownership badge — the disc's blank Date of Test was
            // being interpreted as one-owner-from-new, which isn't
            // actually reliable, so we no longer surface that signal.
            return (
              <View style={styles.diskDecodedBox}>
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
