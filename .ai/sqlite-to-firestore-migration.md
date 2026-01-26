# SQLite to Firestore Migration - Remaining Work

This document outlines the remaining work needed to fully implement Firestore equivalents for the stubbed/simplified functionality after removing SQLite dependencies.

## Overview

During the SQLite cleanup (January 12, 2026), several files were deleted or stubbed out. This document tracks what needs to be re-implemented using Firestore.

---

## 1. UI Routes (`src/routes/ui.tsx`)

### 1.1 Home Page Stats (`GET /ui/`)

**Current State:** Basic counts implemented
```typescript
const stats = {
  totalImages: blobsSnapshot.data().count,
  totalDevices: devicesSnapshot.data().count,
  processedVariants: variantsSnapshot.data().count,
  orientations: {}, // TODO: aggregate from Firestore if needed
};
```

**Needs Implementation:**
- [ ] Aggregate blob counts by orientation
  - Query `blobs` collection grouped by `orientation` field
  - Return counts for portrait/landscape/square
  - Use Firestore aggregation queries or client-side grouping

**Implementation Approach:**
```typescript
// Option 1: Client-side aggregation (works with current data)
const blobsSnapshot = await db.collection(Collections.BLOBS).get();
const orientationMap: Record<string, number> = {};
blobsSnapshot.docs.forEach(doc => {
  const orientation = doc.data().orientation;
  orientationMap[orientation] = (orientationMap[orientation] || 0) + 1;
});

// Option 2: Use Firestore count queries per orientation (more efficient for large datasets)
const [portraitCount, landscapeCount, squareCount] = await Promise.all([
  db.collection(Collections.BLOBS).where('orientation', '==', 'portrait').count().get(),
  db.collection(Collections.BLOBS).where('orientation', '==', 'landscape').count().get(),
  db.collection(Collections.BLOBS).where('orientation', '==', 'square').count().get(),
]);
```

---

### 1.2 Images Page (`GET /ui/images`)

**Current State:** Shows blobs with basic info
```typescript
const imagesWithColors = blobsSnapshot.docs.map(doc => {
  // ...
  processingStatus: 'complete', // TODO: Get from sources collection if needed
  processedCount: 0, // TODO: Count variants if needed
  totalDevices: 0, // TODO: Get device count if needed
  // ...
});
```

**Needs Implementation:**
- [ ] **Processing Status** - Query `sources` collection to get actual processing status
  - Join blob_hash with sources.blob_hash
  - Return status: 'staged', 'processing', 'ready', 'failed'
  - Include status_message for errors

- [ ] **Processed Variants Count** - Count device_variants per blob
  - Query `device_variants` where blob_hash matches
  - Use count aggregation or collect and count
  
- [ ] **Total Devices Count** - Get total registered devices
  - Simple count query on `devices` collection
  - Cache this value since it changes infrequently

**Implementation Approach:**
```typescript
// Get devices count once
const devicesCountSnapshot = await db.collection(Collections.DEVICES).count().get();
const totalDevices = devicesCountSnapshot.data().count;

// For each blob, get source status and variant count
const imagesWithColors = await Promise.all(blobsSnapshot.docs.map(async doc => {
  const data = doc.data();
  const blobHash = doc.id;
  
  // Get source for processing status
  const sourceSnapshot = await db.collection(Collections.SOURCES)
    .where('blob_hash', '==', blobHash)
    .limit(1)
    .get();
  
  const source = sourceSnapshot.empty ? null : sourceSnapshot.docs[0].data();
  
  // Count variants
  const variantsCount = await db.collection(Collections.DEVICE_VARIANTS)
    .where('blob_hash', '==', blobHash)
    .count()
    .get();
  
  return {
    id: blobHash,
    // ...
    processingStatus: source?.status || 'unknown',
    processingError: source?.status_message || null,
    processedCount: variantsCount.data().count,
    totalDevices,
    // ...
  };
}));

// Note: This could be optimized with batch reads or by maintaining
// denormalized counts in the blobs document
```

