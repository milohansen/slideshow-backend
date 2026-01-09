import { crypto } from "@std/crypto";
import { join } from "@std/path";
import { Hono } from "hono";
import { getDb } from "../db/schema.ts";
import { getAccessToken, getUserId } from "../middleware/auth.ts";
import { createPickerSession, deletePickerSession, getAllMediaItems, getPickerSessionStatus, updatePickerSession } from "../services/google-photos.ts";
import { extractImageMetadata, getImageStats, ingestImagesFromDirectory } from "../services/image-ingestion.ts";
import { processAllImages } from "../services/image-processing.ts";
import { isGCSEnabled, uploadFile } from "../services/storage.ts";
import { getWorkerQueue, queueImageProcessing } from "../services/worker-queue.ts";

const admin = new Hono();

// Get image statistics
admin.get("/stats", (c) => {
  const stats = getImageStats();
  const queueStats = getWorkerQueue().getStatus();
  return c.json({
    ...stats,
    processing: queueStats,
  });
});

// Trigger image ingestion
admin.post("/ingest", async (c) => {
  const body = await c.req.json();
  const { directory, recursive = true } = body;

  if (!directory) {
    return c.json({ error: "Directory path required" }, 400);
  }

  try {
    await Deno.stat(directory);
  } catch {
    return c.json({ error: `Directory not found: ${directory}` }, 404);
  }

  // Run ingestion asynchronously
  const result = await ingestImagesFromDirectory(directory, {
    recursive,
    verbose: false,
  });

  return c.json({
    success: true,
    result,
  });
});

// Trigger image processing
admin.post("/process", async (c) => {
  const outputDir = "data/processed";

  const result = await processAllImages(outputDir, {
    verbose: false,
  });

  return c.json({
    success: true,
    result,
  });
});

