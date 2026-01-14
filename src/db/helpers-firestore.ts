import { getFirestore, Collections } from "./firestore.ts";
import type {
  Blob,
  Source,
  DeviceVariant,
  Device,
  DeviceQueueState,
  AuthSession,
  PickerSession,
  FailedTask,
} from "./types.ts";
import { nowISO } from "./types.ts";

/**
 * Database helper functions for Firestore
 */

// ========== Blob Operations ==========

/**
 * Check if a blob exists by hash
 */
export async function blobExists(hash: string): Promise<boolean> {
  const db = getFirestore();
  const doc = await db.collection(Collections.BLOBS).doc(hash).get();
  return doc.exists;
}

/**
 * Get blob by hash
 */
export async function getBlob(hash: string): Promise<Blob | undefined> {
  const db = getFirestore();
  const doc = await db.collection(Collections.BLOBS).doc(hash).get();
  
  if (!doc.exists) {
    return undefined;
  }
  
  return doc.data() as Blob;
}

/**
 * Create a new blob record
 */
export async function createBlob(blob: Omit<Blob, "created_at">): Promise<void> {
  const db = getFirestore();
  await db.collection(Collections.BLOBS).doc(blob.hash).set({
    ...blob,
    created_at: nowISO(),
  });
}

/**
 * Update blob color data
 */
export async function updateBlobColors(
  hash: string,
  colorPalette: string,
  colorSource: string
): Promise<void> {
  const db = getFirestore();
  await db.collection(Collections.BLOBS).doc(hash).update({
    color_palette: colorPalette,
    color_source: colorSource,
  });
}

/**
 * Update blob with partial data
 */
export async function updateBlob(
  hash: string,
  updates: Partial<Blob>
): Promise<void> {
  const db = getFirestore();
  await db.collection(Collections.BLOBS).doc(hash).update(updates);
}

/**
 * Get blobs by orientation
 */
export async function getBlobsByOrientation(): Promise<Record<string, number>> {
  const db = getFirestore();
  const snapshot = await db.collection(Collections.BLOBS).get();
  
  const orientationMap: Record<string, number> = {};
  snapshot.docs.forEach(doc => {
    const blob = doc.data() as Blob;
    const orientation = blob.orientation || 'unknown';
    orientationMap[orientation] = (orientationMap[orientation] || 0) + 1;
  });
  
  return orientationMap;
}

// ========== Source Operations ==========

/**
 * Create a new source record
 */
export async function createSource(source: Omit<Source, "ingested_at">): Promise<void> {
  const db = getFirestore();
  await db.collection(Collections.SOURCES).doc(source.id).set({
    ...source,
    ingested_at: nowISO(),
  });
}

/**
 * Update source status
 */
export async function updateSourceStatus(
  id: string,
  status: Source["status"],
  statusMessage?: string,
  blobHash?: string
): Promise<void> {
  const db = getFirestore();
  const updateData: Partial<Source> = {
    status,
    status_message: statusMessage,
  };
  
  if (blobHash) {
    updateData.blob_hash = blobHash;
  }
  
  if (status === "ready") {
    updateData.processed_at = nowISO();
  }
  
  await db.collection(Collections.SOURCES).doc(id).update(updateData);
}

/**
 * Update source with partial data
 */
export async function updateSource(
  id: string,
  updates: Partial<Source>
): Promise<void> {
  const db = getFirestore();
  await db.collection(Collections.SOURCES).doc(id).update(updates);
}

/**
 * Get sources by status
 */
export async function getSourcesByStatus(
  status: Source["status"],
  limit?: number
): Promise<Source[]> {
  const db = getFirestore();
  let query = db.collection(Collections.SOURCES).where("status", "==", status);
  
  if (limit) {
    query = query.limit(limit);
  }
  
  const snapshot = await query.get();
  return snapshot.docs.map(doc => doc.data() as Source);
}

/**
 * Get source by ID
 */
export async function getSource(id: string): Promise<Source | undefined> {
  const db = getFirestore();
  const doc = await db.collection(Collections.SOURCES).doc(id).get();
  
  if (!doc.exists) {
    return undefined;
  }
  
  return doc.data() as Source;
}

/**
 * Get all sources linked to a specific blob (for duplicate handling)
 */
export async function getSourcesForBlob(blobHash: string): Promise<Source[]> {
  const db = getFirestore();
  const snapshot = await db.collection(Collections.SOURCES)
    .where("blob_hash", "==", blobHash)
    .get();
  
  return snapshot.docs.map(doc => doc.data() as Source);
}

