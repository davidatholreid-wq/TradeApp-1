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

/**
 * Compute the elapsed time (months) and mileage delta between the last-service
 * datapoint on a submission and today's data. Returns null slots when inputs
 * are missing or nonsensical.
 *
 * `lastServiceDate` is expected in "YYYY-MM" format (the MonthYearPicker's
 * canonical output). Non-parseable / "TBC" values are ignored.
 */
export function computeServiceGap(
  lastServiceDate?: string | null,
  lastServiceMileage?: number | null,
  currentMileage?: number | null,
): { monthsAgo: number | null; kmSince: number | null } {
  const out: { monthsAgo: number | null; kmSince: number | null } = {
    monthsAgo: null,
    kmSince: null,
  };
  if (lastServiceDate && lastServiceDate !== "TBC") {
    const m = /^(\d{4})-(\d{2})/.exec(lastServiceDate);
    if (m) {
      const year = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      if (!isNaN(year) && !isNaN(month)) {
        const now = new Date();
        const months =
          (now.getFullYear() - year) * 12 + (now.getMonth() + 1 - month);
        out.monthsAgo = Math.max(0, months);
      }
    }
  }
  if (
    typeof lastServiceMileage === "number" &&
    typeof currentMileage === "number" &&
    lastServiceMileage > 0
  ) {
    out.kmSince = Math.max(0, currentMileage - lastServiceMileage);
  }
  return out;
}

/**
 * Render an elapsed-months count in human terms:
 *   0  -> "This month"
 *   1-11 -> "N month(s) ago"
 *   12+ -> "Xy Ym ago" (or "N years ago" when clean)
 */
export function formatMonthsAgo(months: number | null | undefined): string {
  if (months == null || Number.isNaN(months)) return "—";
  const m = Math.max(0, Math.round(months));
  if (m === 0) return "This month";
  if (m < 12) return `${m} month${m === 1 ? "" : "s"} ago`;
  const y = Math.floor(m / 12);
  const rem = m % 12;
  if (rem === 0) return `${y} year${y === 1 ? "" : "s"} ago`;
  return `${y}y ${rem}m ago`;
}
