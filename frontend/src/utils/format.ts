// Central number formatting helpers. Uses en-ZA locale so we always get
// comma-separated thousands (e.g. "1,234,567") regardless of the device
// locale. All price renders in the app should route through here for
// consistency.

const zar = new Intl.NumberFormat("en-ZA", {
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

const zarDecimal = new Intl.NumberFormat("en-ZA", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

/** Format a rand value as "R 1,234,567" (no decimals). */
export function formatZAR(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "R 0";
  return `R ${zar.format(Math.round(n))}`;
}

/** Format a rand value with two decimals, e.g. "R 1,234.50". */
export function formatZARDecimal(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "R 0.00";
  return `R ${zarDecimal.format(n)}`;
}

/** Format any number with thousands separators (no currency symbol). */
export function formatNumber(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "0";
  return zar.format(n);
}

/** Format a kilometre reading, e.g. "23,000 km". */
export function formatKm(n: number | null | undefined): string {
  return `${formatNumber(n)} km`;
}
