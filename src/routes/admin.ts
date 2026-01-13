import { Hono } from "hono";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { requireAuth } from "../middleware/auth.ts";
import photosRoutes from "./photos.ts";
import { getFirestore, Collections } from "../db/firestore.ts";
import type { Firestore } from "@google-cloud/firestore";
import {
  countSourcesByStatus,
  deleteBlob,
  deleteSource,
  getSourcesForBlob,
  getSource,
} from "../db/helpers-firestore.ts";
import { deleteFile } from "../services/storage.ts";
import { stageImageForProcessing } from "../services/image-ingestion-v2.ts";
import { queueSourceProcessing } from "../services/job-queue-v2.ts";

const admin = new Hono();

// Mount photos routes under /photos (require authentication for Google Photos)
admin.use("/photos/*", requireAuth);
admin.route("/photos", photosRoutes);

// Admin stats endpoint
admin.get("/stats", async (c) => {
  const db = getFirestore();
  
  // Get collection counts
  const [blobsCount, sourcesCount, devicesCount, variantsCount] = await Promise.all([
    db.collection(Collections.BLOBS).count().get(),
    db.collection(Collections.SOURCES).count().get(),
    db.collection(Collections.DEVICES).count().get(),
    db.collection(Collections.DEVICE_VARIANTS).count().get(),
  ]);
  
  // Get processing status breakdown
  const statusCounts = await countSourcesByStatus();
  
  return c.json({
    blobs: blobsCount.data().count,
    sources: sourcesCount.data().count,
    devices: devicesCount.data().count,
    variants: variantsCount.data().count,
    processing: statusCounts,
  });
});

// Image upload endpoint
admin.post("/upload", async (c) => {
  const body = await c.req.parseBody();
  const files: File[] = [];
  
  // Extract all file inputs
  for (const [key, value] of Object.entries(body)) {
    if (key.startsWith("files") && value instanceof File) {
      files.push(value);
    }
  }
  
  if (files.length === 0) {
    return c.json({ error: "No files provided" }, 400);
  }
  
  console.log(`[Admin] Processing ${files.length} uploaded files`);
  
  const results = await Promise.all(
    files.map(async (file) => {
      try {
        // Write to temporary file

        const tempDir = mkdtempSync(`${tmpdir()}/slideshow-backend`);
        const ext = file.name.substring(file.name.lastIndexOf("."));
        const tempPath = `${tempDir}/${crypto.randomUUID()}${ext}`;
        
        const arrayBuffer = await file.arrayBuffer();
        writeFileSync(tempPath, new Uint8Array(arrayBuffer));
        
        // Stage for processing
        const result = await stageImageForProcessing({
          localPath: tempPath,
          origin: "upload",
          userId: undefined, // Admin upload, no user association
        });
        
        // Queue for processing
        if (result.sourceId) {
          await queueSourceProcessing(result.sourceId);
        }
        
        return {
          filename: file.name,
          success: true,
          sourceId: result.sourceId,
          status: result.status,
        };
      } catch (error) {
        console.error(`[Admin] Failed to process file ${file.name}:`, error);
        return {
          filename: file.name,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    })
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

// Delete single image endpoint
admin.delete("/images/:id", async (c) => {
  const imageId = c.req.param("id"); // Could be source_id or blob_hash
  const db = getFirestore();
  
  console.log(`[Admin] Deleting image: ${imageId}`);
  
  // Try to find as source first
  let sourceDoc = await getSource(imageId);
  
  if (sourceDoc) {
    // Found as source - delete it and check if we need to delete blob
    const blobHash = sourceDoc.blob_hash;
    
    await deleteSource(imageId);
    console.log(`[Admin] Deleted source: ${imageId}`);
    
    // Check if this was the last source for the blob
    if (blobHash) {
      const otherSources = await getSourcesForBlob(blobHash);
      
      if (otherSources.length === 0) {
        // Last source - delete blob and all variants
        const blobDoc = await db.collection(Collections.BLOBS).doc(blobHash).get();
        const blobData = blobDoc.data();
        
        // Delete blob (this will cascade to variants via helper)
        await deleteBlob(blobHash);
        console.log(`[Admin] Deleted blob and variants: ${blobHash}`);
        
        // Delete file from GCS
        if (blobData?.storage_path) {
          try {
            await deleteFile(blobData.storage_path);
            console.log(`[Admin] Deleted file from GCS: ${blobData.storage_path}`);
          } catch (error) {
            console.error(`[Admin] Failed to delete file from GCS:`, error);
          }
        }
      }
    }
    
    return c.json({ success: true, id: imageId, type: 'source' });
  }
  
  // Not found as source, try as blob
  const blobDoc = await db.collection(Collections.BLOBS).doc(imageId).get();
  
  if (blobDoc.exists) {
    const blobData = blobDoc.data();
    
    // Check for sources referencing this blob
    const sources = await getSourcesForBlob(imageId);
    
    if (sources.length > 0) {
      return c.json({ 
        error: "Cannot delete blob that is still referenced by sources",
        sourceCount: sources.length
      }, 400);
    }
    
    // Delete blob and variants
    await deleteBlob(imageId);
    console.log(`[Admin] Deleted blob and variants: ${imageId}`);
    
    // Delete file from GCS
    if (blobData?.storage_path) {
      try {
        await deleteFile(blobData.storage_path);
        console.log(`[Admin] Deleted file from GCS: ${blobData.storage_path}`);
      } catch (error) {
        console.error(`[Admin] Failed to delete file from GCS:`, error);
      }
    }
    
    return c.json({ success: true, id: imageId, type: 'blob' });
  }
  
  // Not found
  return c.json({ error: "Image not found" }, 404);
});

// Delete all images endpoint
admin.delete("/images/delete-all", async (c) => {
  const db = getFirestore();
  
  console.log("[Admin] WARNING: Deleting all images");
  
  // Get all sources, blobs, and variants
  const [sources, blobs, variants] = await Promise.all([
    db.collection(Collections.SOURCES).get(),
    db.collection(Collections.BLOBS).get(),
    db.collection(Collections.DEVICE_VARIANTS).get(),
  ]);
  
  console.log(`[Admin] Found ${sources.docs.length} sources, ${blobs.docs.length} blobs, ${variants.docs.length} variants`);
  
  // Firestore batch limit is 500 operations
  const deleteBatch = async (docs: Awaited<ReturnType<ReturnType<Firestore['collection']>['get']>>['docs']) => {
    for (let i = 0; i < docs.length; i += 500) {
      const batch = db.batch();
      const slice = docs.slice(i, Math.min(i + 500, docs.length));
      slice.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      console.log(`[Admin] Deleted batch ${i / 500 + 1}: ${slice.length} documents`);
    }
  };
  
  // Delete all documents
  await Promise.all([
    deleteBatch(sources.docs),
    deleteBatch(blobs.docs),
    deleteBatch(variants.docs),
  ]);
  
  console.log("[Admin] All images deleted from Firestore");
  
  // Note: GCS files cleanup could be done separately via lifecycle policies
  // or by iterating through storage paths (which we didn't track)
  
  return c.json({
    success: true,
    deleted: sources.docs.length,
    blobsDeleted: blobs.docs.length,
    variantsDeleted: variants.docs.length,
  });
});

export default admin;
