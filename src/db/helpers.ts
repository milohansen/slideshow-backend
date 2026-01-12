import { getDb } from "./schema.ts";

/**
 * Database helper functions for the new schema (blobs, sources, device_variants)
 */

export interface Blob {
  hash: string;
  storage_path: string;
  width: number;
  height: number;
  aspect_ratio: number;
  orientation: "portrait" | "landscape" | "square";
  file_size?: number;
  mime_type?: string;
  color_palette?: string;
  color_source?: string;
  blurhash?: string;
  exif_data?: string;
  created_at: string;
}

export interface Source {
  id: string;
  user_id?: string;
  blob_hash?: string;
  origin: "google_photos" | "upload" | "url";
  external_id?: string;
  status: "staged" | "processing" | "ready" | "failed";
  status_message?: string;
  staging_path?: string;
  ingested_at: string;
  processed_at?: string;
}

export interface DeviceVariant {
  id: string;
  blob_hash: string;
  width: number;
  height: number;
  orientation: "portrait" | "landscape";
  storage_path: string;
  file_size?: number;
  processed_at: string;
}

/**
 * Check if a blob exists by hash
 */
export function blobExists(hash: string): boolean {
  const db = getDb();
  const result = db.prepare("SELECT 1 FROM blobs WHERE hash = ?").get(hash);
  return result !== undefined;
}

/**
 * Get blob by hash
 */
export function getBlob(hash: string): Blob | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM blobs WHERE hash = ?").get(hash) as Blob | undefined;
}

/**
 * Create a new blob record
 */
export function createBlob(blob: Omit<Blob, "created_at">): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO blobs (
      hash, storage_path, width, height, aspect_ratio, orientation,
      file_size, mime_type, color_palette, color_source, blurhash, exif_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    blob.hash,
    blob.storage_path,
    blob.width,
    blob.height,
    blob.aspect_ratio,
    blob.orientation,
    blob.file_size,
    blob.mime_type,
    blob.color_palette,
    blob.color_source,
    blob.blurhash,
    blob.exif_data
  );
}

/**
 * Update blob color data
 */
export function updateBlobColors(hash: string, colorPalette: string, colorSource: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE blobs 
    SET color_palette = ?, color_source = ?
    WHERE hash = ?
  `).run(colorPalette, colorSource, hash);
}

/**
 * Create a new source record
 */
export function createSource(source: Omit<Source, "ingested_at">): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO sources (
      id, user_id, blob_hash, origin, external_id, 
      status, status_message, staging_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    source.id,
    source.user_id,
    source.blob_hash,
    source.origin,
    source.external_id,
    source.status,
    source.status_message,
    source.staging_path
  );
}

/**
 * Update source status
 */
export function updateSourceStatus(
  id: string,
  status: Source["status"],
  statusMessage?: string,
  blobHash?: string
): void {
  const db = getDb();
  const processedAt = status === "ready" ? new Date().toISOString() : null;
  
  db.prepare(`
    UPDATE sources 
    SET status = ?, 
        status_message = ?,
        blob_hash = COALESCE(?, blob_hash),
        processed_at = COALESCE(?, processed_at)
    WHERE id = ?
  `).run(status, statusMessage, blobHash, processedAt, id);
}

/**
 * Get sources by status
 */
export function getSourcesByStatus(status: Source["status"], limit?: number): Source[] {
  const db = getDb();
  const query = limit
    ? "SELECT * FROM sources WHERE status = ? LIMIT ?"
    : "SELECT * FROM sources WHERE status = ?";
  
  return limit
    ? db.prepare(query).all(status, limit) as Source[]
    : db.prepare(query).all(status) as Source[];
}

/**
 * Get source by ID
 */
export function getSource(id: string): Source | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as Source | undefined;
}

/**
 * Create a device variant
 */
export function createDeviceVariant(variant: Omit<DeviceVariant, "id" | "processed_at">): string {
  const db = getDb();
  const id = crypto.randomUUID();
  
  db.prepare(`
    INSERT INTO device_variants (
      id, blob_hash, width, height, orientation, storage_path, file_size
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    variant.blob_hash,
    variant.width,
    variant.height,
    variant.orientation,
    variant.storage_path,
    variant.file_size
  );
  
  return id;
}

/**
 * Get device variant by blob hash and dimensions
 */
export function getDeviceVariant(
  blobHash: string,
  width: number,
  height: number
): DeviceVariant | undefined {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM device_variants 
    WHERE blob_hash = ? AND width = ? AND height = ?
  `).get(blobHash, width, height) as DeviceVariant | undefined;
}

/**
 * Get all device variants for a blob
 */
export function getDeviceVariantsForBlob(blobHash: string): DeviceVariant[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM device_variants WHERE blob_hash = ?
  `).all(blobHash) as DeviceVariant[];
}

/**
 * Get unique device dimensions that have processed variants
 */
export function getActiveDeviceDimensions(): Array<{ width: number; height: number; orientation: string }> {
  const db = getDb();
  return db.prepare(`
    SELECT DISTINCT width, height, orientation 
    FROM device_variants 
    ORDER BY width DESC, height DESC
  `).all() as Array<{ width: number; height: number; orientation: string }>;
}

/**
 * Check if a device variant exists for given dimensions
 */
export function deviceVariantExists(blobHash: string, width: number, height: number): boolean {
  const db = getDb();
  const result = db.prepare(`
    SELECT 1 FROM device_variants 
    WHERE blob_hash = ? AND width = ? AND height = ?
  `).get(blobHash, width, height);
  return result !== undefined;
}

/**
 * Get all sources linked to a specific blob (for duplicate handling)
 */
export function getSourcesForBlob(blobHash: string): Source[] {
  const db = getDb();
  return db.prepare("SELECT * FROM sources WHERE blob_hash = ?").all(blobHash) as Source[];
}

/**
 * Count sources by status
 */
export function countSourcesByStatus(): Record<string, number> {
  const db = getDb();
  const results = db.prepare(`
    SELECT status, COUNT(*) as count 
    FROM sources 
    GROUP BY status
  `).all() as Array<{ status: string; count: number }>;
  
  return results.reduce((acc, { status, count }) => {
    acc[status] = count;
    return acc;
  }, {} as Record<string, number>);
}