// Upload images
admin.post("/upload", async (c) => {
  try {
    const body = await c.req.parseBody();
    const files = [];

    // Handle multiple files
    for (const [key, value] of Object.entries(body)) {
      if (key.startsWith("files") && value instanceof File) {
        files.push(value);
      }
    }

    if (files.length === 0) {
      return c.json({ error: "No files provided" }, 400);
    }

    const results = [];
    const uploadDir = "data/uploads";

    // Create upload directory if it doesn't exist
    try {
      await Deno.mkdir(uploadDir, { recursive: true });
    } catch {
      // Directory already exists
    }

    for (const file of files) {
      try {
        // Validate file type
        const ext = `.${file.name.split(".").pop()?.toLowerCase()}`;
        const supportedExtensions = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

        if (!supportedExtensions.includes(ext)) {
          results.push({
            filename: file.name,
            success: false,
            error: `Unsupported file type: ${ext}`,
          });
          continue;
        }

        // Save file to temporary location
        const tempPath = join(uploadDir, `${crypto.randomUUID()}${ext}`);
        const arrayBuffer = await file.arrayBuffer();
        await Deno.writeFile(tempPath, new Uint8Array(arrayBuffer));

        // Extract metadata
        const metadata = await extractImageMetadata(tempPath);
        const imageId = crypto.randomUUID();

        // Upload to GCS if enabled, otherwise keep local
        let storagePath = tempPath;
        if (isGCSEnabled()) {
          try {
            const gcsPath = `images/originals/${imageId}${ext}`;
            const gcsUri = await uploadFile(tempPath, gcsPath, file.type || "image/jpeg");
            storagePath = gcsUri;
            // Clean up local temp file after successful GCS upload
            await Deno.remove(tempPath).catch(() => {});
          } catch (error) {
            console.error(`Failed to upload to GCS:`, error);
          }
        }

        // Store in database
        const db = getDb();
        db.prepare(
          `
          INSERT INTO images (
            id, file_path, file_hash, width, height, orientation, last_modified
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
        ).run(imageId, storagePath, metadata.fileHash, metadata.width, metadata.height, metadata.orientation, metadata.lastModified.toISOString());

        results.push({
          filename: file.name,
          success: true,
          id: imageId,
          dimensions: `${metadata.width}x${metadata.height}`,
          orientation: metadata.orientation,
        });

        // Queue image processing for all device sizes
        queueImageProcessing(imageId);
      } catch (error) {
        results.push({
          filename: file.name,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    return c.json({
      success: successCount > 0,
      uploaded: successCount,
      failed: failCount,
      results,
    });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Upload failed",
      },
      500
    );
  }
});

// Google Photos Picker API routes

/**
 * POST /api/admin/photos/picker/create
 * Create a new Google Photos Picker session
 */
admin.post("/photos/picker/create", async (c) => {
  const accessToken = getAccessToken(c);
  const userId = getUserId(c);

  if (!accessToken || !userId) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  try {
    const session = await createPickerSession(accessToken, userId);

    return c.json({
      success: true,
      sessionId: session.picker_session_id,
      pickerUri: session.picker_uri,
      pollingConfig: session.polling_config ? JSON.parse(session.polling_config) : null,
    });
  } catch (error) {
    console.error("Failed to create picker session:", error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to create picker session",
      },
      500
    );
  }
});

/**
 * GET /api/admin/photos/picker/:sessionId
 * Get picker session status
 */
admin.get("/photos/picker/:sessionId", async (c) => {
  const accessToken = getAccessToken(c);
  const sessionId = c.req.param("sessionId");

  if (!accessToken) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  try {
    const status = await getPickerSessionStatus(accessToken, sessionId);

    // If pickerUri is missing, the session has expired
    if (!status.pickerUri) {
      console.log(`⏰ Session ${sessionId} has expired (no pickerUri)`);
      deletePickerSession(sessionId);
      return c.json({
        success: false,
        expired: true,
        error: "Session has expired. Please create a new session.",
      }, 410); // 410 Gone
    }

    // Update local database
    updatePickerSession(sessionId, status.mediaItemsSet);

    return c.json({
      success: true,
      sessionId: status.id,
      pickerUri: status.pickerUri,
      mediaItemsSet: status.mediaItemsSet,
      pollingConfig: status.pollingConfig,
    });
  } catch (error) {
    console.error("Failed to get picker session status:", error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to get session status",
      },
      500
    );
  }
});

/**
 * GET /api/admin/photos/picker/:sessionId/media
 * List media items from picker session
 */
admin.get("/photos/picker/:sessionId/media", async (c) => {
  const accessToken = getAccessToken(c);
  const sessionId = c.req.param("sessionId");

  if (!accessToken) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  try {
    // First check if media items have been selected
    const status = await getPickerSessionStatus(accessToken, sessionId);

    if (!status.mediaItemsSet) {
      return c.json({
        success: false,
        error: "No media items selected yet. Please open the picker and select photos first.",
        mediaItemsSet: false,
      });
    }

    const mediaItems = await getAllMediaItems(accessToken, sessionId);

    return c.json({
      success: true,
      count: mediaItems.length,
      mediaItems: mediaItems.map((item) => ({
        id: item.mediaItemId,
        filename: item.filename,
        mediaType: item.mediaType,
        mimeType: item.mimeType,
        baseUrl: item.baseUrl,
        productUrl: item.productUrl,
        metadata: item.mediaMetadata,
      })),
    });
  } catch (error) {
    console.error("Failed to list media items:", error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to list media items",
      },
      500
    );
  }
});

/**
 * POST /api/admin/photos/picker/:sessionId/ingest
 * Ingest media items from picker session into slideshow
 */
admin.post("/photos/picker/:sessionId/ingest", async (c) => {
  const accessToken = getAccessToken(c);
  const sessionId = c.req.param("sessionId");

  if (!accessToken) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  try {
    // First check if media items have been selected
    const status = await getPickerSessionStatus(accessToken, sessionId);

    if (!status.mediaItemsSet) {
      return c.json(
        {
          error: "No media items selected yet. Please open the picker and select photos first.",
        },
        400
      );
    }

    // Get media items
    const mediaItems = await getAllMediaItems(accessToken, sessionId);

    // Filter for images only
    const images = mediaItems.filter((item) => item.mediaType === "IMAGE");

    console.log(`📥 Starting ingestion of ${images.length} images from Google Photos`);

    // Import from services/image-ingestion.ts - we'll extend this next
    const { ingestFromGooglePhotos } = await import("../services/image-ingestion.ts");

    const results = await ingestFromGooglePhotos(images);

    // Clean up the session now that we've ingested the media
    // Sessions expire shortly after media selection per Google's docs
    deletePickerSession(sessionId);

    return c.json({
      success: true,
      total: images.length,
      ingested: results.ingested,
      skipped: results.skipped,
      failed: results.failed,
      details: results.details,
    });
  } catch (error) {
    console.error("Failed to ingest media items:", error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to ingest media items",
      },
      500
    );
  }
});

/**
 * DELETE /api/admin/images/delete-all
 * Delete all images and their processed versions (for debugging)
 */
admin.delete("/images/delete-all", async (c) => {
  try {
    const db = getDb();
    
    // Get all image file paths before deleting
    const images = db.prepare("SELECT id, file_path FROM images").all() as Array<{ id: string; file_path: string }>;
    
    // Delete from database first
    const deletedImages = db.prepare("DELETE FROM images").run();
    const deletedProcessed = db.prepare("DELETE FROM processed_images").run();
    
    // Clean up files (best effort - don't fail if files don't exist)
    for (const image of images) {
      try {
        // Skip GCS URIs
        if (image.file_path.startsWith("gs://")) {
          continue;
        }
        
        // Delete original file
        await Deno.remove(image.file_path).catch(() => {});
        
        // Delete processed files for all device sizes
        const processedBase = `data/processed`;
        for (const size of ["small-portrait", "small-landscape", "medium-portrait", "medium-landscape", "large-landscape"]) {
          await Deno.remove(join(processedBase, size, `${image.id}.jpg`)).catch(() => {});
        }
        
        // Delete thumbnail
        await Deno.remove(`data/processed/thumbnails/${image.id}.jpg`).catch(() => {});
      } catch (error) {
        // Ignore file deletion errors
        console.warn(`Failed to delete files for image ${image.id}:`, error);
      }
    }
    
    console.log(`🗑️  Deleted ${deletedImages.changes} images and ${deletedProcessed.changes} processed versions`);
    
    return c.json({
      success: true,
      deleted: deletedImages.changes,
      processedDeleted: deletedProcessed.changes,
    });
  } catch (error) {
    console.error("Failed to delete all images:", error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to delete images",
      },
      500
    );
  }
});

export default admin;