**Performance Optimization Needed:**
- Current approach makes N+2 queries (N images + devices count + variants per image)
- Consider denormalizing variant count into blobs document
- Or use batch queries to fetch all sources and variants in fewer round trips

---

### 1.3 Retry Failed Processing (`POST /ui/images/:id/retry`)

**Current State:** Route was removed entirely

**Needs Implementation:**
- [ ] Re-implement retry endpoint for failed image processing
  - Query `sources` collection by id or blob_hash
  - Update status from 'failed' back to 'staged'
  - Clear status_message
  - Trigger re-processing via job queue

**Implementation Approach:**
```typescript
ui.post("/images/:id/retry", async (c) => {
  const imageId = c.req.param("id"); // Could be source_id or blob_hash
  const db = getFirestore();
  
  // Try to find source by id first, then by blob_hash
  let sourceDoc;
  try {
    sourceDoc = await db.collection(Collections.SOURCES).doc(imageId).get();
  } catch {
    // Not found by id, try blob_hash
    const snapshot = await db.collection(Collections.SOURCES)
      .where('blob_hash', '==', imageId)
      .limit(1)
      .get();
    sourceDoc = snapshot.empty ? null : snapshot.docs[0];
  }
  
  if (!sourceDoc?.exists) {
    return c.redirect("/ui/images");
  }
  
  // Update status
  await sourceDoc.ref.update({
    status: 'staged',
    status_message: null,
    processed_at: null,
  });
  
  // Queue for processing via job queue v2
  const { queueProcessingJob } = await import("../services/job-queue-v2.ts");
  await queueProcessingJob(sourceDoc.id);
  
  return c.redirect("/ui/images");
});
```

---

### 1.4 Photos Picker Session Management (`GET /ui/photos-picker`)

**Current State:** Always returns null session
```typescript
// TODO: Check Firestore for picker sessions if needed
return c.html(<PhotosPicker session={null} />);
```

**Needs Implementation:**
- [ ] Add `picker_sessions` collection to Firestore schema
- [ ] Query for active (non-expired) picker sessions for user
- [ ] Return session data to UI

**Firestore Schema Needed:**
```typescript
// Collection: picker_sessions
{
  id: string; // auto-generated
  user_id: string; // indexed
  picker_session_id: string;
  picker_uri: string;
  media_items_set: boolean;
  polling_config: string | null; // JSON
  created_at: Timestamp;
  expire_time: Timestamp | null; // indexed for querying
}
```

**Implementation Approach:**
```typescript
const db = getFirestore();
const now = new Date();

const sessionSnapshot = await db.collection(Collections.PICKER_SESSIONS)
  .where('user_id', '==', userId)
  .where('expire_time', '>', now)
  .orderBy('expire_time', 'desc')
  .orderBy('created_at', 'desc')
  .limit(1)
  .get();

const session = sessionSnapshot.empty ? null : {
  sessionId: sessionSnapshot.docs[0].data().picker_session_id,
  pickerUri: sessionSnapshot.docs[0].data().picker_uri,
};

return c.html(<PhotosPicker session={session} />);
```

---

## 2. Admin Routes (`src/routes/admin.ts`)

**Current State:** Gutted to only include photos routes

**Deleted Functionality That May Need Re-implementation:**

### 2.1 Image Statistics (`GET /api/admin/stats`)

**Was:**
- Total images count
- Orientation breakdown
- Processing queue status

**Needs Implementation:**
- [ ] Re-implement using Firestore aggregations
- [ ] Include job queue status from job-queue-v2.ts