/**
 * Get sources ready for processing (staged status)
 */
export async function getStagedSources(limit?: number): Promise<Source[]> {
  return getSourcesByStatus("staged", limit);
}

/**
 * Count sources by status
 */
export async function countSourcesByStatus(): Promise<Record<string, number>> {
  const db = getFirestore();
  
  // Firestore doesn't support GROUP BY, so we need to query each status separately
  const statuses: Source["status"][] = ["staged", "processing", "ready", "failed"];
  const counts: Record<string, number> = {};
  
  await Promise.all(
    statuses.map(async (status) => {
      const snapshot = await db.collection(Collections.SOURCES)
        .where("status", "==", status)
        .count()
        .get();
      counts[status] = snapshot.data().count;
    })
  );
  
  return counts;
}

// ========== Device Variant Operations ==========

/**
 * Create a device variant
 */
export async function createDeviceVariant(
  variant: Omit<DeviceVariant, "id" | "processed_at">
): Promise<string> {
  const db = getFirestore();
  const id = crypto.randomUUID();
  
  await db.collection(Collections.DEVICE_VARIANTS).doc(id).set({
    ...variant,
    id,
    processed_at: nowISO(),
  });
  
  return id;
}

/**
 * Get device variant by blob hash and dimensions
 */
export async function getDeviceVariant(
  blobHash: string,
  width: number,
  height: number
): Promise<DeviceVariant | undefined> {
  const db = getFirestore();
  const snapshot = await db.collection(Collections.DEVICE_VARIANTS)
    .where("blob_hash", "==", blobHash)
    .where("width", "==", width)
    .where("height", "==", height)
    .limit(1)
    .get();
  
  if (snapshot.empty) {
    return undefined;
  }
  
  return snapshot.docs[0].data() as DeviceVariant;
}

/**
 * Get all device variants for a blob
 */
export async function getDeviceVariantsForBlob(blobHash: string): Promise<DeviceVariant[]> {
  const db = getFirestore();
  const snapshot = await db.collection(Collections.DEVICE_VARIANTS)
    .where("blob_hash", "==", blobHash)
    .get();
  
  return snapshot.docs.map(doc => doc.data() as DeviceVariant);
}

/**
 * Count device variants for a blob
 */
export async function countVariantsForBlob(blobHash: string): Promise<number> {
  const db = getFirestore();
  const snapshot = await db.collection(Collections.DEVICE_VARIANTS)
    .where("blob_hash", "==", blobHash)
    .count()
    .get();
  
  return snapshot.data().count;
}

/**
 * Delete all variants for a blob
 */
export async function deleteVariantsForBlob(blobHash: string): Promise<void> {
  const db = getFirestore();
  const variants = await db.collection(Collections.DEVICE_VARIANTS)
    .where("blob_hash", "==", blobHash)
    .get();
  
  const batch = db.batch();
  variants.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
}

/**
 * Get unique device dimensions that have processed variants
 */
export async function getActiveDeviceDimensions(): Promise<
  Array<{ width: number; height: number; orientation: string }>
> {
  const db = getFirestore();
  const snapshot = await db.collection(Collections.DEVICE_VARIANTS).get();
  
  // Client-side deduplication since Firestore doesn't have DISTINCT
  const dimensionsMap = new Map<string, { width: number; height: number; orientation: string }>();
  
  snapshot.docs.forEach((doc) => {
    const variant = doc.data() as DeviceVariant;
    const key = `${variant.width}x${variant.height}x${variant.orientation}`;
    if (!dimensionsMap.has(key)) {
      dimensionsMap.set(key, {
        width: variant.width,
        height: variant.height,
        orientation: variant.orientation,
      });
    }
  });
  
  // Sort by dimensions (largest first)
  return Array.from(dimensionsMap.values()).sort((a, b) => {
    if (a.width !== b.width) {
      return b.width - a.width;
    }
    return b.height - a.height;
  });
}

/**
 * Check if a device variant exists for given dimensions
 */
export async function deviceVariantExists(
  blobHash: string,
  width: number,
  height: number
): Promise<boolean> {
  const variant = await getDeviceVariant(blobHash, width, height);
  return variant !== undefined;
}

// ========== Device Operations ==========

/**
 * Get device by ID
 */
export async function getDevice(id: string): Promise<Device | undefined> {
  const db = getFirestore();
  const doc = await db.collection(Collections.DEVICES).doc(id).get();
  
  if (!doc.exists) {
    return undefined;
  }
  
  return doc.data() as Device;
}

