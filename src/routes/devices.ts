import { Hono } from "hono";
import { getDb } from "../db/schema.ts";
import { generateSlideshowQueue, getNextImage, loadQueueState } from "../services/slideshow-queue.ts";
import { isGCSEnabled, readFile, parseGCSUri } from "../services/storage.ts";

const devices = new Hono();

/**
 * Register or update device (V2 Handshake API)
 * POST /api/devices/register
 */
devices.post("/register", async (c) => {
  try {
    const body = await c.req.json();
    const { id, name, width, height, orientation, capabilities, version } = body;

    if (!id || !name || !width || !height || !orientation) {
      return c.json({
        error: "Missing required fields: id, name, width, height, orientation"
      }, 400);
    }

    const db = getDb();
    
    // Upsert device
    db.prepare(`
      INSERT INTO devices (id, name, width, height, orientation, capabilities, version, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        width = excluded.width,
        height = excluded.height,
        orientation = excluded.orientation,
        capabilities = excluded.capabilities,
        version = excluded.version,
        last_seen = CURRENT_TIMESTAMP
    `).run(
      id,
      name,
      width,
      height,
      orientation,
      capabilities ? JSON.stringify(capabilities) : null,
      version
    );

    console.log(`📱 Device registered: ${name} (${width}x${height} ${orientation})`);

    // Check if variants exist for this dimension
    const variantCount = db.prepare(`
      SELECT COUNT(*) as count 
      FROM device_variants 
      WHERE width = ? AND height = ?
    `).get(width, height) as { count: number };

    const needsBackfill = variantCount.count === 0;

    if (needsBackfill) {
      console.log(`⚠️  No variants found for ${width}x${height}, backfill needed`);
      // TODO: Trigger backfill job
    }

    return c.json({
      success: true,
      deviceId: id,
      needsBackfill,
      message: needsBackfill 
        ? "Device registered. Image variants will be generated." 
        : "Device registered successfully"
    });
  } catch (error: any) {
    console.error("Error registering device:", error);
    return c.json({ error: error.message }, 500);
  }
});

// Get device info
devices.get("/:deviceId", (c) => {
  const deviceId = c.req.param("deviceId");
  const db = getDb();
  
  const device = db.prepare(
    "SELECT * FROM devices WHERE id = ?"
  ).get(deviceId);
  
  if (!device) {
    return c.json({ error: "Device not found" }, 404);
  }
  
  return c.json(device);
});

// Get slideshow queue for device
devices.get("/:deviceId/slideshow", (c) => {
  const deviceId = c.req.param("deviceId");
  const regenerate = c.req.query("regenerate") === "true";
  
  try {
    let queue;
    
    if (regenerate) {
      // Generate fresh queue
      queue = generateSlideshowQueue(deviceId);
    } else {
      // Load existing or generate new
      queue = loadQueueState(deviceId);
      if (!queue) {
        queue = generateSlideshowQueue(deviceId);
      }
    }
    
    return c.json(queue);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 404);
  }
});

// Get next image in slideshow
devices.get("/:deviceId/next", (c) => {
  const deviceId = c.req.param("deviceId");
  
  try {
    const item = getNextImage(deviceId);
    
    if (!item) {
      return c.json({ error: "No images available" }, 404);
    }
    
    return c.json(item);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});

// Get processed image for device (LEGACY - returns JPEG)
devices.get("/:deviceId/images/:imageId", async (c) => {
  const deviceId = c.req.param("deviceId");
  const imageId = c.req.param("imageId");
  
  try {
    const db = getDb();
    
    // Get device info to determine size
    const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId) as {
      width: number;
      height: number;
      orientation: string;
    } | undefined;
    
    if (!device) {
      return c.json({ error: "Device not found" }, 404);
    }
    
    // Try new schema first (device_variants + blobs)
    let filePath: string | undefined;
    
    // First check if imageId is actually a source ID
    const source = db.prepare("SELECT blob_hash FROM sources WHERE id = ?").get(imageId) as { blob_hash: string } | undefined;
    const blobHash = source?.blob_hash;
    
    if (blobHash) {
      // Query device_variants by blob hash and device dimensions
      const variant = db.prepare(`
        SELECT storage_path 
        FROM device_variants 
        WHERE blob_hash = ? AND width = ? AND height = ?
        LIMIT 1
      `).get(blobHash, device.width, device.height) as { storage_path: string } | undefined;
      
      filePath = variant?.storage_path;
    }
    
    // Fallback to legacy schema
    if (!filePath) {
      const processed = db.prepare(`
        SELECT file_path 
        FROM processed_images 
        WHERE image_id = ? 
        LIMIT 1
      `).get(imageId) as { file_path: string } | undefined;
      
      filePath = processed?.file_path;
    }
    
    if (!filePath) {
      return c.json({ error: "Image not found" }, 404);
    }
    
    let imageData: Uint8Array;
    
    // Check if file is in GCS or local
    if (filePath.startsWith("gs://")) {
      // Read from Google Cloud Storage
      if (!isGCSEnabled()) {
        return c.json({ error: "GCS not configured" }, 500);
      }
      
      const gcsInfo = parseGCSUri(filePath);
      if (!gcsInfo) {
        return c.json({ error: "Invalid GCS path" }, 500);
      }
      
      imageData = await readFile(gcsInfo.path);
    } else {
      // Read from local filesystem
      imageData = await Deno.readFile(filePath);
    }
    
    return new Response(imageData, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=31536000",
      },
    });
  } catch (error) {
    console.error("Error serving image:", error);
    return c.json({ error: "Failed to serve image" }, 500);
  }
});

