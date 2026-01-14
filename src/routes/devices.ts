import { Hono } from "hono";
import { createReadStream as fsCreateReadStream } from "fs";
import { 
  getDevice,
  upsertDevice,
  updateDeviceLastSeen,
  deleteDevice,
  getSource,
  getBlob,
  getDeviceVariant,
} from "../db/helpers-firestore.ts";
import { generateSlideshowQueue, getNextImage, loadQueueState } from "../services/slideshow-queue.ts";
import { isGCSEnabled, parseGCSUri, createReadStream } from "../services/storage.ts";

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
    
    // Upsert device
    await upsertDevice({
      id,
      name,
      width,
      height,
      orientation,
      capabilities: capabilities ? JSON.stringify(capabilities) : undefined,
      version,
      gap: 0,
      created_at: new Date().toISOString(),
      last_seen: new Date().toISOString(),
    });

    console.log(`📱 Device registered: ${name} (${width}x${height} ${orientation})`);

    // Check if variants exist for this dimension
    // Note: This requires a query across all device_variants - could be expensive
    // For now, we'll assume backfill is needed if device is new
    const needsBackfill = false; // TODO: Implement proper check

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
devices.get("/:deviceId", async (c) => {
  const deviceId = c.req.param("deviceId");
  
  const device = await getDevice(deviceId);
  
  if (!device) {
    return c.json({ error: "Device not found" }, 404);
  }
  
  return c.json(device);
});

// Get slideshow queue for device
devices.get("/:deviceId/slideshow", async (c) => {
  const deviceId = c.req.param("deviceId");
  const regenerate = c.req.query("regenerate") === "true";
  
  try {
    let queue;
    
    if (regenerate) {
      // Generate fresh queue
      queue = await generateSlideshowQueue(deviceId, 10);
    } else {
      // Load existing or generate new
      queue = await loadQueueState(deviceId);
      if (!queue) {
        queue = await generateSlideshowQueue(deviceId, 10);
      }
    }
    
    return c.json(queue);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 404);
  }
});

// Get next image in slideshow
devices.get("/:deviceId/next", async (c) => {
  const deviceId = c.req.param("deviceId");
  
  try {
    const item = await getNextImage(deviceId);
    
    if (!item) {
      return c.json({ error: "No images available" }, 404);
    }
    
    return c.json(item);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});

// Get next image in packed format for device
devices.get("/:deviceId/next-packed", async (c) => {
  const deviceId = c.req.param("deviceId");
  
  try {
    const item = await getNextImage(deviceId);
    
    if (!item) {
      return c.json({ error: "No images available" }, 404);
    }
    
    return c.json({ l: item.layoutType, i: item.images.map(img => [img.url, img.source_color]) });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});

// Get processed image for device (LEGACY - returns JPEG)
devices.get("/:deviceId/images/:imageId", async (c) => {
  const deviceId = c.req.param("deviceId");
  const imageId = c.req.param("imageId");
  
  try {
    // Get device info to determine size
    const device = await getDevice(deviceId);
    
    if (!device) {
      return c.json({ error: "Device not found" }, 404);
    }
    
    // Try new schema first (device_variants + blobs)
    let filePath: string | undefined;
    
    // First check if imageId is actually a source ID
    const source = await getSource(imageId);
    const blobHash = source?.blob_hash;
    
    if (blobHash) {
      // Query device_variants by blob hash and device dimensions
      const variant = await getDeviceVariant(blobHash, device.width, device.height);
      filePath = variant?.storage_path;
    }
    
    // TODO: Add fallback to legacy schema if needed
    
    if (!filePath) {
      return c.json({ error: "Image not found" }, 404);
    }
    
    // Check if file is in GCS or local
    if (filePath.startsWith("gs://")) {
      // Stream from Google Cloud Storage
      if (!isGCSEnabled()) {
        return c.json({ error: "GCS not configured" }, 500);
      }
      
      const gcsInfo = parseGCSUri(filePath);
      if (!gcsInfo) {
        return c.json({ error: "Invalid GCS path" }, 500);
      }
      
      const stream = createReadStream(gcsInfo.path);
      
      return new Response(stream, {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "public, max-age=31536000",
        },
      });
    } else {
      // Stream from local filesystem
      const file = fsCreateReadStream(filePath);
      
      return new Response(file as any, {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "public, max-age=31536000",
        },
      });
    }
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
    // Get device info
    const device = await getDevice(deviceId);
    
    if (!device) {
      return c.json({ error: "Device not found" }, 404);
    }
    
    // Get source and blob data
    const source = await getSource(imageId);
    if (!source?.blob_hash) {
      return c.json({ error: "Image not found" }, 404);
    }
    
    const blob = await getBlob(source.blob_hash);
    if (!blob) {
      return c.json({ error: "Blob not found" }, 404);
    }
    
    // Get device variant
    const variant = await getDeviceVariant(blob.hash, device.width, device.height);
    
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
      }
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
  
  await upsertDevice({
    id,
    name,
    width,
    height,
    orientation,
    gap: 0,
    created_at: new Date().toISOString(),
    last_seen: new Date().toISOString(),
  });
  
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
  
  // Check if device exists
  const existing = await getDevice(deviceId);
  if (!existing) {
    return c.json({ error: "Device not found" }, 404);
  }
  
  await upsertDevice({
    ...existing,
    name,
    width,
    height,
    orientation,
  });
  
  return c.json({ success: true, deviceId });
});

// Delete device
devices.delete("/:deviceId", async (c) => {
  const deviceId = c.req.param("deviceId");
  
  // Check if device exists
  const existing = await getDevice(deviceId);
  if (!existing) {
    return c.json({ error: "Device not found" }, 404);
  }
  
  await deleteDevice(deviceId);
  
  return c.json({ success: true });
});

export default devices;
