# Post-Implementation Testing Checklist

Use this checklist to verify all implemented functionality works correctly after deployment.

## Prerequisites

- [ ] Firestore initialized with proper credentials
- [ ] GCS bucket configured and accessible
- [ ] Job queue (Cloud Run Jobs) configured
- [ ] Application deployed and running

---

## 1. Firestore Indexes

### Test Index Requirements

Run each test and verify no `FAILED_PRECONDITION` errors appear:

- [ ] **Test 1: Home Page**
  ```bash
  curl -X GET "http://localhost:8000/ui/"
  ```
  - Should load without index errors
  - Check logs for Firestore query errors

- [ ] **Test 2: Images Page**
  ```bash
  curl -X GET "http://localhost:8000/ui/images"
  ```
  - Should load without index errors
  - Verify processing status displays correctly

- [ ] **Test 3: Photos Picker (with auth)**
  ```bash
  curl -X GET "http://localhost:8000/ui/photos-picker" \
    -H "Cookie: auth_session=YOUR_SESSION_TOKEN"
  ```
  - If you see `FAILED_PRECONDITION`, create the picker_sessions index
  - Follow the error message link to Firebase Console

### Create Missing Indexes

If any test above fails with index errors:

1. Copy the URL from the error message
2. Open in browser
3. Click "Create Index"
4. Wait for index to build (1-30 minutes depending on data size)
5. Re-run the test

---

## 2. UI Routes Testing

### Home Page (`GET /ui/`)

- [ ] Page loads successfully
- [ ] Total images count displayed
- [ ] Total devices count displayed
- [ ] Processed variants count displayed
- [ ] Orientation breakdown shows counts (portrait/landscape/square)

**Verify in browser:**
```
http://localhost:8000/ui/
```

**Expected Output:** Stats dashboard with numeric values, not empty objects

---

### Images Page (`GET /ui/images`)

- [ ] Page loads successfully
- [ ] Up to 100 images displayed
- [ ] Each image shows:
  - [ ] Thumbnail or image reference
  - [ ] Dimensions (width × height)
  - [ ] Orientation
  - [ ] Processing status (staged/processing/complete/failed)
  - [ ] Error message if failed
  - [ ] Processed count (X/Y devices)
  - [ ] Color palette (if available)

**Test Scenarios:**

1. **With staged images:**
   - Upload images via admin endpoint
   - Verify they show "staged" status

2. **With processing images:**
   - Should show "processing" status while job runs
   - May be brief, check logs if missed

3. **With failed images:**
   - If any processing failed, verify:
     - [ ] Status shows "failed"
     - [ ] Error message displayed
     - [ ] Retry button available

4. **With completed images:**
   - [ ] Status shows "complete"
   - [ ] Processed count matches device count

**Verify in browser:**
```
http://localhost:8000/ui/images
```

---

### Retry Failed Processing (`POST /ui/images/:id/retry`)

**Prerequisites:** At least one failed image exists

**Test Steps:**

1. [ ] Click retry button on failed image
2. [ ] Verify redirect back to images page
3. [ ] Check image status changed from "failed" to "staged"
4. [ ] Verify job queue received the source ID
5. [ ] Wait for processing to complete
6. [ ] Verify status updates to "complete" or "failed" again

**Manual API Test:**
```bash
# Replace SOURCE_ID with actual failed source ID
curl -X POST "http://localhost:8000/ui/images/SOURCE_ID/retry" \
  -L -v
```

**Expected:** 302 redirect to `/ui/images`

**Check Logs for:**
```
[UI] Retrying source: SOURCE_ID
[UI] Source queued for reprocessing: SOURCE_ID
```

---

### Photos Picker (`GET /ui/photos-picker`)

**Test Scenarios:**

1. **Without authentication:**
   - [ ] Access `/ui/photos-picker`
   - [ ] Verify redirect to `/auth/google`

2. **With authentication (no active session):**
   - [ ] Login via Google OAuth
   - [ ] Access `/ui/photos-picker`
   - [ ] Verify picker loads with no session
   - [ ] Session state shows `null`