**Implementation:**
```typescript
admin.get("/stats", async (c) => {
  const db = getFirestore();
  
  const [blobsCount, sourcesCount, devicesCount, variantsCount] = await Promise.all([
    db.collection(Collections.BLOBS).count().get(),
    db.collection(Collections.SOURCES).count().get(),
    db.collection(Collections.DEVICES).count().get(),
    db.collection(Collections.DEVICE_VARIANTS).count().get(),
  ]);
  
  // Get processing status breakdown
  const [staged, processing, ready, failed] = await Promise.all([
    db.collection(Collections.SOURCES).where('status', '==', 'staged').count().get(),
    db.collection(Collections.SOURCES).where('status', '==', 'processing').count().get(),
    db.collection(Collections.SOURCES).where('status', '==', 'ready').count().get(),
    db.collection(Collections.SOURCES).where('status', '==', 'failed').count().get(),
  ]);
  
  return c.json({
    blobs: blobsCount.data().count,
    sources: sourcesCount.data().count,
    devices: devicesCount.data().count,
    variants: variantsCount.data().count,
    processing: {
      staged: staged.data().count,
      processing: processing.data().count,
      ready: ready.data().count,
      failed: failed.data().count,
    },
  });
});
```

### 2.2 Image Upload (`POST /api/admin/upload`)

**Was:**
- Accept multipart file uploads
- Extract metadata with Sharp
- Store in GCS
- Create database records
- Queue for processing

**Needs Implementation:**
- [ ] Re-implement using Firestore collections (sources, blobs)
- [ ] Use image-ingestion-v2.ts service
- [ ] Queue via job-queue-v2.ts

**Implementation:**
```typescript
admin.post("/upload", async (c) => {
  const body = await c.req.parseBody();
  const files: File[] = [];
  
  for (const [key, value] of Object.entries(body)) {
    if (key.startsWith("files") && value instanceof File) {
      files.push(value);
    }
  }
  
  if (files.length === 0) {
    return c.json({ error: "No files provided" }, 400);
  }
  
  const { ingestUploadedFile } = await import("../services/image-ingestion-v2.ts");
  const results = await Promise.all(
    files.map(file => ingestUploadedFile(file, { origin: 'upload' }))
  );
  
  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;
  
  return c.json({
    success: successCount > 0,
    uploaded: successCount,
    failed: failCount,
    results,
  });
});
```

### 2.3 Delete Single Image (`DELETE /api/admin/images/:id`)

**Was:**
- Delete from images and processed_images tables
- Clean up files from disk/GCS

**Needs Implementation:**
- [ ] Delete from sources, blobs, device_variants collections
- [ ] Delete files from GCS using storage.ts service
- [ ] Handle cascade deletes properly

**Implementation:**
```typescript
admin.delete("/images/:id", async (c) => {
  const imageId = c.req.param("id");
  const db = getFirestore();
  
  // Find source and blob
  const sourceDoc = await db.collection(Collections.SOURCES).doc(imageId).get();
  if (!sourceDoc.exists) {
    return c.json({ error: "Image not found" }, 404);
  }
  
  const sourceData = sourceDoc.data()!;
  const blobHash = sourceData.blob_hash;
  
  // Check if other sources reference this blob
  const otherSources = await db.collection(Collections.SOURCES)
    .where('blob_hash', '==', blobHash)
    .get();
  
  const isLastSource = otherSources.docs.length === 1;
  
  // Delete source
  await sourceDoc.ref.delete();
  
  // If last source, delete blob and variants
  if (isLastSource && blobHash) {
    const blobDoc = await db.collection(Collections.BLOBS).doc(blobHash).get();
    const blobData = blobDoc.data();
    
    // Delete all variants
    const variants = await db.collection(Collections.DEVICE_VARIANTS)
      .where('blob_hash', '==', blobHash)
      .get();
    
    const batch = db.batch();
    variants.docs.forEach(doc => batch.delete(doc.ref));
    batch.delete(blobDoc.ref);
    await batch.commit();
    
    // Delete files from GCS
    const { deleteFile } = await import("../services/storage.ts");
    if (blobData?.storage_path) {
      await deleteFile(blobData.storage_path).catch(console.error);
    }
    for (const variant of variants.docs) {
      const variantData = variant.data();
      if (variantData?.storage_path) {
        await deleteFile(variantData.storage_path).catch(console.error);
      }
    }
  }
  
  return c.json({ success: true, id: imageId });
});
```

