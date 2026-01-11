/**
 * Processing API routes for Cloud Run Job coordination
 */

import { Hono } from "hono";
import { getDb } from "../db/schema.ts";
import { parseGCSUri } from "../services/storage.ts";

const app = new Hono();

/**
 * Middleware to validate processor service account
 */
async function validateProcessorAuth(c: any, next: any) {
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

export default app;