/**
 * Get all devices
 */
export async function getAllDevices(): Promise<Device[]> {
  const db = getFirestore();
  const snapshot = await db.collection(Collections.DEVICES).get();
  return snapshot.docs.map(doc => doc.data() as Device);
}

/**
 * Create or update a device
 */
export async function upsertDevice(device: Device): Promise<void> {
  const db = getFirestore();
  await db.collection(Collections.DEVICES).doc(device.id).set(device, { merge: true });
}

/**
 * Update device last_seen timestamp
 */
export async function updateDeviceLastSeen(id: string): Promise<void> {
  const db = getFirestore();
  await db.collection(Collections.DEVICES).doc(id).update({
    last_seen: nowISO(),
  });
}

/**
 * Delete a device
 */
export async function deleteDevice(id: string): Promise<void> {
  const db = getFirestore();
  
  // Manual cascade: delete device queue state
  await db.collection(Collections.DEVICE_QUEUE_STATE).doc(id).delete();
  
  // Delete the device
  await db.collection(Collections.DEVICES).doc(id).delete();
}

// ========== Device Queue State Operations ==========

/**
 * Get device queue state
 */
export async function getDeviceQueueState(
  deviceId: string
): Promise<DeviceQueueState | undefined> {
  const db = getFirestore();
  const doc = await db.collection(Collections.DEVICE_QUEUE_STATE).doc(deviceId).get();
  
  if (!doc.exists) {
    return undefined;
  }
  
  return doc.data() as DeviceQueueState;
}

/**
 * Update device queue state
 */
export async function updateDeviceQueueState(
  deviceId: string,
  queueData: string,
  currentIndex: number
): Promise<void> {
  const db = getFirestore();
  await db.collection(Collections.DEVICE_QUEUE_STATE).doc(deviceId).set({
    device_id: deviceId,
    queue_data: queueData,
    current_index: currentIndex,
    updated_at: nowISO(),
  }, { merge: true });
}

/**
 * Delete device queue state
 */
export async function deleteDeviceQueueState(deviceId: string): Promise<void> {
  const db = getFirestore();
  await db.collection(Collections.DEVICE_QUEUE_STATE).doc(deviceId).delete();
}

// ========== Auth Session Operations ==========

/**
 * Get auth session by user ID
 */
export async function getAuthSessionByUserId(
  userId: string
): Promise<AuthSession | undefined> {
  const db = getFirestore();
  const snapshot = await db.collection(Collections.AUTH_SESSIONS)
    .where("user_id", "==", userId)
    .limit(1)
    .get();
  
  if (snapshot.empty) {
    return undefined;
  }
  
  return snapshot.docs[0].data() as AuthSession;
}

/**
 * Get the most recent active (not expired) auth session
 */
export async function getActiveAuthSession(): Promise<AuthSession | undefined> {
  const db = getFirestore();
  const now = nowISO();
  
  const snapshot = await db.collection(Collections.AUTH_SESSIONS)
    .where("token_expiry", ">", now)
    .orderBy("token_expiry", "desc")
    .limit(1)
    .get();
  
  if (snapshot.empty) {
    return undefined;
  }
  
  return snapshot.docs[0].data() as AuthSession;
}

/**
 * Get auth session by ID
 */
export async function getAuthSession(id: string): Promise<AuthSession | undefined> {
  const db = getFirestore();
  const doc = await db.collection(Collections.AUTH_SESSIONS).doc(id).get();
  
  if (!doc.exists) {
    return undefined;
  }
  
  return doc.data() as AuthSession;
}

/**
 * Create or update auth session
 */
export async function upsertAuthSession(session: Omit<AuthSession, "created_at">): Promise<string> {
  const db = getFirestore();
  
  // Check if session exists by user_id
  const existing = await getAuthSessionByUserId(session.user_id);
  const id = existing?.id || session.id;
  
  await db.collection(Collections.AUTH_SESSIONS).doc(id).set({
    ...session,
    id,
    created_at: existing?.created_at || nowISO(),
  });

  return id;
}

/**
 * Delete auth session
 */
export async function deleteAuthSession(id: string): Promise<void> {
  const db = getFirestore();
  
  // Manual cascade: delete associated picker sessions
  const pickerSessions = await db.collection(Collections.PICKER_SESSIONS)
    .where("user_id", "==", id)
    .get();
  
  const batch = db.batch();
  pickerSessions.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
  
  // Delete the auth session
  await db.collection(Collections.AUTH_SESSIONS).doc(id).delete();
}