### 2.4 Delete All Images (`DELETE /api/admin/images/delete-all`)

**Was:**
- Nuclear option to wipe all images

**Needs Implementation:**
- [ ] Delete all sources, blobs, variants from Firestore
- [ ] Clean up all files from GCS (or use lifecycle policies)

**Implementation:**
```typescript
admin.delete("/images/delete-all", async (c) => {
  const db = getFirestore();
  
  // WARNING: This is destructive!
  const [sources, blobs, variants] = await Promise.all([
    db.collection(Collections.SOURCES).get(),
    db.collection(Collections.BLOBS).get(),
    db.collection(Collections.DEVICE_VARIANTS).get(),
  ]);
  
  // Firestore has batch size limit of 500
  const deleteBatch = async (docs: FirebaseFirestore.QueryDocumentSnapshot[]) => {
    for (let i = 0; i < docs.length; i += 500) {
      const batch = db.batch();
      docs.slice(i, i + 500).forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }
  };
  
  await Promise.all([
    deleteBatch(sources.docs),
    deleteBatch(blobs.docs),
    deleteBatch(variants.docs),
  ]);
  
  return c.json({
    success: true,
    deleted: sources.docs.length,
    blobsDeleted: blobs.docs.length,
    variantsDeleted: variants.docs.length,
  });
});
```

### 2.5 Manual Ingestion (`POST /api/admin/ingest`)

**Was:**
- Trigger ingestion from local directory
- Scan for images recursively
- Create database records

**Decision Needed:**
- [ ] Determine if this is still needed (was for local development)
- [ ] If needed, use image-ingestion-v2.ts with local file support

---

## 3. Processing Routes (Deleted Entirely)

**File:** `src/routes/processing.ts` (deleted)

These routes were used by the processor service to coordinate work. Consider if they need to be re-implemented or if the new architecture handles this differently.

### 3.1 Get Pending Images (`GET /api/processing/pending`)

**Was:**
- Return list of images with processing_status='pending'
- Limited to 50 at a time

**Consider:**
- Is this still needed with job-queue-v2.ts?
- Does the processor pull from Firestore directly?
- Or does it use Cloud Tasks/Pub-Sub?

### 3.2 Claim Image for Processing (`POST /api/processing/claim/:id`)

**Was:**
- Set processing_status='processing'
- Set processing_app_id to worker instance

**Consider:**
- Job locking mechanism now handled by Cloud Tasks?
- Or need distributed lock in Firestore?

### 3.3 Report Processing Results (`POST /api/processing/results`)

**Was:**
- Receive processed image metadata from worker
- Update database with colors, variants, etc.

**Consider:**
- Does processor write directly to Firestore now?
- Or still needs API endpoint for coordination?

---

## 4. Services

### 4.1 Metadata Sync Service (Deleted)

**File:** `src/services/metadata-sync.ts` (deleted)

**Was:**
- Poll GCS for metadata JSON files
- Import processed image data
- Archive metadata files

**Decision Needed:**
- [ ] Is this workflow still used?
- [ ] If yes, re-implement to write to Firestore instead of SQLite
- [ ] Consider using GCS notifications -> Pub/Sub -> Cloud Function instead

### 4.2 Worker Queue Service (Deleted)

**File:** `src/services/worker-queue.ts` (deleted)

**Was:**
- In-memory queue for image processing
- Coordinated work distribution

**Replacement:**
- Now using `job-queue-v2.ts` with Cloud Tasks
- Verify all functionality is covered

---

## 5. Collection Helpers Needed

To properly implement the above, you'll need helper functions in `db/helpers-firestore.ts`:

### 5.1 Sources Collection Helpers

```typescript
// Get source by ID
export async function getSource(sourceId: string): Promise<Source | null>

// Get sources by blob hash
export async function getSourcesByBlobHash(blobHash: string): Promise<Source[]>

// Update source status
export async function updateSourceStatus(
  sourceId: string,
  status: 'staged' | 'processing' | 'ready' | 'failed',
  statusMessage?: string
): Promise<void>

// Get sources ready for processing
export async function getStagedSources(limit?: number): Promise<Source[]>
```

