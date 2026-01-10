import { getDb } from "../db/schema.ts";

const PICKER_API_BASE = "https://photospicker.googleapis.com/v1";

export interface PickerSession {
  id: string;
  user_id: string;
  picker_session_id: string;
  picker_uri: string;
  media_items_set: boolean;
  polling_config: string | null;
  created_at: string;
}

type PhotoMetadata = {
  focalLength?: number;
  apertureFNumber?: number;
  isoEquivalent?: number;
  exposureTime?: string;
};

type VideoMetadata = {
  fps?: number;
  processingStatus?: "UNSPECIFIED" | "PROCESSING" | "READY" | "FAILED";
};

type MediaFileMetadata = {
  width: number;
  height: number;
  cameraMake?: string;
  cameraModel?: string;
  photoMetadata?: PhotoMetadata;
  videoMetadata?: VideoMetadata;
};

type MediaFile = {
  baseUrl: string;
  mimeType: string;
  filename: string;
  mediaFileMetadata: MediaFileMetadata;
};

export type PickedMediaItem = {
  id: string;
  createTime: string;
  type: "TYPE_UNSPECIFIED" | "PHOTO" | "VIDEO";
  mediaFile: MediaFile;
};

/**
 * Create a new Google Photos Picker session
 */
export async function createPickerSession(
  accessToken: string,
  userId: string
): Promise<PickerSession> {
  // Clean up expired sessions first
  cleanupExpiredSessions();
  
  const response = await fetch(`${PICKER_API_BASE}/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}), // Empty body creates default session
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create picker session: ${response.status} ${error}`);
  }

  const data = await response.json();

  // Store session in database
  const db = getDb();
  const pollingConfig = data.pollingConfig ? JSON.stringify(data.pollingConfig) : null;
  
  // Append /autoclose to pickerUri to automatically close after selection
  const pickerUri = data.pickerUri + '/autoclose';

  const result = db.prepare(`
    INSERT INTO picker_sessions (user_id, picker_session_id, picker_uri, media_items_set, polling_config, expire_time)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING *
  `).get(
    userId,
    data.id,
    pickerUri,
    false,
    pollingConfig,
    data.expireTime || null
  ) as PickerSession;

  console.log(`✅ Created picker session: ${data.id}`);

  return result;
}

/**
 * Get picker session status from Google Photos API
 */
export async function getPickerSessionStatus(
  accessToken: string,
  pickerSessionId: string
): Promise<{
  id: string;
  pickerUri: string;
  mediaItemsSet: boolean;
  pollingConfig?: {
    pollInterval: string;
    longPollTimeout: string;
  };
}> {
  const response = await fetch(`${PICKER_API_BASE}/sessions/${pickerSessionId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get picker session: ${response.status} ${error}`);
  }

  const result = await response.json();
  console.log(`📊 Session status for ${pickerSessionId}:`, result);
  
  return result;
}

/**
 * Update local picker session status
 */
export function updatePickerSession(
  sessionId: string,
  mediaItemsSet: boolean
): void {
  const db = getDb();
  db.prepare(`
    UPDATE picker_sessions
    SET media_items_set = ?
    WHERE picker_session_id = ?
  `).run(mediaItemsSet, sessionId);
}

/**
 * Get picker session from database
 */
export function getPickerSessionFromDb(sessionId: string): PickerSession | null {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM picker_sessions WHERE picker_session_id = ?
  `).get(sessionId) as PickerSession | undefined || null;
}

/**
 * List media items from a picker session
 */
export async function listMediaItems(
  accessToken: string,
  pickerSessionId: string,
  pageSize = 100,
  pageToken?: string
): Promise<{
  mediaItems: PickedMediaItem[];
  nextPageToken?: string;
}> {
  const params = new URLSearchParams({
    sessionId: pickerSessionId,
    pageSize: pageSize.toString(),
  });

  if (pageToken) {
    params.set("pageToken", pageToken);
  }

  const response = await fetch(
    `${PICKER_API_BASE}/mediaItems?${params}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to list media items: ${response.status} ${error}`);
  }

  const data = await response.json();
  console.log("listMediaItems", "data", data);

  return {
    mediaItems: data.mediaItems || [],
    nextPageToken: data.nextPageToken,
  };
}

/**
 * Get all media items from a picker session (handles pagination)
 */
export async function getAllMediaItems(
  accessToken: string,
  pickerSessionId: string
): Promise<PickedMediaItem[]> {
  const allItems: PickedMediaItem[] = [];
  let pageToken: string | undefined;

  do {
    const result = await listMediaItems(accessToken, pickerSessionId, 100, pageToken);
    allItems.push(...result.mediaItems);
    pageToken = result.nextPageToken;
  } while (pageToken);

  console.log(`📸 Retrieved ${allItems.length} media items from picker session`);

  return allItems;
}

/**
 * Delete a specific picker session from the database
 */
export function deletePickerSession(pickerSessionId: string): boolean {
  const db = getDb();
  
  const result = db.prepare(`
    DELETE FROM picker_sessions 
    WHERE picker_session_id = ?
  `).run(pickerSessionId);
  
  if (result.changes > 0) {
    console.log(`🗑️  Deleted picker session: ${pickerSessionId}`);
    return true;
  }
  
  return false;
}

/**
 * Clean up expired picker sessions based on their actual expireTime
 */
export function cleanupExpiredSessions(): number {
  const db = getDb();
  const now = new Date().toISOString();
  
  const result = db.prepare(`
    DELETE FROM picker_sessions 
    WHERE expire_time IS NOT NULL AND expire_time < ?
  `).run(now);
  
  if (result.changes > 0) {
    console.log(`🧹 Cleaned up ${result.changes} expired picker sessions`);
  }
  
  return result.changes;
}

/**
 * Download media item from Google Photos
 * @param accessToken - OAuth 2.0 access token (required for Picker API baseUrl)
 * @param baseUrl - Base URL from media item
 * @param width - Optional width for download (default: original)
 * @param height - Optional height for download (default: original)
 */
export async function downloadMediaItem(
  accessToken: string,
  baseUrl: string,
  width?: number,
  height?: number
): Promise<Uint8Array> {
  let downloadUrl = baseUrl;

  // Add download parameters
  // Format: =w{width}-h{height} or =d for original
  if (width && height) {
    downloadUrl = `${baseUrl}=w${width}-h${height}`;
  } else {
    downloadUrl = `${baseUrl}=d`; // Download original
  }

  const response = await fetch(downloadUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download media: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}
