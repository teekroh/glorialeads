/**
 * Parses optional Verify "address correction" lines.
 * Expects a trailing ", ST 12345" or ", ST 12345-6789" so multi-part street/city strings work:
 * e.g. "123 Main St, Philadelphia, PA 19103".
 */
export function parseVerifyAddressCorrection(raw: string): { city: string; state: string; zip: string } | null {
  const t = raw.trim();
  if (!t) return null;
  const m = t.match(/,\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/);
  if (!m || m.index === undefined) return null;
  const city = t.slice(0, m.index).trim();
  if (!city) return null;
  return { city, state: m[1].toUpperCase(), zip: m[2] };
}
