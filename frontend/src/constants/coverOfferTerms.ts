/**
 * Cover Offer Terms & Conditions — canonical text source.
 *
 * Kept in a separate file so any screen that shows the Cover T&Cs
 * (vehicle detail, cover-authoring screen, admin, exported PDFs)
 * always renders the SAME words. Whenever the legal text needs to
 * change, edit here ONLY and every consumer picks it up.
 *
 * Structure:
 *   TITLE            — a plain string used in modal headers
 *   TERMS_LAST_REV   — human-readable last-revision date shown in the
 *                      footer of the modal for auditability
 *   COVER_OFFER_TERMS_SECTIONS — the numbered clauses. Each is a
 *                      { heading, paragraphs, bullets? } tuple that
 *                      renders cleanly in a native ScrollView without
 *                      needing a Markdown renderer.
 */

export const COVER_OFFER_TERMS_TITLE = "Subject to View Cover Offer";
export const COVER_OFFER_TERMS_SUBTITLE = "Fourbuy Car Buying Co. — Terms & Conditions";
export const COVER_OFFER_TERMS_LAST_REV = "November 2026";

export type TermsSection = {
  n: string;              // section number ("1", "2", …) — kept as a string for "5.1", "7.2" etc.
  heading: string;
  paragraphs?: string[];  // one <Text> per paragraph
  bullets?: string[];     // rendered as an indented bullet list
};

