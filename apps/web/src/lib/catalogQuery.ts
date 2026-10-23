/**
 * Catalog filter → query string building (GET /api/catalog).
 *
 * The server accepts `device_type`, `vendor` and `q` (substring on
 * name/model); empty/whitespace filters are dropped so the request stays
 * cache-friendly and the server-side "non-empty string" checks never see
 * blank values.
 */

export interface CatalogFilters {
  q?: string;
  deviceType?: string;
  vendor?: string;
}

/**
 * Build the query string for the catalog list endpoint. Returns either an
 * empty string (no filters) or a string starting with `?`.
 */
export function buildCatalogQuery(filters: CatalogFilters): string {
  const params = new URLSearchParams();
  const deviceType = filters.deviceType?.trim();
  const vendor = filters.vendor?.trim();
  const q = filters.q?.trim();
  if (deviceType) params.set('device_type', deviceType);
  if (vendor) params.set('vendor', vendor);
  if (q) params.set('q', q);
  const query = params.toString();
  return query.length > 0 ? `?${query}` : '';
}