### 5.2 Blobs Collection Helpers

```typescript
// Get blob by hash
export async function getBlob(blobHash: string): Promise<Blob | null>

// Create or update blob
export async function upsertBlob(blob: Blob): Promise<void>

// Delete blob and all related data
export async function deleteBlob(blobHash: string): Promise<void>
```

### 5.3 Device Variants Collection Helpers

```typescript
// Get variants for blob
export async function getVariantsForBlob(blobHash: string): Promise<DeviceVariant[]>

// Count variants for blob
export async function countVariantsForBlob(blobHash: string): Promise<number>

// Create variant
export async function createVariant(variant: DeviceVariant): Promise<string>

// Delete variants for blob
export async function deleteVariantsForBlob(blobHash: string): Promise<void>
```

### 5.4 Picker Sessions Collection Helpers

```typescript
// Create picker session
export async function createPickerSession(session: PickerSession): Promise<string>

// Get active picker session for user
export async function getActivePickerSession(userId: string): Promise<PickerSession | null>

// Update picker session
export async function updatePickerSession(sessionId: string, updates: Partial<PickerSession>): Promise<void>
```

---

## 6. Testing Checklist

Once implementations are complete:

- [ ] Test home page displays correct stats
- [ ] Test images page shows processing status
- [ ] Test retry functionality for failed images
- [ ] Test upload endpoint creates proper Firestore records
- [ ] Test delete operations cascade correctly
- [ ] Test picker session storage and retrieval
- [ ] Verify no lingering SQLite references
- [ ] Test with actual GCS files
- [ ] Load test Firestore query performance
- [ ] Verify Cloud Tasks integration works end-to-end

---

## 7. Performance Considerations

### Firestore Limitations to Consider:

1. **Query Limits:**
   - Max 500 documents per batch operation
   - Aggregation queries available but may need composite indexes

2. **Composite Indexes Needed:**
   ```
   Collection: sources
   - blob_hash (asc) + status (asc)
   - user_id (asc) + status (asc)
   
   Collection: picker_sessions
   - user_id (asc) + expire_time (desc) + created_at (desc)
   
   Collection: device_variants
   - blob_hash (asc) + layout_type (asc)
   ```

3. **Denormalization Opportunities:**
   - Store variant_count in blobs document (update on variant create/delete)
   - Store processing_status in blobs document (mirror from sources)
   - Cache device count in a singleton document

4. **Read Optimization:**
   - Use batch reads instead of N+1 queries
   - Cache frequently accessed data (devices list, etc.)
   - Consider Firestore bundle for initial page loads

---

## Priority Order for Implementation

**High Priority (Breaks functionality):**
1. ✅ Remove SQLite dependencies (DONE)
2. Implement missing Firestore collection helpers
3. Re-implement image retry endpoint
4. Re-implement stats aggregation

**Medium Priority (Degraded UX):**
1. Complete images page metadata (status, counts)
2. Restore picker session management
3. Re-implement upload endpoint

**Low Priority (Optional features):**
1. Restore delete functionality
2. Restore admin stats endpoint
3. Consider if processing coordination endpoints needed
4. Consider if metadata sync needed

---

## Migration Notes

**Original SQLite Tables → Firestore Collections Mapping:**

- `images` → `blobs` collection (deduplicated by hash)
- `processed_images` → `device_variants` collection
- `devices` → `devices` collection (no change)
- `device_queue_state` → `device_queue_state` collection (no change)
- New: `sources` collection (tracks ingestion per user/origin)
- New: `picker_sessions` collection (if needed)
- Removed: `failed_tasks`, `auth_sessions` (handled differently now)

**Data Migration:**
- No automated migration path from SQLite to Firestore was created
- Assume fresh start or manual data migration if needed
