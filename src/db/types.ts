import { Timestamp } from "@google-cloud/firestore";

/**
 * TypeScript types for Firestore documents
 * 
 * Note: Firestore automatically adds timestamps as Timestamp objects,
 * but we'll handle them as ISO strings in the application layer
 */

export type Blob = {
  hash: string; // Used as document ID
  storage_path: string;
  width: number;
  height: number;
  aspect_ratio: number;
  orientation: "portrait" | "landscape" | "square";
  file_size?: number;
  mime_type?: string;
  color_palette?: string; // JSON string
  color_source?: string;
  blurhash?: string;
  exif_data?: string; // JSON string
  created_at: string; // ISO timestamp
};

export type Source = {
  id: string; // Document ID
  user_id?: string;
  blob_hash?: string;
  origin: "google_photos" | "upload" | "url";
  external_id?: string;
  status: "staged" | "processing" | "ready" | "failed";
  status_message?: string;
  staging_path?: string;
  ingested_at: string; // ISO timestamp
  processed_at?: string; // ISO timestamp
};

export type LayoutType = "monotych" | "diptych" | "triptych";
export type Orientation = "portrait" | "landscape" | "square";

export type DeviceVariant = {
  id: string; // Document ID
  device: string; // Device ID
  blob_hash: string;
  width: number;
  height: number;
  orientation: Orientation;
  layout_type: LayoutType;
  storage_path: string;
  file_size?: number;
  processed_at: string; // ISO timestamp
};

export type Device = {
  id: string; // Document ID
  name: string;
  width: number;
  height: number;
  orientation: Orientation;
  layouts?: string; // JSON string
  gap: number;
  capabilities?: string; // JSON string
  version?: string;
  created_at: string; // ISO timestamp
  last_seen?: string; // ISO timestamp
};

export type DeviceQueueState = {
  device_id: string; // Document ID
  queue_data: string; // JSON string
  current_index: number;
  updated_at: string; // ISO timestamp
};

export type AuthSession = {
  id: string; // Document ID
  user_id: string;
  email?: string;
  name?: string;
  picture?: string;
  access_token: string;
  refresh_token?: string;
  token_expiry: string; // ISO timestamp
  created_at: string; // ISO timestamp
};

export type PickerSession = {
  id: string; // Document ID
  user_id: string;
  picker_session_id: string;
  picker_uri: string;
  media_items_set: boolean;
  polling_config?: string; // JSON string
  expire_time?: string; // ISO timestamp
  created_at: string; // ISO timestamp
};

export type FailedTask = {
  id: string; // Document ID
  task_name: string;
  image_id?: string;
  payload: string; // JSON string
  error_message?: string;
  attempt_count: number;
  last_attempt: string; // ISO timestamp
  created_at: string; // ISO timestamp
};

/**
 * Helper to convert Firestore Timestamp to ISO string
 */
export function timestampToISO(timestamp: Timestamp | string | undefined): string | undefined {
  if (!timestamp) {
    return undefined;
  }
  if (typeof timestamp === "string") {
    return timestamp;
  }
  return timestamp.toDate().toISOString();
}

/**
 * Helper to convert ISO string to Firestore Timestamp
 */
export function isoToTimestamp(iso: string | undefined): Timestamp | undefined {
  if (!iso) {
    return undefined;
  }
  return Timestamp.fromDate(new Date(iso));
}

/**
 * Get current timestamp as ISO string
 */
export function nowISO(): string {
  return new Date().toISOString();
}
