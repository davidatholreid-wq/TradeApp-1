/**
 * Build a WhatsApp deep-link that works on iOS, Android and Web.
 * Handles South African phone numbers: strips non-digits, converts leading 0 -> 27.
 */
export function buildWhatsappUrl(phone: string, message: string): string {
  const digits = (phone || "").replace(/\D/g, "");
  let intl = digits;
  if (intl.startsWith("0")) intl = "27" + intl.slice(1);
  else if (intl.startsWith("27")) intl = intl;
  else if (intl.length === 9) intl = "27" + intl; // already stripped leading 0
  return `https://wa.me/${intl}?text=${encodeURIComponent(message)}`;
}

export function buildDealerMessage(opts: {
  dealerFirstName?: string;
  reference?: string;
  year: number;
  make: string;
  model: string;
  derivative: string;
  price?: number | null;
  priceNotes?: string | null;
}): string {
  const name = opts.dealerFirstName ? `Hi ${opts.dealerFirstName},` : "Hi,";
  const ref = opts.reference ? `${opts.reference} — ` : "";
  const car = `${ref}${opts.year} ${opts.make} ${opts.model} ${opts.derivative}`.trim();
  const parts = [name, `regarding ${car}.`];
  if (opts.price != null) {
    parts.push(`Our offer is R ${opts.price.toLocaleString()}.`);
    if (opts.priceNotes) parts.push(opts.priceNotes);
  } else {
    parts.push("We're finalising a price for you shortly.");
  }
  parts.push("— TRADE AI powered by FOURBUY");
  return parts.join(" ");
}
