import { getFirestore, Collections } from "../db/firestore.ts";
import { createPickerSession as createPickerSessionInDb, getPickerSession, updatePickerSession, deleteExpiredPickerSessions } from "../db/helpers-firestore.ts";
import type { PickerSession } from "../db/types.ts";

const PICKER_API_BASE = "https://photospicker.googleapis.com/v1";

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
export async function createPickerSession(accessToken: string, userId: string): Promise<PickerSession> {
  // Clean up expired sessions first
  await cleanupExpiredSessions();

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
  const pollingConfig = data.pollingConfig ? JSON.stringify(data.pollingConfig) : null;

  // Append /autoclose to pickerUri to automatically close after selection
  const pickerUri = data.pickerUri + "/autoclose";

  const sessionId = await createPickerSessionInDb({
    user_id: userId,
    picker_session_id: data.id,
    picker_uri: pickerUri,
    media_items_set: false,
    polling_config: pollingConfig ?? undefined,
    expire_time: data.expireTime || null,
  });

  const result = await getPickerSession(sessionId);

  console.log(`✅ Created picker session: ${data.id}`);

  return result!;
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
 * Get picker session from database by picker_session_id
 */
export async function getPickerSessionFromDb(sessionId: string): Promise<PickerSession | null> {
  // Need to query by picker_session_id, not document ID
  const db = getFirestore();
  const snapshot = await db.collection(Collections.PICKER_SESSIONS).where("picker_session_id", "==", sessionId).limit(1).get();

  if (snapshot.empty) {
    return null;
  }

  return snapshot.docs[0].data() as PickerSession;
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

  const response = await fetch(`${PICKER_API_BASE}/mediaItems?${params}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

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
export async function getAllMediaItems(accessToken: string, pickerSessionId: string): Promise<PickedMediaItem[]> {
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
 * @param pickerSessionId - The picker_session_id field (not document ID)
 */
export async function deletePickerSession(pickerSessionId: string): Promise<boolean> {
  const session = await getPickerSessionFromDb(pickerSessionId);
  if (!session) {
    return false;
  }

  const db = getFirestore();
  await db.collection(Collections.PICKER_SESSIONS).doc(session.id).delete();
  console.log(`🗑️  Deleted picker session: ${pickerSessionId}`);
  return true;
}

/**
 * Clean up expired picker sessions based on their actual expireTime
 */
export async function cleanupExpiredSessions(): Promise<void> {
  await deleteExpiredPickerSessions();
}

/**
 * Download media item from Google Photos
 * @param accessToken - OAuth 2.0 access token (required for Picker API baseUrl)
 * @param baseUrl - Base URL from media item
 * @param width - Optional width for download (default: original)
 * @param height - Optional height for download (default: original)
 */
export async function downloadMediaItem(accessToken: string, baseUrl: string, width?: number, height?: number): Promise<Uint8Array> {
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
