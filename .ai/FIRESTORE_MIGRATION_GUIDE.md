# Firestore Migration Guide

**Status:** In Progress  
**Started:** January 12, 2026  
**Database:** SQLite → Firestore (default)

## Overview

This guide documents the migration from SQLite to Google Cloud Firestore for the slideshow-backend project. The migration eliminates the need for database synchronization across Cloud Run instances and provides native cloud scalability.

## Completed Work

### 1. Foundation Setup ✅

#### Dependencies ([deno.json](../deno.json))
- ✅ Removed: `"sqlite": "jsr:@db/sqlite@0.12"`
- ✅ Added: `"@google-cloud/firestore": "npm:@google-cloud/firestore@^7.10.0"`

#### Firestore Initialization ([src/db/firestore.ts](../src/db/firestore.ts))
```typescript
// Singleton Firestore instance
let db: Firestore;

export function getFirestore(): Firestore
export async function initFirestore(): Promise<void>
export const Collections = {
  BLOBS: "blobs",
  SOURCES: "sources",
  DEVICE_VARIANTS: "device_variants",
  DEVICES: "devices",
  DEVICE_QUEUE_STATE: "device_queue_state",
  AUTH_SESSIONS: "auth_sessions",
  PICKER_SESSIONS: "picker_sessions",
  FAILED_TASKS: "failed_tasks",
}
```

**Configuration:**
- Uses Application Default Credentials (ADC)
- Database ID: `(default)`
- Project ID: From `GCP_PROJECT` env var or ADC default

#### Type Definitions ([src/db/types.ts](../src/db/types.ts))
All SQLite types converted to Firestore-compatible types:
- Timestamps: ISO strings instead of DATETIME
- Document IDs: Explicitly included in type definitions
- JSON fields: Remain as strings (parse on use)

**Key Types:**
- `Blob` - Unique image content by hash
- `Source` - User-facing image records
- `DeviceVariant` - Processed outputs by dimensions
- `Device` - Device configurations
- `DeviceQueueState` - Slideshow queue state
- `AuthSession` - OAuth tokens
- `PickerSession` - Google Photos Picker sessions
- `FailedTask` - Failed processing tasks

#### Helper Functions ([src/db/helpers-firestore.ts](../src/db/helpers-firestore.ts))
Complete rewrite of all database operations as async functions:

**Blob Operations:**
- `blobExists(hash)` → `async`
- `getBlob(hash)` → `async`
- `createBlob(blob)` → `async`
- `updateBlobColors(hash, palette, source)` → `async`

**Source Operations:**
- `createSource(source)` → `async`
- `updateSourceStatus(id, status, message?, blobHash?)` → `async`
- `getSourcesByStatus(status, limit?)` → `async`
- `getSource(id)` → `async`
- `getSourcesForBlob(blobHash)` → `async`
- `countSourcesByStatus()` → `async` (uses aggregation queries)

**Device Variant Operations:**
- `createDeviceVariant(variant)` → `async`
- `getDeviceVariant(blobHash, width, height)` → `async`
- `getDeviceVariantsForBlob(blobHash)` → `async`
- `getActiveDeviceDimensions()` → `async` (client-side deduplication)
- `deviceVariantExists(blobHash, width, height)` → `async`

**Device Operations:**
- `getDevice(id)` → `async`
- `getAllDevices()` → `async`
- `upsertDevice(device)` → `async`
- `updateDeviceLastSeen(id)` → `async`
- `deleteDevice(id)` → `async` (manual cascade to queue state)

**Other Collections:**
- Auth sessions, picker sessions, failed tasks
- All with async operations

**Manual Cascade Deletes:**
Since Firestore doesn't have foreign keys, cascade deletes are implemented manually:
- `deleteDevice()` - Also deletes device_queue_state
- `deleteAuthSession()` - Also deletes picker_sessions
- `deleteBlob()` - Updates sources, deletes device_variants

### 2. Application Entry Point ✅

#### Main Server ([src/main.ts](../src/main.ts))
- ✅ Removed: `DatabaseSyncManager` import and initialization
- ✅ Removed: GCS database download logic
- ✅ Removed: `recoverOrphanedProcessingImages()` function (legacy schema)
- ✅ Removed: `processUnprocessedImages()` function (legacy schema)
- ✅ Changed: `initDatabase()` → `initFirestore()`
- ✅ Simplified: Health check no longer includes database sync status
- ✅ Simplified: Graceful shutdown no longer needs database sync cleanup

