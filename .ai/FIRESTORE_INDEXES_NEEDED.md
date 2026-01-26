# Firestore Composite Indexes Required

This document lists the composite indexes needed for the slideshow-backend application to function properly.

## Required Composite Indexes

### 1. Picker Sessions - User Query with Expiry
**Collection:** `picker_sessions`
**Fields:**
- `user_id` (Ascending)
- `expire_time` (Descending)
- `created_at` (Descending)

**Purpose:** Used in `getActivePickerSession()` to find active picker sessions for a user, ordered by most recent.

**Query:**
```typescript
db.collection('picker_sessions')
  .where('user_id', '==', userId)
  .where('expire_time', '>', now)
  .orderBy('expire_time', 'desc')
  .orderBy('created_at', 'desc')
  .limit(1)
```

### 2. Auth Sessions - Token Expiry Query
**Collection:** `auth_sessions`
**Fields:**
- `token_expiry` (Descending)

**Purpose:** Used in `getActiveAuthSession()` to find unexpired auth sessions.

**Query:**
```typescript
db.collection('auth_sessions')
  .where('token_expiry', '>', now)
  .orderBy('token_expiry', 'desc')
  .limit(1)
```

### 3. Sources - Blob Hash with Status (Optional but Recommended)
**Collection:** `sources`
**Fields:**
- `blob_hash` (Ascending)
- `status` (Ascending)

**Purpose:** Optimizes queries when filtering sources by both blob and status (though not currently used in critical paths).

**Query Example:**
```typescript
db.collection('sources')
  .where('blob_hash', '==', blobHash)
  .where('status', '==', 'failed')
```

## How to Create Indexes

### Option 1: Automatic (Recommended)
Run queries in the application. When Firestore detects a missing composite index, it will provide an error message with a direct link to create the index in the Firebase Console.

Example error:
```
9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/...
```

### Option 2: Manual via Firebase Console
1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project
3. Navigate to Firestore Database → Indexes
4. Click "Create Index"
5. Enter collection name and add fields with specified sort orders

### Option 3: Via firestore.indexes.json
Create a `firestore.indexes.json` file:

```json
{
  "indexes": [
    {
      "collectionGroup": "picker_sessions",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "user_id", "order": "ASCENDING" },
        { "fieldPath": "expire_time", "order": "DESCENDING" },
        { "fieldPath": "created_at", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "auth_sessions",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "token_expiry", "order": "DESCENDING" }
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
  ],
  "fieldOverrides": []
}
```

Deploy with:
```bash
firebase deploy --only firestore:indexes
```

## Single-Field Indexes (Automatic)

Firestore automatically creates single-field indexes for most fields. The following queries work without manual index creation:

- `sources` by `status`
- `sources` by `blob_hash`
- `device_variants` by `blob_hash`
- `blobs` by `orientation`
- `blobs` by `created_at`
- `devices` by `created_at`

## Index Build Time

- Small collections (< 1000 documents): 1-2 minutes
- Medium collections (1K-100K documents): 5-30 minutes
- Large collections (> 100K documents): May take hours

You can monitor index build status in the Firebase Console under Firestore → Indexes.

## Performance Notes

### Current Implementation Considerations

1. **Home Page Orientation Stats** (`getBlobsByOrientation()`)
   - Currently fetches ALL blobs and aggregates client-side
   - Works fine for < 10K blobs
   - For larger datasets, consider:
     - Maintaining denormalized counts in a singleton document
     - Using Cloud Functions to update counts on blob creation/deletion
     - Caching results with periodic refresh

2. **Images Page Metadata** (`/ui/images`)
   - Makes N+1 queries (one per blob for sources and variant counts)
   - Current limit of 100 images keeps this manageable
   - For optimization:
     - Consider denormalizing variant count into blob documents
     - Batch queries for sources and variants
     - Implement pagination with cursor-based queries

3. **Device Count Queries**
   - Device count is fetched repeatedly across requests
   - Consider caching in memory or using Firestore count aggregation cache
   - Device count changes infrequently, so TTL cache of 5-10 minutes is safe

## Testing Index Requirements

Run these commands to verify all required indexes exist:

```bash
# Test picker session query
curl -X GET "http://localhost:8000/ui/photos-picker" \
  -H "Cookie: auth_session=<token>"

# Test images page (triggers multiple queries)
curl -X GET "http://localhost:8000/ui/images"

# Test admin stats
curl -X GET "http://localhost:8000/api/admin/stats"
```

If you see `FAILED_PRECONDITION` errors in logs, follow the provided link to create the missing index.