/**
 * V2 API: Get image metadata with theme data
 * GET /api/devices/:deviceId/images/:imageId/metadata
 */
devices.get("/:deviceId/images/:imageId/metadata", async (c) => {
  const deviceId = c.req.param("deviceId");
  const imageId = c.req.param("imageId");
  
  try {
    const db = getDb();
    
    // Get device info
    const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId) as {
      width: number;
      height: number;
      orientation: string;
    } | undefined;
    
    if (!device) {
      return c.json({ error: "Device not found" }, 404);
    }
    
    // Get source and blob data
    const source = db.prepare("SELECT * FROM sources WHERE id = ?").get(imageId) as any;
    if (!source?.blob_hash) {
      return c.json({ error: "Image not found" }, 404);
    }
    
    const blob = db.prepare("SELECT * FROM blobs WHERE hash = ?").get(source.blob_hash) as any;
    if (!blob) {
      return c.json({ error: "Blob not found" }, 404);
    }
    
    // Get device variant
    const variant = db.prepare(`
      SELECT storage_path 
      FROM device_variants 
      WHERE blob_hash = ? AND width = ? AND height = ?
    `).get(blob.hash, device.width, device.height) as { storage_path: string } | undefined;
    
    if (!variant) {
      return c.json({ error: "Variant not found for device dimensions" }, 404);
    }
    
    // Parse color palette
    const colors = blob.color_palette ? JSON.parse(blob.color_palette) : ["#4285F4"];
    
    // Build image URL
    const imageUrl = `${c.req.url.replace(/\/metadata$/, "")}`;
    
    return c.json({
      image_url: imageUrl,
      metadata: {
        width: blob.width,
        height: blob.height,
        orientation: blob.orientation,
        // Add more metadata here (location, date, etc.) when available
      },
      theme: {
        primary: colors[0],
        secondary: colors[1] || colors[0],
        tertiary: colors[2] || colors[0],
        source: blob.color_source || colors[0],
        palette: colors,
        is_dark: false, // TODO: Calculate from primary color luminance
      },
      transition: {
        type: "crossfade",
        duration_ms: 5000,
      },
    });
  } catch (error: any) {
    console.error("Error fetching image metadata:", error);
    return c.json({ error: error.message }, 500);
  }
});

// Register or update device
devices.post("/", async (c) => {
  const body = await c.req.json();
  const { id, name, width, height, orientation } = body;
  
  if (!id || !name || !width || !height || !orientation) {
    return c.json({ error: "Missing required fields" }, 400);
  }
  
  const db = getDb();
  
  db.prepare(`
    INSERT INTO devices (id, name, width, height, orientation, last_seen)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      width = excluded.width,
      height = excluded.height,
      orientation = excluded.orientation,
      last_seen = CURRENT_TIMESTAMP
  `).run(id, name, width, height, orientation);
  
  return c.json({ success: true, deviceId: id });
});

// Update device
devices.put("/:deviceId", async (c) => {
  const deviceId = c.req.param("deviceId");
  const body = await c.req.json();
  const { name, width, height, orientation } = body;
  
  if (!name || !width || !height || !orientation) {
    return c.json({ error: "Missing required fields" }, 400);
  }
  
  const db = getDb();
  
  // Check if device exists
  const existing = db.prepare("SELECT id FROM devices WHERE id = ?").get(deviceId);
  if (!existing) {
    return c.json({ error: "Device not found" }, 404);
  }
  
  db.prepare(`
    UPDATE devices 
    SET name = ?, width = ?, height = ?, orientation = ?
    WHERE id = ?
  `).run(name, width, height, orientation, deviceId);
  
  return c.json({ success: true, deviceId });
});

// Delete device
devices.delete("/:deviceId", (c) => {
  const deviceId = c.req.param("deviceId");
  const db = getDb();
  
  // Check if device exists
  const existing = db.prepare("SELECT id FROM devices WHERE id = ?").get(deviceId);
  if (!existing) {
    return c.json({ error: "Device not found" }, 404);
  }
  
  db.prepare("DELETE FROM devices WHERE id = ?").run(deviceId);
  
  return c.json({ success: true });
});

export default devices;