3. **With authentication (active session):**
   - [ ] Create picker session via photos API
   - [ ] Access `/ui/photos-picker`
   - [ ] Verify picker loads with session data
   - [ ] Session shows `sessionId` and `pickerUri`

**Verify in browser:**
```
http://localhost:8000/ui/photos-picker
```

---

## 3. Admin Routes Testing

### Admin Stats (`GET /api/admin/stats`)

- [ ] Endpoint accessible
- [ ] Returns JSON with stats
- [ ] All counts are numeric (not null/undefined)
- [ ] Processing status breakdown included

**Test:**
```bash
curl -X GET "http://localhost:8000/api/admin/stats" | jq
```

**Expected Response:**
```json
{
  "blobs": 1234,
  "sources": 1456,
  "devices": 3,
  "variants": 3702,
  "processing": {
    "staged": 12,
    "processing": 5,
    "ready": 1439,
    "failed": 0
  }
}
```

**Verify:**
- [ ] All numbers are reasonable
- [ ] `blobs` ≈ `sources` (may differ due to duplicates)
- [ ] `variants` ≥ `blobs` × `devices` (should be equal or greater)
- [ ] `processing.staged + processing.processing + processing.ready + processing.failed = sources`

---

### Image Upload (`POST /api/admin/upload`)

**Test with single file:**
```bash
curl -X POST "http://localhost:8000/api/admin/upload" \
  -F "files=@/path/to/test-image.jpg" \
  | jq
```

**Expected Response:**
```json
{
  "success": true,
  "uploaded": 1,
  "failed": 0,
  "results": [
    {
      "filename": "test-image.jpg",
      "success": true,
      "sourceId": "uuid-string",
      "status": "staged"
    }
  ]
}
```

**Verify:**
- [ ] Response has `success: true`
- [ ] `uploaded` count matches number of files sent
- [ ] Each result has `sourceId`
- [ ] Status is "staged"

**Check Firestore:**
```bash
# Verify source created
# Use Firebase Console or gcloud CLI
```

**Check GCS:**
- [ ] File uploaded to staging bucket
- [ ] File path matches `staging/{sourceId}.{ext}`

**Test with multiple files:**
```bash
curl -X POST "http://localhost:8000/api/admin/upload" \
  -F "files[]=@/path/to/image1.jpg" \
  -F "files[]=@/path/to/image2.jpg" \
  -F "files[]=@/path/to/image3.jpg" \
  | jq
```

**Verify:**
- [ ] All 3 files uploaded successfully
- [ ] Each has unique `sourceId`
- [ ] All sources created in Firestore
- [ ] All files in GCS staging

**Test error handling:**
```bash
# Try with invalid file
curl -X POST "http://localhost:8000/api/admin/upload" \
  -F "files=@/path/to/invalid.txt" \
  | jq
```

**Expected:**
- [ ] Some files may fail
- [ ] `failed` count reflects failures
- [ ] Results include error messages

---

### Delete Single Image (`DELETE /api/admin/images/:id`)

**Test Setup:**
1. Upload a test image
2. Wait for processing to complete
3. Note the source_id or blob_hash

**Test 1: Delete by source_id**
```bash
curl -X DELETE "http://localhost:8000/api/admin/images/SOURCE_ID" \
  -v | jq
```

**Expected Response:**
```json
{
  "success": true,
  "id": "SOURCE_ID",
  "type": "source"
}
```

**Verify:**
- [ ] Response shows success
- [ ] Type is "source"
- [ ] Source deleted from Firestore
- [ ] If last source for blob, blob also deleted

**Test 2: Delete by blob_hash**
```bash
curl -X DELETE "http://localhost:8000/api/admin/images/BLOB_HASH" \
  -v | jq
```

**Scenarios:**

1. **Blob with no sources:**
   - [ ] Blob deleted successfully
   - [ ] All variants deleted
   - [ ] GCS files deleted
   - [ ] Response type is "blob"

2. **Blob with existing sources:**
   - [ ] Request fails with 400 error
   - [ ] Error message: "Cannot delete blob that is still referenced by sources"
   - [ ] sourceCount included in response

