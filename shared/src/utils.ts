import { CSVRow } from './types';

/**
 * Clean ID values by removing commas
 */
export function cleanId(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = String(value).trim().replace(/,/g, '');
  return cleaned || null;
}

/**
 * Parse CSV row and extract rid/zone/space, cleaning IDs
 */
export function parseCSVRow(row: Record<string, any>): CSVRow {
  return {
    rid: cleanId(row.rid || row.location_id),
    zone: cleanId(row.zone || row.parking_payment_zone_id),
    space: cleanId(row.space || row.location_space_id),
  };
}

/**
 * Check if row has required fields
 */
export function hasRequiredFields(row: CSVRow): boolean {
  return !!(row.rid || row.zone);
}
