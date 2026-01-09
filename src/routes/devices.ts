import { Hono } from "hono";
import { getDb } from "../db/schema.ts";
import { generateSlideshowQueue, getNextImage, loadQueueState } from "../services/slideshow-queue.ts";

const devices = new Hono();

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

// Get processed image for device
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
    
    // Find processed image
    const processed = db.prepare(`
      SELECT file_path 
      FROM processed_images 
      WHERE image_id = ? 
      LIMIT 1
    `).get(imageId) as { file_path: string } | undefined;
    
    if (!processed) {
      return c.json({ error: "Image not found" }, 404);
    }
    
    // Serve the image file
    const imageData = await Deno.readFile(processed.file_path);
    
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

export default devices;