**Test 3: Delete non-existent image**
```bash
curl -X DELETE "http://localhost:8000/api/admin/images/invalid-id" \
  -v | jq
```

**Expected:**
- [ ] 404 Not Found
- [ ] Error message: "Image not found"

**Verify Cascade Behavior:**

1. Upload image → Process → Delete source
   - [ ] If only source: blob + variants + GCS files deleted
   - [ ] If multiple sources: only source deleted, blob remains

2. Check Firestore:
   - [ ] Source document removed
   - [ ] Blob document removed (if last source)
   - [ ] Variant documents removed (if last source)

3. Check GCS:
   - [ ] Storage files removed (if last source)
   - [ ] Files remain if other sources reference blob

---

### Delete All Images (`DELETE /api/admin/images/delete-all`)

**⚠️ WARNING: This is destructive! Test in isolated environment only!**

**Test Setup:**
1. Create test environment with sample data
2. Verify you can afford to lose all images

**Test:**
```bash
curl -X DELETE "http://localhost:8000/api/admin/images/delete-all" \
  -v | jq
```

**Expected Response:**
```json
{
  "success": true,
  "deleted": 10,
  "blobsDeleted": 8,
  "variantsDeleted": 24
}
```

**Verify:**
- [ ] Response shows success
- [ ] Counts match pre-delete stats
- [ ] All sources removed from Firestore
- [ ] All blobs removed from Firestore
- [ ] All variants removed from Firestore

**Check Firestore Collections:**
```bash
# Verify collections are empty
# sources: should be empty
# blobs: should be empty
# device_variants: should be empty
```

**Check GCS:**
- [ ] Files still exist (cleanup not implemented)
- [ ] Consider setting lifecycle policies to clean old files

**Post-Delete:**
- [ ] Home page shows 0 images
- [ ] Images page shows no images
- [ ] Stats endpoint returns 0s

---

## 4. Integration Testing

### End-to-End Upload → Process → Display Flow

1. **Upload images:**
   ```bash
   curl -X POST "http://localhost:8000/api/admin/upload" \
     -F "files=@test1.jpg" \
     -F "files=@test2.jpg"
   ```
   - [ ] Both files uploaded successfully
   - [ ] Source IDs returned

2. **Verify staging:**
   - [ ] Images appear on `/ui/images` with "staged" status
   - [ ] Processing count shows 0/N

3. **Wait for processing:**
   - [ ] Status changes to "processing"
   - [ ] Then changes to "complete"
   - [ ] Processing count updates to N/N

4. **Verify results:**
   - [ ] Blobs created in Firestore
   - [ ] Variants created for each device
   - [ ] Color palettes extracted
   - [ ] GCS files in processed location

5. **Test retry:**
   - [ ] If any failed, click retry
   - [ ] Verify reprocessing works

6. **Test delete:**
   - [ ] Delete one image via API
   - [ ] Verify removal from UI
   - [ ] Verify Firestore cleanup

---

## 5. Performance Testing

### Home Page Performance

```bash
# Measure response time
time curl -s "http://localhost:8000/ui/" > /dev/null
```

**Expected:**
- [ ] < 1 second with < 10K blobs
- [ ] < 3 seconds with < 50K blobs

**If slow:**
- Check Firestore query performance in Cloud Console
- Consider denormalization (see IMPLEMENTATION_COMPLETE.md)

---

### Images Page Performance

```bash
# Measure response time
time curl -s "http://localhost:8000/ui/images" > /dev/null
```

**Expected:**
- [ ] < 2 seconds with 100 images shown
- [ ] Linear growth with image count

**If slow:**
- Verify indexes are created
- Check N+1 query pattern in logs
- Consider denormalization

---

### Upload Performance

```bash
# Upload 10 files and measure time
time curl -X POST "http://localhost:8000/api/admin/upload" \
  -F "files[]=@img1.jpg" \
  -F "files[]=@img2.jpg" \
  # ... 8 more files
  > /dev/null
```

**Expected:**
- [ ] ~500ms per file + network overhead
- [ ] Staging completes before timeout (60s default)

---

## 6. Error Handling Testing

### Firestore Connection Errors