**Before:**
```typescript
import { initDatabase, getDb } from "./db/schema.ts";
import { DatabaseSyncManager } from "./db/sync.ts";

// Complex Cloud Run database sync setup...
const dbSync = new DatabaseSyncManager({ ... });
await dbSync.initialize();
await initDatabase();

// Shutdown
await dbSync.shutdown();
```

**After:**
```typescript
import { initFirestore } from "./db/firestore.ts";

// Simple Firestore init
await initFirestore();

// No sync to manage in shutdown
```

### 3. Routes Updated ✅

#### Device API ([src/routes/devices.ts](../src/routes/devices.ts))
All endpoints converted to use async Firestore helpers:

- `POST /register` - Device registration with `upsertDevice()`
- `GET /:deviceId` - Device info with `getDevice()`
- `GET /:deviceId/slideshow` - Queue generation (needs service update)
- `GET /:deviceId/next` - Next image (needs service update)
- `GET /:deviceId/images/:imageId` - Image serving with `getSource()`, `getDeviceVariant()`
- `GET /:deviceId/images/:imageId/metadata` - Metadata with `getBlob()`
- `POST /` - Device creation with `upsertDevice()`
- `PUT /:deviceId` - Device update with `upsertDevice()`
- `DELETE /:deviceId` - Device deletion with `deleteDevice()`

**Pattern Example:**
```typescript
// Old SQLite
const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId);

// New Firestore
const device = await getDevice(deviceId);
```

---

## Remaining Work

### Critical Path Files (Must Complete)

#### 1. Slideshow Queue Service ([src/services/slideshow-queue.ts](../src/services/slideshow-queue.ts))
**Complexity:** HIGH  
**Lines:** 432  
**Database Queries:** 6 major queries

**Required Changes:**
1. Replace `getDb()` import with Firestore helpers
2. Convert `generateSlideshowQueue()` to async
   - Query blobs with device variants (currently uses JOIN)
   - Fetch device info with `getDevice()`
   - Refactor to avoid SQLite-specific features:
     - `SELECT DISTINCT` → client-side deduplication
     - Complex JOINs → multiple queries or denormalization
3. Convert `loadQueueState()` to async with `getDeviceQueueState()`
4. Convert `saveQueueState()` to async with `updateDeviceQueueState()`
5. Convert `getNextImage()` to async

**Data Model Challenge:**
Current code does complex JOIN between `blobs` and `device_variants`:
```sql
SELECT b.hash, b.width, b.height, b.color_palette
FROM blobs b
WHERE b.hash IN (SELECT DISTINCT blob_hash FROM device_variants)
```

**Firestore Approach:**
Option A: Two queries (simple but potentially slower)
```typescript
// 1. Get all device variants
const variants = await getFirestore()
  .collection(Collections.DEVICE_VARIANTS)
  .get();

// 2. Get unique blob hashes
const blobHashes = [...new Set(variants.docs.map(d => d.data().blob_hash))];

// 3. Batch get blobs (Firestore supports up to 500 per batch)
const blobs = await Promise.all(
  blobHashes.map(hash => getBlob(hash))
);
```

Option B: Denormalize (add dimensions to device_variants for filtering)

#### 2. Image Processing Service ([src/services/image-processing.ts](../src/services/image-processing.ts))
**Complexity:** MEDIUM-HIGH  
**Estimated Database Queries:** ~10

**Required Changes:**
1. Convert image lookup queries to `getSource()`, `getBlob()`
2. Update device variant creation with `createDeviceVariant()`
3. Replace legacy `images` table queries (if any) with new schema
4. Convert all functions to async

#### 3. Job Queue Service ([src/services/job-queue.ts](../src/services/job-queue.ts))
**Complexity:** MEDIUM

**Required Changes:**
1. Convert `getSourcesByStatus()` calls to async
2. Update status changes with `updateSourceStatus()`
3. Handle failed task creation with `createFailedTask()`

#### 4. Image Ingestion Services
- [src/services/image-ingestion.ts](../src/services/image-ingestion.ts)
- [src/services/image-ingestion-v2.ts](../src/services/image-ingestion-v2.ts)

**Required Changes:**
1. Import from `helpers-firestore.ts` instead of `helpers.ts`
2. Convert `createSource()`, `createBlob()` calls to async
3. Update all blob/source queries to async

### Secondary Files (Lower Priority)

#### Routes
- **[src/routes/admin.ts](../src/routes/admin.ts)** - Admin operations, image management
- **[src/routes/auth.ts](../src/routes/auth.ts)** - OAuth session management
- **[src/routes/processing.ts](../src/routes/processing.ts)** - Processing job callbacks
- **[src/routes/ui.tsx](../src/routes/ui.tsx)** - UI data fetching