export const COVER_OFFER_TERMS_SECTIONS: TermsSection[] = [
  {
    n: "1",
    heading: "Introduction",
    paragraphs: [
      "These Terms and Conditions apply to any Cover Price / Subject to View Offer (\"Cover\") issued by Fourbuy Car Buying Co. (\"Fourbuy\") to a motor dealer (\"Dealer\") in respect of a vehicle submitted for valuation through the Fourbuy Car Buying Co. platform.",
      "By accepting a Cover Price, the Dealer confirms that it has read, understood and accepted these Terms and Conditions and warrants that all information supplied in respect of the vehicle is true, complete and accurate.",
      "A Cover Price is a conditional offer to purchase and is based entirely on the information, declarations, photographs, vehicle details and condition information supplied by the Dealer.",
      "The Cover Price remains subject to physical inspection, verification of the vehicle, verification of ownership and documentation, and compliance with all of the conditions contained herein.",
      "Fourbuy's issuing of a Cover Price must not be interpreted as confirmation that Fourbuy has independently inspected, verified or authenticated the vehicle or any information relating to it.",
    ],
  },
  {
    n: "2",
    heading: "Accuracy of Vehicle Description",
    paragraphs: [
      "The Dealer warrants that the vehicle has been described completely, honestly and accurately in all material respects when submitted for valuation.",
      "The Dealer must disclose all information that may reasonably affect the value, desirability, condition or resaleability of the vehicle, including but not limited to:",
    ],
    bullets: [
      "Exterior cosmetic damage;",
      "Interior damage or excessive wear;",
      "Mechanical defects;",
      "Electrical or electronic faults;",
      "Warning lights or diagnostic faults;",
      "Accident or structural damage;",
      "Previous repairs;",
      "Paintwork or body repairs;",
      "Chassis or structural repairs;",
      "Glass or windscreen damage;",
      "Tyre condition;",
      "Wheel or rim damage;",
      "Missing equipment or accessories;",
      "Missing keys;",
      "Service requirements;",
      "Incomplete or irregular service history;",
      "Modifications;",
      "Non-standard components;",
      "Previous insurance claims;",
      "Security or tracking-related issues;",
      "Any other defect or circumstance which may reasonably affect the value of the vehicle.",
    ],
  },
  {
    n: "3",
    heading: "Reconditioning Declaration",
    paragraphs: [
      "All reconditioning (\"Recon\") required on the vehicle must be accurately declared when the vehicle is submitted for valuation.",
      "Any estimated cost of Recon supplied by the Dealer must reasonably provide for the work to be completed to an appropriate OEM or OEM-approved standard, where applicable.",
      "Fourbuy will not be bound by a Dealer's estimate of the cost of repairing or reconditioning the vehicle.",
      "Where an inspection identifies additional Recon, damage, defects or required repairs which were not disclosed, or where the actual reasonable cost of such work materially exceeds the information submitted by the Dealer, Fourbuy reserves the right to:",
    ],
    bullets: [
      "Amend the Cover Price;",
      "Deduct the reasonable additional Recon cost from the Cover Price; or",
      "Withdraw the Cover entirely.",
    ],
  },
  {
    n: "4",
    heading: "Mileage",
    paragraphs: [
      "The vehicle's odometer reading at final inspection may not exceed the mileage declared when the vehicle was submitted for valuation by more than 500 kilometres.",
      "Where the mileage differs by more than 500 kilometres, Fourbuy reserves the right to reassess, amend or withdraw the Cover Price.",
      "Any indication or suspicion of mileage manipulation, odometer replacement, mileage discrepancy or inconsistent mileage history must be disclosed to Fourbuy immediately.",
      "Fourbuy reserves the right to withdraw the Cover where it has reasonable concerns regarding the accuracy or integrity of the vehicle's recorded mileage.",
    ],
  },
  {
    n: "5",
    heading: "Subject to Final Vehicle Inspection",
    paragraphs: [
      "Every Cover Price is Subject to View.",
      "Before Fourbuy is obliged to proceed with the purchase, the vehicle must successfully complete a final inspection.",
      "The Dealer may elect to:",
    ],
    bullets: [
      "5.1 Fourbuy Inspection — Present the vehicle for inspection at the nominated Fourbuy dealership in Fourways, Johannesburg; or",
      "5.2 VIEW4YOU Inspection — Request an inspection through VIEW4YOU, which will be coordinated by Fourbuy Car Buying Co.",
    ],
    // Note: extra explanatory paragraphs after the bullets are rendered as
    // a second paragraph block via the concatenation below in the modal.
  },
  {
    n: "5 (cont.)",
    heading: "",
    paragraphs: [
      "Unless otherwise agreed in writing, the cost of a VIEW4YOU inspection requested as an alternative to presenting the vehicle to Fourbuy shall be for the Dealer's account.",
      "The purpose of the inspection is to confirm that the vehicle materially corresponds with the information upon which the Cover Price was calculated.",
      "Successful completion of an inspection does not prevent Fourbuy from subsequently identifying or investigating documentation, ownership, history, identity or other anomalies.",
    ],
  },
  {
    n: "6",
    heading: "Additional or Specialist Inspection",
    paragraphs: [
      "Fourbuy Car Buying Co. reserves the right, at its discretion, to require a vehicle to undergo an additional or specialist inspection where Fourbuy believes further investigation is reasonably required. This may include inspection by:",
    ],
    bullets: [
      "An authorised OEM dealership;",
      "An OEM-approved repairer;",
      "An approved mechanical workshop;",
      "An approved body repair facility;",
      "A diagnostic specialist; or",
      "Another suitably qualified specialist.",
    ],
  },
  {
    n: "6 (cont.)",
    heading: "",
    paragraphs: [
      "Where Fourbuy independently requires such an additional inspection after the standard inspection process, the reasonable cost of that inspection will be for Fourbuy's account, unless the parties agree otherwise in writing.",
      "The Cover will remain conditional pending the outcome of such inspection.",
    ],
  },
  {
    n: "7",
    heading: "Required Ownership and Dealer Documentation",
    paragraphs: [
      "A Cover Price is conditional upon Fourbuy receiving and approving all documentation reasonably required to verify the vehicle's ownership, provenance and the Dealer's lawful entitlement to sell the vehicle. Documentation shall include, where applicable:",
      "7.1 Tax Invoice — A valid Tax Invoice must be generated by the same legal Dealer entity to which the Cover Price was issued. The invoice may not be issued by a different dealership, related company, associated company, holding company, subsidiary, director, shareholder or third party without Fourbuy's prior written approval.",
      "7.2 Dealer-Stocked NaTIS Documentation — The vehicle must have the appropriate dealer-stocked NaTIS documentation reflecting the same legal entity that submitted the vehicle to Fourbuy for Cover, unless Fourbuy has approved an alternative arrangement in writing.",
      "7.3 Proof of Ownership — Fourbuy may require supporting documentation establishing the chain of ownership of the vehicle. This may include:",
    ],
    bullets: [
      "Previous purchase invoices;",
      "Proof of payment;",
      "Bank settlement documentation;",
      "Finance settlement letters;",
      "NaTIS documents;",
      "Dealer stock records;",
      "Franchise dealer invoices;",
      "Auction documentation; and",
      "Any other documentation reasonably required by Fourbuy.",
    ],
  },
  {
    n: "7 (cont.)",
    heading: "",
    paragraphs: [
      "Where requested, the Dealer must be able to demonstrate a reasonable and legitimate ownership trail back to the previous registered owner, franchise dealer, financial institution or other lawful source of the vehicle.",
    ],
  },
  {
    n: "8",
    heading: "Title, Ownership and Encumbrances",
    paragraphs: [
      "The Dealer warrants that it is lawfully entitled to sell the vehicle to Fourbuy. Unless specifically disclosed to and accepted by Fourbuy in writing, the vehicle must:",
    ],
    bullets: [
      "Be free from undisclosed finance or encumbrances;",
      "Not be subject to any ownership dispute;",
      "Not be subject to a third-party claim;",
      "Not have been unlawfully acquired;",
      "Not be stolen or suspected stolen;",
      "Not contain altered, substituted or tampered identification particulars;",
      "Not have any undisclosed police, insurance or financial interest attached to it; and",
      "Be capable of lawful transfer to Fourbuy.",
    ],
  },
  {
    n: "8 (cont.)",
    heading: "",
    paragraphs: [
      "Fourbuy may suspend or withdraw a Cover immediately should any concern arise regarding ownership, title, identity, VIN, engine number, NaTIS documentation or provenance.",
    ],
  },
  {
    n: "9",
    heading: "Vehicle History and Third-Party Reports",
    paragraphs: [
      "The Cover Price is calculated on the basis of the information provided by the Dealer during the valuation process.",
      "Unless expressly confirmed otherwise by Fourbuy, issuing a Cover Price does not mean that Fourbuy has reviewed or relied upon any third-party vehicle history, insurance, accident, finance, OEM, HPI, VIN, service history or similar report that may have been ordered or obtained in relation to the vehicle.",
      "The Dealer remains responsible for ensuring that the vehicle description supplied to Fourbuy accurately corresponds with any material findings contained in such reports.",
      "Should a subsequent report disclose information materially inconsistent with the valuation submitted to Fourbuy, Fourbuy reserves the right to:",
    ],
    bullets: [
      "Request further information;",
      "Require an additional inspection;",
      "Recalculate the Cover Price; or",
      "Withdraw the Cover.",
    ],
  },
  {
    n: "10",
    heading: "Accident Damage and Previous Repairs",
    paragraphs: [
      "Any known or suspected accident damage must be fully disclosed when the vehicle is submitted for valuation.",
      "Where a vehicle has previously sustained accident, structural or material body damage, Fourbuy may require supporting documentation including, where available:",
    ],
    bullets: [
      "Repair quotations;",
      "Repair invoices;",
      "Insurance assessments;",
      "Photographs of the damage;",
      "Photographs of repairs;",
      "OEM repair documentation;",
      "Approved body repairer documentation;",
      "Structural measurement reports; and",
      "Any other relevant documentation.",
    ],
  },
  {
    n: "10 (cont.)",
    heading: "",
    paragraphs: [
      "Fourbuy must be reasonably satisfied that material accident or structural repairs were carried out to an acceptable standard and, where applicable, in accordance with relevant OEM repair procedures.",
      "Failure to disclose known previous accident damage or material repairs shall constitute grounds for Fourbuy to amend or withdraw its Cover.",
    ],
  },
  {
    n: "11",
    heading: "OEM and Vehicle History Anomalies",
    paragraphs: [
      "Where an OEM, manufacturer, vehicle history or other recognised report contains dates, records or events which are inconsistent with the vehicle's declared date of first registration, model year, mileage, ownership history or other vehicle particulars, Fourbuy may require further investigation.",
      "Where an OEM-reported date predates the date of first registration in circumstances that create an unexplained or material anomaly in the history or identity of the vehicle, Fourbuy reserves the right to withdraw the Cover.",
      "The Dealer will be afforded an opportunity, where reasonably appropriate, to provide supporting documentation explaining the discrepancy.",
      "Fourbuy shall retain the discretion to determine whether the explanation and supporting documentation are satisfactory for the purposes of proceeding with the purchase.",
    ],
  },
  {
    n: "12",
    heading: "Vehicle Identity",
    paragraphs: [
      "The vehicle presented for inspection and purchase must be the exact vehicle submitted for valuation. The following must correspond with the information submitted to Fourbuy:",
    ],
    bullets: [
      "VIN / chassis number;",
      "Engine number, where applicable;",
      "Registration number;",
      "Make;",
      "Model;",
      "Derivative;",
      "Model year;",
      "Colour;",
      "Specification;",
      "Mileage; and",
      "Vehicle identification documentation.",
    ],
  },
  {
    n: "12 (cont.)",
    heading: "",
    paragraphs: [
      "Any material discrepancy may result in immediate suspension or withdrawal of the Cover.",
    ],
  },
  {
    n: "13",
    heading: "Right to Revise or Withdraw Cover",
    paragraphs: [
      "Fourbuy Car Buying Co. reserves the right to revise or withdraw a Cover Price where:",
    ],
    bullets: [
      "The vehicle differs materially from the description submitted;",
      "Undisclosed Recon is identified;",
      "The condition has deteriorated after valuation;",
      "Material information was omitted;",
      "Material information supplied was inaccurate or misleading;",
      "Required documentation cannot be supplied;",
      "Ownership cannot reasonably be verified;",
      "Vehicle history anomalies are identified;",
      "Accident history was not properly disclosed;",
      "A material discrepancy appears on a third-party or OEM report;",
      "The vehicle cannot lawfully be transferred;",
      "VIN, chassis, engine or vehicle identity discrepancies arise;",
      "Mileage exceeds the permitted tolerance;",
      "The vehicle fails inspection;",
      "Fraud, misrepresentation or irregularity is reasonably suspected; or",
      "Any other material circumstance arises which means that the vehicle is not substantially as represented when the Cover Price was calculated.",
    ],
  },
  {
    n: "13 (cont.)",
    heading: "",
    paragraphs: [
      "Fourbuy may, depending on the circumstances, offer the Dealer a revised Cover Price instead of withdrawing the Cover. The Dealer will be entitled to accept or decline any revised Cover Price.",
    ],
  },
  {
    n: "14",
    heading: "Cover Validity and Expiry",
    paragraphs: [
      "Every Cover Price will have a stated validity or expiry date.",
      "All documentation required by Fourbuy must be supplied on or before the expiry date of the Cover.",
      "The vehicle must also remain materially in the same condition as described during the valuation period.",
      "If the required documentation has not been received by Fourbuy before expiry, the Cover will automatically lapse unless Fourbuy agrees in writing to extend or reinstate it.",
      "Any extension, renewal or reinstatement may be subject to a fresh valuation and/or revised Cover Price.",
    ],
  },
  {
    n: "15",
    heading: "Condition of Vehicle Until Completion",
    paragraphs: [
      "Until the transaction has been finally approved and completed, the Dealer remains responsible for the vehicle.",
      "Any material change in the vehicle's condition must immediately be disclosed to Fourbuy, including:",
    ],
    bullets: [
      "Accident damage;",
      "Mechanical failure;",
      "Warning lights;",
      "Additional mileage;",
      "Body damage;",
      "Glass damage;",
      "Tyre damage;",
      "Theft or attempted theft;",
      "Missing equipment;",
      "Loss of keys; or",
      "Any other event affecting the vehicle's condition or value.",
    ],
  },
  {
    n: "15 (cont.)",
    heading: "",
    paragraphs: [
      "Fourbuy may reassess the Cover Price following any material change.",
    ],
  },
  {
    n: "16",
    heading: "No Waiver by Inspection",
    paragraphs: [
      "The inspection of the vehicle by Fourbuy, VIEW4YOU or another third party shall not constitute a waiver of the Dealer's obligation to provide complete and accurate information.",
      "The fact that a defect, discrepancy or anomaly was not identified during an initial inspection does not prevent Fourbuy from raising that issue if it is subsequently identified before completion of the transaction.",
    ],
  },
  {
    n: "17",
    heading: "Material Misrepresentation or Non-Disclosure",
    paragraphs: [
      "The Cover Price relies substantially on information supplied by the Dealer. Any deliberate or material:",
    ],
    bullets: [
      "Misrepresentation;",
      "Non-disclosure;",
      "Incorrect declaration;",
      "Falsified documentation; or",
      "Concealment of a material vehicle defect, history issue or ownership issue",
    ],
  },
  {
    n: "17 (cont.)",
    heading: "",
    paragraphs: [
      "may result in the immediate cancellation of the Cover and/or transaction.",
      "Fourbuy reserves all rights available to it in law in circumstances involving fraud, intentional misrepresentation or falsified documentation.",
    ],
  },
  {
    n: "18",
    heading: "Final Approval",
    paragraphs: [
      "A Cover Price does not constitute an unconditional obligation on Fourbuy to purchase the vehicle. The purchase remains conditional upon:",
    ],
    bullets: [
      "The vehicle materially corresponding with its valuation;",
      "Successful completion of the required inspection;",
      "Verification and acceptance of the required documentation;",
      "Verification of ownership and vehicle identity;",
      "Fourbuy being satisfied with any vehicle history or OEM information reviewed;",
      "There being no material undisclosed defects or discrepancies;",
      "Compliance with these Terms and Conditions; and",
      "Fourbuy issuing final approval to proceed with the purchase.",
    ],
  },
  {
    n: "18 (cont.)",
    heading: "",
    paragraphs: [
      "Only once these conditions have been satisfied or expressly waived by Fourbuy in writing will the transaction proceed to final completion.",
    ],
  },
  {
    n: "19",
    heading: "Dealer Declaration",
    paragraphs: [
      "By accepting the Cover Price, the Dealer confirms and warrants that:",
    ],
    bullets: [
      "It has read and accepts these Terms and Conditions;",
      "It is authorised to act on behalf of the Dealer entity concerned;",
      "The vehicle information supplied is true, accurate and complete;",
      "All known material defects have been disclosed;",
      "All known accident or repair history has been disclosed;",
      "The declared mileage is accurate to the best of its knowledge;",
      "It is lawfully entitled to sell the vehicle;",
      "It will provide all documentation reasonably required by Fourbuy; and",
      "It understands that the Cover remains Subject to View and final verification.",
    ],
  },
  {
    n: "20",
    heading: "Electronic Acceptance",
    paragraphs: [
      "Acceptance of the Cover Price electronically through the Fourbuy Car Buying Co. website, application or other approved electronic process shall constitute the Dealer's acceptance of these Terms and Conditions.",
      "The person accepting the Cover warrants that he or she has the necessary authority to accept these Terms and Conditions on behalf of the relevant Dealer entity.",
    ],
  },
];

// Final acceptance declaration shown BELOW the numbered clauses, both
// in the modal footer and in the eventual "I agree" acceptance flow.
export const COVER_OFFER_ACCEPTANCE_DECLARATION =
  "By selecting \"Accept Cover\", I confirm that I am authorised to act on behalf of the Dealer, that the vehicle has been fully and accurately described, and that I have read, understood and agree to the Fourbuy Car Buying Co. Subject to View Cover Offer Terms & Conditions. I understand that the Cover Price remains subject to inspection, document verification, vehicle history verification and final approval by Fourbuy Car Buying Co.";
