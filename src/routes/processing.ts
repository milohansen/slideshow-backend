/**
 * Processing API routes for Cloud Run Job coordination
 */

import { Hono } from "hono";
import type { Context, Next } from "hono";
import { getDb } from "../db/schema.ts";
import { parseGCSUri } from "../services/storage.ts";

const app = new Hono();

/**
 * Middleware to validate processor service account
 */
async function validateProcessorAuth(c: Context, next: Next): Promise<void> {
  const authHeader = c.req.header("Authorization");
  const expectedToken = Deno.env.get("PROCESSOR_AUTH_TOKEN");

  if (!expectedToken) {
    console.warn("⚠️ PROCESSOR_AUTH_TOKEN not configured - skipping auth validation");
    await next();
    return;
  }

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.substring(7);
  if (token !== expectedToken) {
    return c.json({ error: "Invalid authentication token" }, 403);
  }

  await next();
}

// Apply auth middleware to all routes
app.use("*", validateProcessorAuth);

/**
 * GET /api/processing/pending
 * Returns up to 50 images with processing_status='pending'
 */
app.get("/pending", (c) => {
  const limit = parseInt(c.req.query("limit") || "50");
  const maxLimit = Math.min(limit, 50);

  const db = getDb();
  const images = db.prepare(`
    SELECT id, file_path, width, height, orientation
    FROM images
    WHERE processing_status = 'pending'
    ORDER BY ingested_at ASC
    LIMIT ?
  `).all(maxLimit) as Array<{
    id: string;
    file_path: string;
    width: number;
    height: number;
    orientation: string;
  }>;

  console.log(`📋 Returning ${images.length} pending images for processing`);
  return c.json(images);
});

/**
 * POST /api/processing-attempts/:imageId/start
 * Registers a processing attempt and returns device list
 */
app.post("/:imageId/start", (c) => {
  const imageId = c.req.param("imageId");
  const db = getDb();

  // Verify image exists and is pending
  const image = db.prepare(`
    SELECT id, processing_status
    FROM images
    WHERE id = ?
  `).get(imageId) as { id: string; processing_status: string } | undefined;

  if (!image) {
    return c.json({ error: "Image not found" }, 404);
  }

  // Get all registered devices
  const devices = db.prepare(`
    SELECT name, width, height, orientation
    FROM devices
    ORDER BY name
  `).all() as Array<{
    name: string;
    width: number;
    height: number;
    orientation: string;
  }>;

  if (devices.length === 0) {
    return c.json({ error: "No devices registered" }, 500);
  }

  // Update status to processing (if not already)
  if (image.processing_status === 'pending') {
    db.prepare(`
      UPDATE images
      SET processing_status = 'processing'
      WHERE id = ?
    `).run(imageId);
  }

  // TODO: Track attempt count in database (future enhancement)
  const attempt = 1;

  console.log(`🎬 Started processing ${imageId} (attempt ${attempt}) for ${devices.length} devices`);

  return c.json({
    attempt,
    devices,
  });
});

/**
 * POST /api/processed-images
 * Accepts batch of processed image results from processor
 */