#### Services
- **[src/services/auth.ts](../src/services/auth.ts)** - Session CRUD operations
- **[src/services/google-photos.ts](../src/services/google-photos.ts)** - Picker session management
- **[src/services/metadata-sync.ts](../src/services/metadata-sync.ts)** - GCS metadata sync

#### CLI Tools
- **[src/register-devices.ts](../src/register-devices.ts)** - Device registration script
- **[src/cleanup-devices.ts](../src/cleanup-devices.ts)** - Device cleanup
- **[src/cleanup-images.ts](../src/cleanup-images.ts)** - Image cleanup
- **[src/cli.ts](../src/cli.ts)** - CLI utilities

### Files to Delete

#### Database Sync System (No Longer Needed)
- **[src/db/sync.ts](../src/db/sync.ts)** - 386 lines of SQLite sync logic
  - Lease-based writer election
  - GCS upload/download
  - WAL file management
  - **DELETE THIS FILE** after migration complete

#### Legacy Schema Files (After Migration)
- **[src/db/schema.ts](../src/db/schema.ts)** - SQLite schema definitions
- **[src/db/helpers.ts](../src/db/helpers.ts)** - Old SQLite helpers

---

## Migration Patterns

### Pattern 1: Simple Synchronous → Async

**Before:**
```typescript
import { getDb } from "../db/schema.ts";

function getDeviceInfo(id: string) {
  const db = getDb();
  const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(id);
  return device;
}
```

**After:**
```typescript
import { getDevice } from "../db/helpers-firestore.ts";

async function getDeviceInfo(id: string) {
  const device = await getDevice(id);
  return device;
}
```

### Pattern 2: List/Query Operations

**Before:**
```typescript
const sources = db.prepare("SELECT * FROM sources WHERE status = ?")
  .all("staged");
```

**After:**
```typescript
const sources = await getSourcesByStatus("staged");
```

### Pattern 3: Insert/Update Operations

**Before:**
```typescript
db.prepare("INSERT INTO blobs (...) VALUES (?, ?, ...)").run(
  hash, path, width, height
);
```

**After:**
```typescript
await createBlob({
  hash,
  storage_path: path,
  width,
  height,
  // ... other fields
});
```

### Pattern 4: Complex JOINs → Multiple Queries

**Before:**
```typescript
const results = db.prepare(`
  SELECT b.*, dv.storage_path
  FROM blobs b
  JOIN device_variants dv ON b.hash = dv.blob_hash
  WHERE dv.width = ? AND dv.height = ?
`).all(width, height);
```

**After (Option A - Sequential):**
```typescript
const variants = await getFirestore()
  .collection(Collections.DEVICE_VARIANTS)
  .where("width", "==", width)
  .where("height", "==", height)
  .get();

const results = await Promise.all(
  variants.docs.map(async (doc) => {
    const variant = doc.data() as DeviceVariant;
    const blob = await getBlob(variant.blob_hash);
    return { ...blob, storage_path: variant.storage_path };
  })
);
```

**After (Option B - Denormalize):**
Store necessary blob data in device_variants:
```typescript
type DeviceVariant = {
  // ... existing fields
  blob_width?: number;
  blob_height?: number;
  blob_orientation?: string;
};

// Query directly without join
const variants = await getFirestore()
  .collection(Collections.DEVICE_VARIANTS)
  .where("width", "==", width)
  .where("height", "==", height)
  .get();
```

### Pattern 5: Aggregations

**Before:**
```typescript
const count = db.prepare("SELECT COUNT(*) as count FROM sources WHERE status = ?")
  .get("ready") as { count: number };
```

**After:**
```typescript
const snapshot = await getFirestore()
  .collection(Collections.SOURCES)
  .where("status", "==", "ready")
  .count()
  .get();
const count = snapshot.data().count;
```

### Pattern 6: Route Handler Conversion

All route handlers must become async:

**Before:**
```typescript
app.get("/devices/:id", (c) => {
  const device = getDevice(c.req.param("id"));
  return c.json(device);
});
```

**After:**
```typescript
app.get("/devices/:id", async (c) => {
  const device = await getDevice(c.req.param("id"));
  return c.json(device);
});
```

---

## Key Differences: SQLite vs Firestore

### 1. No Foreign Keys
**SQLite:**
```sql
FOREIGN KEY (blob_hash) REFERENCES blobs(hash) ON DELETE CASCADE
```

**Firestore:**
Manual cascade implementation required. See `deleteBlob()` in helpers-firestore.ts.

### 2. No UNIQUE Constraints
**SQLite:**
```sql
UNIQUE(user_id, external_id, origin)
```

