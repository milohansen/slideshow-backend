import { crypto } from "@std/crypto";
import { join } from "@std/path";
import { Hono } from "hono";
import { getDb } from "../db/schema.ts";
import { extractImageMetadata, getImageStats, ingestImagesFromDirectory } from "../services/image-ingestion.ts";
import { processAllImages } from "../services/image-processing.ts";
import { isGCSEnabled, uploadFile } from "../services/storage.ts";
import { getWorkerQueue, queueImageProcessing } from "../services/worker-queue.ts";
import photosRoutes from "./photos.ts";

const admin = new Hono();

// Mount photos routes under /photos
admin.route("/photos", photosRoutes);

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

/**
 * DELETE /api/admin/images/:id
 * Delete a single image and its processed versions
 */
admin.delete("/images/:id", async (c) => {
  const imageId = c.req.param("id");
  
  try {
    const db = getDb();
    
    // Get image info before deleting
    const image = db.prepare("SELECT id, file_path FROM images WHERE id = ?").get(imageId) as { id: string; file_path: string } | undefined;
    
    if (!image) {
      return c.json({ error: "Image not found" }, 404);
    }
    
    // Delete from database first
    const deletedImages = db.prepare("DELETE FROM images WHERE id = ?").run(imageId);
    const deletedProcessed = db.prepare("DELETE FROM processed_images WHERE image_id = ?").run(imageId);
    
    // Clean up files (best effort - don't fail if files don't exist)
    try {
      // Skip GCS URIs
      if (!image.file_path.startsWith("gs://")) {
        // Delete original file
        await Deno.remove(image.file_path).catch(() => {});
        
        // Delete processed files for all device sizes
        const processedBase = `data/processed`;
        for (const size of ["small-portrait", "small-landscape", "medium-portrait", "medium-landscape", "large-landscape"]) {
          await Deno.remove(join(processedBase, size, `${image.id}.jpg`)).catch(() => {});
        }
        
        // Delete thumbnail
        await Deno.remove(`data/processed/thumbnails/${image.id}.jpg`).catch(() => {});
      }
    } catch (error) {
      // Ignore file deletion errors
      console.warn(`Failed to delete files for image ${image.id}:`, error);
    }
    
    console.log(`🗑️  Deleted image ${imageId} and ${deletedProcessed} processed versions`);
    
    return c.json({
      success: true,
      id: imageId,
      processedDeleted: deletedProcessed,
    });
  } catch (error) {
    console.error(`Failed to delete image ${imageId}:`, error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to delete image",
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
    
    console.log(`🗑️  Deleted ${deletedImages} images and ${deletedProcessed} processed versions`);
    
    return c.json({
      success: true,
      deleted: deletedImages,
      processedDeleted: deletedProcessed,
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