1. **Temporarily disable Firestore credentials**
2. **Access any route**
3. **Verify:**
   - [ ] Error logged clearly
   - [ ] User sees meaningful error message
   - [ ] No crash/stack trace exposed

---

### GCS Connection Errors

1. **Temporarily disable GCS credentials**
2. **Upload image**
3. **Verify:**
   - [ ] Upload fails gracefully
   - [ ] Error message returned to user
   - [ ] Firestore not left in inconsistent state

---

### Job Queue Errors

1. **Queue source with invalid ID**
2. **Verify:**
   - [ ] Error logged
   - [ ] User notified
   - [ ] No system crash

---

## 7. Security Testing

### Test Without Authentication

- [ ] Admin endpoints accessible? (should be restricted for production)
- [ ] Photos picker redirects to login? (yes)
- [ ] Delete operations restricted? (consider adding auth)

**Production Recommendations:**
- Add authentication middleware to:
  - [ ] `POST /api/admin/upload`
  - [ ] `DELETE /api/admin/images/:id`
  - [ ] `DELETE /api/admin/images/delete-all`
  - [ ] `GET /api/admin/stats`

---

## 8. Monitoring & Logging

### Check Logs

**During normal operation:**
```bash
# View application logs
deno task logs
# or
gcloud logging read "resource.type=cloud_run_revision" --limit 50
```

**Verify logging includes:**
- [ ] Successful operations logged
- [ ] Errors logged with context
- [ ] Firestore query performance logged
- [ ] Job queue submissions logged

**Key log messages to verify:**
- `[UI] Retrying source: {id}`
- `[Admin] Processing X uploaded files`
- `[Admin] Deleting image: {id}`
- Firestore query errors (should be none after indexes created)

---

## 9. Data Consistency Checks

### Verify Data Integrity

1. **Source → Blob consistency:**
   ```
   For each source with blob_hash:
   - Verify blob exists in blobs collection
   ```

2. **Blob → Variants consistency:**
   ```
   For each blob:
   - Count variants where blob_hash matches
   - Should match processedCount in UI
   ```

3. **Device → Variants consistency:**
   ```
   For each device:
   - Count variants for device dimensions
   - Should match across all blobs
   ```

**Run consistency check script** (if available):
```bash
deno run --allow-env --allow-net scripts/check-consistency.ts
```

---

## 10. Production Readiness

### Final Checklist

- [ ] All tests above passed
- [ ] Firestore indexes created and enabled
- [ ] GCS bucket lifecycle policies configured
- [ ] Authentication added to admin endpoints
- [ ] Monitoring and alerting configured
- [ ] Backup strategy for Firestore in place
- [ ] Rate limiting configured
- [ ] Error tracking (Sentry, etc.) integrated
- [ ] Documentation updated
- [ ] Team trained on new system

---

## Troubleshooting

### Common Issues

**Issue: FAILED_PRECONDITION errors**
- **Cause:** Missing Firestore composite index
- **Solution:** Click link in error message to create index

**Issue: Images page slow**
- **Cause:** N+1 queries for sources/variants
- **Solution:** Implement denormalization (see IMPLEMENTATION_COMPLETE.md)

**Issue: Upload fails silently**
- **Cause:** GCS permissions or quota issues
- **Solution:** Check service account permissions and GCS quotas

**Issue: Processing never completes**
- **Cause:** Job queue not initialized or processor not running
- **Solution:** Check job queue configuration and processor logs

**Issue: Delete doesn't remove GCS files**
- **Cause:** GCS permissions or file paths incorrect
- **Solution:** Verify service account has storage.objects.delete permission

---

## Success Criteria

✅ **System is production-ready when:**

1. All UI routes display data correctly
2. Upload, retry, and delete operations work
3. No Firestore index errors in logs
4. Performance meets expectations (< 3s page loads)
5. Error handling is graceful
6. Authentication protects sensitive endpoints
7. Monitoring catches issues proactively
8. Data consistency verified across collections

---

**Testing Date:** _________________  
**Tested By:** _________________  
**Environment:** _________________  
**Status:** ⬜ Pass | ⬜ Fail | ⬜ Pass with Notes  
**Notes:**

---