**Firestore:**
- Use document IDs for uniqueness
- Or implement application-level checks
- Or maintain separate uniqueness index collection

### 3. No CHECK Constraints
**SQLite:**
```sql
CHECK(status IN ('staged', 'processing', 'ready', 'failed'))
```

**Firestore:**
Validate in application code (TypeScript types help).

### 4. No JOINs
**SQLite:**
```sql
SELECT * FROM blobs b
JOIN device_variants dv ON b.hash = dv.blob_hash
```

**Firestore:**
- Multiple queries
- Batch reads (up to 500 documents)
- Denormalize data where appropriate

### 5. Limited Aggregations
**SQLite:**
```sql
SELECT status, COUNT(*) FROM sources GROUP BY status
```

**Firestore:**
- Use `.count()` for simple counts
- Complex aggregations require client-side processing
- Or use separate queries per group

### 6. No Transactions by Default
**SQLite:**
Prepared statements auto-commit.

**Firestore:**
Explicit transactions available but not used in current helpers:
```typescript
await db.runTransaction(async (transaction) => {
  // Read operations
  const doc = await transaction.get(ref);
  // Write operations
  transaction.update(ref, data);
});
```

### 7. Eventual Consistency
**SQLite:**
Strong consistency (single writer).

**Firestore:**
- Strong consistency for single-document reads
- Eventual consistency for queries
- Real-time listeners for updates

---

## Testing Strategy

### 1. Unit Tests for Helpers
Test each helper function independently:

```typescript
// Test blob operations
await createBlob({ hash: "test123", ... });
const blob = await getBlob("test123");
assert(blob.hash === "test123");

// Test cascade deletes
await deleteBlob("test123");
const variants = await getDeviceVariantsForBlob("test123");
assert(variants.length === 0);
```

### 2. Integration Tests
Test complete workflows:

```typescript
// Image ingestion flow
const sourceId = await createSource({ ... });
await updateSourceStatus(sourceId, "processing");
await createBlob({ ... });
await createDeviceVariant({ ... });
await updateSourceStatus(sourceId, "ready");
```

### 3. Performance Tests
Compare query performance:

```typescript
console.time("getDeviceVariants");
const variants = await getDeviceVariantsForBlob("hash");
console.timeEnd("getDeviceVariants");
```

### 4. Manual Testing
1. Start local Firestore emulator:
   ```bash
   gcloud emulators firestore start
   export FIRESTORE_EMULATOR_HOST="localhost:8080"
   ```

2. Run backend:
   ```bash
   deno task dev
   ```

3. Test device registration:
   ```bash
   curl -X POST http://localhost:8080/api/devices/register \
     -H "Content-Type: application/json" \
     -d '{"id":"test","name":"Test","width":1024,"height":600,"orientation":"landscape"}'
   ```

---

## Deployment Considerations

### 1. Firestore Setup
```bash
# Create Firestore database (if not exists)
gcloud firestore databases create --database=(default) --location=us-central1

# Create composite indices (as needed)
# These will be auto-created on first query, or define in firestore.indexes.json
```

### 2. Application Default Credentials
**Local Development:**
```bash
gcloud auth application-default login
```

**Cloud Run:**
Uses service account automatically (no setup needed).

### 3. Environment Variables
Update Cloud Run service:
```bash
gcloud run services update slideshow-backend \
  --set-env-vars="GCP_PROJECT=your-project-id"
```

### 4. Migration Plan (No Data to Migrate)
Since you specified not to migrate data:

1. **Deploy new code:**
   ```bash
   ./deploy.sh
   ```

2. **Remove old database artifacts:**
   - Delete `slideshow.db` files from Cloud Run (if any)
   - Remove GCS database sync bucket (if exists)
   - Clean up old database backups

3. **Verify:**
   - Check health endpoint: `/_health`
   - Register a test device
   - Upload test images
   - Verify slideshow queue generation

### 5. Rollback Plan
**If issues occur:**

1. Revert to previous Cloud Run revision:
   ```bash
   gcloud run services update-traffic slideshow-backend \
     --to-revisions=PREVIOUS_REVISION=100
   ```

2. The old SQLite code is preserved in:
   - `src/db/schema.ts`
   - `src/db/helpers.ts`
   - `src/db/sync.ts`
   - `src/routes/devices-old.ts`

---

## Composite Indices Required

Firestore requires composite indices for certain queries. These will be auto-created on first use, or you can pre-create them:

### firestore.indexes.json
```json
{
  "indexes": [
    {
      "collectionGroup": "sources",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "ingested_at", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "device_variants",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "blob_hash", "order": "ASCENDING" },
        { "fieldPath": "width", "order": "ASCENDING" },
        { "fieldPath": "height", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "sources",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "blob_hash", "order": "ASCENDING" },
        { "fieldPath": "status", "order": "ASCENDING" }
      ]
    }
  ]
}
```

Deploy indices:
```bash
gcloud firestore indexes composite create \
  --collection-group=sources \
  --query-scope=COLLECTION \
  --field-config field-path=status,order=ascending \
  --field-config field-path=ingested_at,order=descending
```

---

## Performance Considerations

### 1. Batch Reads
When fetching multiple documents by ID:

**Don't:**
```typescript
for (const hash of hashes) {
  const blob = await getBlob(hash);
  blobs.push(blob);
}
```

**Do:**
```typescript
const refs = hashes.map(hash => 
  getFirestore().collection(Collections.BLOBS).doc(hash)
);
const docs = await getFirestore().getAll(...refs);
const blobs = docs.map(doc => doc.data());
```

### 2. Pagination
For large result sets:

```typescript
let query = getFirestore()
  .collection(Collections.SOURCES)
  .where("status", "==", "ready")
  .limit(100);

const snapshot = await query.get();
const lastDoc = snapshot.docs[snapshot.docs.length - 1];

// Next page
query = query.startAfter(lastDoc);
```

### 3. Caching
Consider caching frequently accessed data:

```typescript
// Simple in-memory cache for devices
const deviceCache = new Map<string, { device: Device, timestamp: number }>();

async function getCachedDevice(id: string) {
  const cached = deviceCache.get(id);
  if (cached && Date.now() - cached.timestamp < 60000) {
    return cached.device;
  }
  
  const device = await getDevice(id);
  deviceCache.set(id, { device, timestamp: Date.now() });
  return device;
}
```

---

## Benefits Gained

### 1. No Database Sync ✅
**Eliminated:**
- 386 lines of complex sync code
- Lease-based writer election
- GCS upload/download overhead
- WAL file management
- Database file corruption risks

### 2. True Multi-Writer ✅
- Multiple Cloud Run instances can write simultaneously
- No single writer bottleneck
- Better scalability

### 3. Built-in Backups ✅
- Firestore handles backups automatically
- Point-in-time recovery available
- No custom backup scripts needed

### 4. Real-time Capabilities 🔮
**Future Enhancement:**
```typescript
// Listen to queue updates in real-time
getFirestore()
  .collection(Collections.DEVICE_QUEUE_STATE)
  .doc(deviceId)
  .onSnapshot((snapshot) => {
    // Push update to device via WebSocket
    const queue = snapshot.data();
    notifyDevice(deviceId, queue);
  });
```

### 5. Offline Support 🔮
**Future Enhancement:**
Devices can cache data locally and sync when online.

---

## Next Steps

### Immediate (Complete Migration)
1. ✅ ~~Update main.ts and devices route~~
2. 🔄 Update slideshow-queue service (CRITICAL)
3. 🔄 Update image-processing service (CRITICAL)
4. 🔄 Update job-queue services (CRITICAL)
5. 🔄 Update remaining routes (admin, auth, processing)
6. 🔄 Update remaining services (ingestion, google-photos, auth)
7. 🔄 Update CLI tools
8. ✅ Delete sync.ts
9. Test locally with Firestore emulator
10. Deploy to Cloud Run
11. Monitor for issues

### Future Enhancements
- Implement real-time queue updates
- Add offline support for devices
- Optimize with strategic denormalization
- Add Firestore security rules
- Implement proper caching layer
- Add performance monitoring

---

## Support & References

### Firestore Documentation
- [Firestore Node.js SDK](https://googleapis.dev/nodejs/firestore/latest/)
- [Deno with Firestore](https://deno.land/x/firestore)
- [Query Limitations](https://firebase.google.com/docs/firestore/query-data/queries#query_limitations)
- [Best Practices](https://firebase.google.com/docs/firestore/best-practices)

### Relevant Project Docs
- [DEVICE_API.md](../documents/DEVICE_API.md) - Device API documentation
- [IMAGE_PROCESSING_PIPELINE.md](../documents/IMAGE_PROCESSING_PIPELINE.md) - Processing flow
- [MIGRATION_TO_JOBS.md](../documents/MIGRATION_TO_JOBS.md) - Job queue architecture

---

**Last Updated:** January 12, 2026  
**Migration Status:** 35% Complete (6/17 critical files)  
**Next Critical File:** [src/services/slideshow-queue.ts](../src/services/slideshow-queue.ts)
