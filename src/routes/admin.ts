import { crypto } from "@std/crypto";
import { join } from "@std/path";
import { Hono } from "hono";
import { getDb } from "../db/schema.ts";
import { extractImageMetadata, getImageStats, ingestImagesFromDirectory } from "../services/image-ingestion.ts";
import { processAllImages } from "../services/image-processing.ts";
import { isGCSEnabled, uploadFile } from "../services/storage.ts";

const admin = new Hono();

/**
 * Process an image for all device sizes in a web worker
 */
function processImageInBackground(imageId: string) {
  const workerUrl = new URL("../workers/image-processor.ts", import.meta.url);
  const worker = new Worker(workerUrl.href, {
    type: "module",
    deno: {
      permissions: {
        read: true,
        write: true,
        env: true,
        net: true,
        run: true,
        ffi: true,
      },
    },
  });

  worker.postMessage({
    imageId,
    outputDir: "data/processed",
  });

  worker.onmessage = (e: MessageEvent) => {
    const { success, imageId, error } = e.data;
    if (success) {
      console.log(`✓ Worker completed processing for ${imageId}`);
    } else {
      console.error(`✗ Worker failed for ${imageId}:`, error);
    }
  };

  worker.onerror = (e: ErrorEvent) => {
    console.error(`Worker error for ${imageId}:`, e.message);
  };
}

// Get image statistics
admin.get("/stats", (c) => {
  const stats = getImageStats();
  return c.json(stats);
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
        db.prepare(`
          INSERT INTO images (
            id, file_path, file_hash, width, height, orientation, last_modified
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          imageId,
          storagePath,
          metadata.fileHash,
          metadata.width,
          metadata.height,
          metadata.orientation,
          metadata.lastModified.toISOString()
        );
        
        results.push({
          filename: file.name,
          success: true,
          id: imageId,
          dimensions: `${metadata.width}x${metadata.height}`,
          orientation: metadata.orientation,
        });
        
        // Process image in background for all device sizes
        processImageInBackground(imageId);
        
      } catch (error) {
        results.push({
          filename: file.name,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
    
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    
    return c.json({
      success: successCount > 0,
      uploaded: successCount,
      failed: failCount,
      results,
    });
    
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : "Upload failed",
    }, 500);
  }
});

export default admin;
