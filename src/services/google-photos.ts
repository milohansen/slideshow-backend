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

export interface MediaItem {
  mediaItemId: string;
  filename: string;
  mediaType: "IMAGE" | "VIDEO";
  mimeType: string;
  baseUrl: string;
  productUrl: string;
  mediaMetadata: {
    creationTime: string;
    width: string;
    height: string;
    photo?: {
      cameraMake?: string;
      cameraModel?: string;
      focalLength?: number;
      apertureFNumber?: number;
      isoEquivalent?: number;
    };
  };
}

/**
 * Create a new Google Photos Picker session
 */
export async function createPickerSession(
  accessToken: string,
  userId: string
): Promise<PickerSession> {
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

  const result = db.prepare(`
    INSERT INTO picker_sessions (user_id, picker_session_id, picker_uri, media_items_set, polling_config)
    VALUES (?, ?, ?, ?, ?)
    RETURNING *
  `).get(
    userId,
    data.id,
    data.pickerUri,
    false,
    pollingConfig
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

  return await response.json();
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
  mediaItems: MediaItem[];
  nextPageToken?: string;
}> {
  const params = new URLSearchParams({
    pageSize: pageSize.toString(),
  });

  if (pageToken) {
    params.set("pageToken", pageToken);
  }

  const response = await fetch(
    `${PICKER_API_BASE}/sessions/${pickerSessionId}/mediaItems?${params}`,
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
): Promise<MediaItem[]> {
  const allItems: MediaItem[] = [];
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
 * Download media item from Google Photos
 * @param baseUrl - Base URL from media item
 * @param width - Optional width for download (default: original)
 * @param height - Optional height for download (default: original)
 */
export async function downloadMediaItem(
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

  const response = await fetch(downloadUrl);

  if (!response.ok) {
    throw new Error(`Failed to download media: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}