app.post("/", async (c) => {
  const body = await c.req.json();
  const images = body.images as Array<{
    imageId: string;
    deviceSize: string;
    width: number;
    height: number;
    filePath: string;
    colorPalette: {
      primary: string;
      secondary: string;
      tertiary: string;
      sourceColor: string;
      allColors: string[];
    };
  }>;

  if (!images || !Array.isArray(images)) {
    return c.json({ error: "Expected 'images' array in request body" }, 400);
  }

  const db = getDb();
  const inserted = [];
  const errors = [];

  for (const img of images) {
    try {
      // Verify device exists
      const device = db.prepare(`
        SELECT name FROM devices WHERE name = ?
      `).get(img.deviceSize);

      if (!device) {
        errors.push({
          imageId: img.imageId,
          deviceSize: img.deviceSize,
          error: "Device not found",
        });
        continue;
      }

      // Generate ID for processed image
      const processedId = `${img.imageId}_${img.deviceSize}`;

      // Insert or replace processed image
      db.prepare(`
        INSERT OR REPLACE INTO processed_images (
          id, image_id, device_size, width, height, file_path,
          color_primary, color_secondary, color_tertiary, color_source, color_palette,
          processed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        processedId,
        img.imageId,
        img.deviceSize,
        img.width,
        img.height,
        img.filePath,
        img.colorPalette.primary,
        img.colorPalette.secondary,
        img.colorPalette.tertiary,
        img.colorPalette.sourceColor,
        JSON.stringify(img.colorPalette.allColors)
      );

      inserted.push(processedId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push({
        imageId: img.imageId,
        deviceSize: img.deviceSize,
        error: errorMessage,
      });
    }
  }

  // Check if all devices have been processed for each image
  const imageIds = [...new Set(images.map(img => img.imageId))];
  
  for (const imageId of imageIds) {
    const totalDevices = db.prepare(`SELECT COUNT(*) as count FROM devices`).get() as { count: number };
    const processedDevices = db.prepare(`
      SELECT COUNT(*) as count FROM processed_images WHERE image_id = ?
    `).get(imageId) as { count: number };

    if (processedDevices.count >= totalDevices.count) {
      // All devices processed - mark image as complete
      db.prepare(`
        UPDATE images
        SET processing_status = 'complete', processing_error = NULL
        WHERE id = ?
      `).run(imageId);
      console.log(`✅ Image ${imageId} fully processed for all devices`);
    }
  }

  console.log(`💾 Stored ${inserted.length} processed images`);
  if (errors.length > 0) {
    console.warn(`⚠️ ${errors.length} errors during batch insert`);
  }

  return c.json({
    inserted: inserted.length,
    errors: errors.length > 0 ? errors : undefined,
  });
});

/**
 * PATCH /api/images/:id/failed
 * Marks an image as failed after processor error
 */
app.patch("/:id/failed", async (c) => {
  const imageId = c.req.param("id");
  const body = await c.req.json();
  const error = body.error as string;
  const attempt = body.attempt as number;

  const db = getDb();

  // Update image status to failed
  db.prepare(`
    UPDATE images
    SET processing_status = 'failed',
        processing_error = ?
    WHERE id = ?
  `).run(error, imageId);

  console.log(`❌ Marked image ${imageId} as failed (attempt ${attempt}): ${error}`);

  return c.json({ success: true });
});

/**
 * V2 API: Check if a blob hash already exists (duplicate detection)
 * GET /api/processing/check-hash/:hash
 */
app.get("/check-hash/:hash", (c) => {
  const { hash } = c.req.param();
  
  // Check in new blobs table
  const db = getDb();
  const result = db.prepare("SELECT hash FROM blobs WHERE hash = ?").get(hash);
  const exists = result !== undefined;
  
  return c.json({
    exists,
    hash,
  });
});

/**
 * V2 API: Finalize image processing
 * Called by processor after completing all work for a source
 * 
 * POST /api/processing/finalize
 */
app.post("/finalize", async (c) => {
  try {
    const body = await c.req.json();
    const { sourceId, blobHash, blobData, colorData, variants } = body;

    // Validate required fields
    if (!sourceId || !blobHash) {
      return c.json({ error: "Missing required fields: sourceId, blobHash" }, 400);
    }

    const db = getDb();
    
    // Check if source exists
    const source = db.prepare("SELECT * FROM sources WHERE id = ?").get(sourceId);
    if (!source) {
      return c.json({ error: `Source ${sourceId} not found` }, 404);
    }

    // Create or update blob record
    const existingBlob = db.prepare("SELECT hash FROM blobs WHERE hash = ?").get(blobHash);
    
    if (!existingBlob) {
      if (!blobData) {
        return c.json({ error: "blobData required for new blobs" }, 400);
      }

      db.prepare(`
        INSERT INTO blobs (
          hash, storage_path, width, height, aspect_ratio, orientation,
          file_size, mime_type, color_palette, color_source, blurhash, exif_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        blobHash,
        blobData.storage_path,
        blobData.width,
        blobData.height,
        blobData.aspect_ratio,
        blobData.orientation,
        blobData.file_size || null,
        blobData.mime_type || null,
        colorData?.palette || null,
        colorData?.source || null,
        blobData.blurhash || null,
        blobData.exif_data || null
      );
      console.log(`[Processing] Created blob ${blobHash}`);
    } else if (colorData) {
      // Update color data if provided
      db.prepare(`
        UPDATE blobs 
        SET color_palette = ?, color_source = ?
        WHERE hash = ?
      `).run(colorData.palette, colorData.source, blobHash);
      console.log(`[Processing] Updated colors for blob ${blobHash}`);
    }

    // Create device variants
    if (variants && Array.isArray(variants)) {
      for (const variant of variants) {
        try {
          const variantId = crypto.randomUUID();
          db.prepare(`
            INSERT INTO device_variants (
              id, blob_hash, width, height, orientation, layout_type, storage_path, file_size
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            variantId,
            blobHash,
            variant.width,
            variant.height,
            variant.orientation,
            variant.layout_type || "single",
            variant.storage_path,
            variant.file_size || null
          );
          console.log(`[Processing] Created variant ${variantId} (${variant.width}x${variant.height}, ${variant.layout_type || "single"})`);
        } catch (error: unknown) {
          // Variant might already exist (UNIQUE constraint)
          if (error instanceof Error && !error.message.includes("UNIQUE")) {
            console.error(`[Processing] Error creating variant:`, error);
          }
        }
      }
    }

    // Update source status to READY
    const processedAt = new Date().toISOString();
    db.prepare(`
      UPDATE sources 
      SET status = 'ready', 
          status_message = 'Processing completed',
          blob_hash = ?,
          processed_at = ?
      WHERE id = ?
    `).run(blobHash, processedAt, sourceId);

    return c.json({
      success: true,
      sourceId,
      blobHash,
      variantsCreated: variants?.length || 0,
    });
  } catch (error: unknown) {
    console.error("[Processing] Error finalizing:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: errorMessage }, 500);
  }
});

/**
 * V2 API: Report processing failure
 * POST /api/processing/fail
 */
app.post("/fail", async (c) => {
  try {
    const { sourceId, error } = await c.req.json();

    if (!sourceId) {
      return c.json({ error: "Missing sourceId" }, 400);
    }

    const db = getDb();
    db.prepare(`
      UPDATE sources 
      SET status = 'failed', status_message = ?
      WHERE id = ?
    `).run(error || "Processing failed", sourceId);

    return c.json({ success: true, sourceId });
  } catch (error: unknown) {
    console.error("[Processing] Error reporting failure:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: errorMessage }, 500);
  }
});

/**
 * V2 API: Get staged sources for processing
 * GET /api/processing/staged?limit=50
 */
app.get("/staged", (c) => {
  const limit = parseInt(c.req.query("limit") || "50");
  
  try {
    const db = getDb();
    const sources = db.prepare(`
      SELECT * FROM sources WHERE status = 'staged' LIMIT ?
    `).all(limit);
    
    return c.json({
      count: sources.length,
      sources,
    });
  } catch (error: unknown) {
    console.error("[Processing] Error fetching staged sources:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: errorMessage }, 500);
  }
});

/**
 * V2 API: Get active device dimensions for variant generation
 * GET /api/processing/device-dimensions
 */
app.get("/device-dimensions", (c) => {
  try {
    const db = getDb();
    
    const devices = db.prepare(`
      SELECT width, height, orientation, layouts 
      FROM devices 
      ORDER BY width DESC, height DESC
    `).all() as Array<{ width: number; height: number; orientation: string; layouts: string | null }>;

    // Parse layouts JSON for each device
    const devicesWithLayouts = devices.map(device => ({
      width: device.width,
      height: device.height,
      orientation: device.orientation,
      layouts: device.layouts ? JSON.parse(device.layouts) : undefined,
    }));

    return c.json({ devices: devicesWithLayouts });
  } catch (error: unknown) {
    console.error("[Processing] Error fetching device dimensions:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: errorMessage }, 500);
  }
});

export default app;
