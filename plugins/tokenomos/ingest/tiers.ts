// Maps provider-reported service tiers to pricing tiers (PLAN §3.3).
// Unknown values pass through unchanged and are left unpriced by pricing/price.ts.
const TIERS: Record<string, string> = {
  "": "standard",
  default: "standard",
  standard: "standard",
  auto: "standard",
  fast: "fast",
  priority: "fast",
  flex: "flex",
  batch: "batch",
  ultrafast: "ultrafast",
};

export function normaliseTier(raw: string | null | undefined): string {
  const key = (raw ?? "").trim().toLowerCase();
  return TIERS[key] ?? key;
}