// ========== Picker Session Operations ==========

/**
 * Get picker session by ID
 */
export async function getPickerSession(id: string): Promise<PickerSession | undefined> {
  const db = getFirestore();
  const doc = await db.collection(Collections.PICKER_SESSIONS).doc(id).get();
  
  if (!doc.exists) {
    return undefined;
  }
  
  return doc.data() as PickerSession;
}

/**
 * Create picker session
 */
export async function createPickerSession(
  session: Omit<PickerSession, "id" | "created_at">
): Promise<string> {
  const db = getFirestore();
  const id = crypto.randomUUID();
  
  await db.collection(Collections.PICKER_SESSIONS).doc(id).set({
    ...session,
    id,
    created_at: nowISO(),
  });
  
  return id;
}

/**
 * Update picker session
 */
export async function updatePickerSession(
  id: string,
  updates: Partial<PickerSession>
): Promise<void> {
  const db = getFirestore();
  await db.collection(Collections.PICKER_SESSIONS).doc(id).update(updates);
}

/**
 * Delete picker session
 */
export async function deletePickerSession(id: string): Promise<void> {
  const db = getFirestore();
  await db.collection(Collections.PICKER_SESSIONS).doc(id).delete();
}

/**
 * Delete expired picker sessions
 */
export async function deleteExpiredPickerSessions(): Promise<void> {
  const db = getFirestore();
  const now = nowISO();
  
  const snapshot = await db.collection(Collections.PICKER_SESSIONS)
    .where("expire_time", "<", now)
    .get();
  
  const batch = db.batch();
  snapshot.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
  
  console.log(`Deleted ${snapshot.size} expired picker sessions`);
}

/**
 * Get active picker session for a user
 */
export async function getActivePickerSession(userId: string): Promise<PickerSession | null> {
  const db = getFirestore();
  const now = nowISO();
  
  const snapshot = await db.collection(Collections.PICKER_SESSIONS)
    .where("user_id", "==", userId)
    .where("expire_time", ">", now)
    .orderBy("expire_time", "desc")
    .orderBy("created_at", "desc")
    .limit(1)
    .get();
  
  if (snapshot.empty) {
    return null;
  }
  
  return snapshot.docs[0].data() as PickerSession;
}

// ========== Failed Task Operations ==========

/**
 * Create a failed task record
 */
export async function createFailedTask(
  task: Omit<FailedTask, "id" | "created_at">
): Promise<string> {
  const db = getFirestore();
  const id = crypto.randomUUID();
  
  await db.collection(Collections.FAILED_TASKS).doc(id).set({
    ...task,
    id,
    created_at: nowISO(),
  });
  
  return id;
}

/**
 * Get all failed tasks
 */
export async function getAllFailedTasks(): Promise<FailedTask[]> {
  const db = getFirestore();
  const snapshot = await db.collection(Collections.FAILED_TASKS)
    .orderBy("created_at", "desc")
    .get();
  
  return snapshot.docs.map(doc => doc.data() as FailedTask);
}

/**
 * Delete a failed task
 */
export async function deleteFailedTask(id: string): Promise<void> {
  const db = getFirestore();
  await db.collection(Collections.FAILED_TASKS).doc(id).delete();
}

// ========== Utility Operations ==========

/**
 * Delete a blob and cascade to device variants
 * Manually implements CASCADE DELETE behavior
 */
export async function deleteBlob(hash: string): Promise<void> {
  const db = getFirestore();
  
  // Delete all device variants for this blob
  const variants = await db.collection(Collections.DEVICE_VARIANTS)
    .where("blob_hash", "==", hash)
    .get();
  
  const batch = db.batch();
  variants.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
  
  // Update sources that reference this blob (set blob_hash to null)
  const sources = await db.collection(Collections.SOURCES)
    .where("blob_hash", "==", hash)
    .get();
  
  const sourceBatch = db.batch();
  sources.docs.forEach(doc => {
    sourceBatch.update(doc.ref, { blob_hash: null });
  });
  await sourceBatch.commit();
  
  // Delete the blob
  await db.collection(Collections.BLOBS).doc(hash).delete();
}

/**
 * Delete a source by ID
 */
export async function deleteSource(id: string): Promise<void> {
  const db = getFirestore();
  await db.collection(Collections.SOURCES).doc(id).delete();
}
