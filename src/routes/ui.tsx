import { Hono } from "hono";
import { getDb } from "../db/schema.ts";
import { Home } from "../views/home.tsx";
import { Devices } from "../views/devices.tsx";
import { Images } from "../views/images.tsx";
import { Queues } from "../views/queues.tsx";
import { Upload } from "../views/upload.tsx";
import { PhotosPicker } from "../views/photos-picker.tsx";
import { getPickerSessionFromDb } from "../services/google-photos.ts";
import { getUserId } from "../middleware/auth.ts";

const ui = new Hono();

// Home page
ui.get("/", (c) => {
  const db = getDb();
  
  // Get stats
  const totalImages = db.prepare("SELECT COUNT(*) as count FROM images").get() as { count: number };
  const totalDevices = db.prepare("SELECT COUNT(*) as count FROM devices").get() as { count: number };
  const processedVariants = db.prepare("SELECT COUNT(*) as count FROM processed_images").get() as { count: number };
  
  const orientations = db.prepare(`
    SELECT orientation, COUNT(*) as count 
    FROM images 
    GROUP BY orientation
  `).all() as Array<{ orientation: string; count: number }>;

  const orientationMap: Record<string, number> = {};
  for (const row of orientations) {
    orientationMap[row.orientation] = row.count;
  }

  const stats = {
    totalImages: totalImages.count,
    totalDevices: totalDevices.count,
    processedVariants: processedVariants.count,
    orientations: orientationMap,
  };

  return c.html(<Home stats={stats} />);
});

// Devices page
ui.get("/devices", (c) => {
  const db = getDb();
  
  const devices = db.prepare(`
    SELECT id, name, width, height, orientation, created_at, last_seen
    FROM devices
    ORDER BY created_at DESC
  `).all() as Array<{
    id: string;
    name: string;
    width: number;
    height: number;
    orientation: string;
    created_at: string;
    last_seen: string | null;
  }>;

  return c.html(<Devices devices={devices} />);
});

// Retry failed image processing
ui.post("/images/:id/retry", async (c) => {
  const imageId = c.req.param("id");
  const db = getDb();
  
  // Verify image exists
  const image = db.prepare("SELECT id, processing_status FROM images WHERE id = ?").get(imageId) as { id: string; processing_status: string } | undefined;
  
  if (!image) {
    return c.redirect("/ui/images");
  }
  
  console.log(`[UI] Retrying processing for image: ${imageId}`);
  
  // Reset status to pending and clear error
  db.prepare("UPDATE images SET processing_status = 'pending', processing_error = NULL WHERE id = ?").run(imageId);
  
  // Queue for processing
  const { queueImageProcessing } = await import("../services/worker-queue.ts");
  await queueImageProcessing(imageId);
  
  return c.redirect("/ui/images");
});

// Images page
ui.get("/images", (c) => {
  const db = getDb();
  
  // Get total device count
  const deviceCountResult = db.prepare(
    "SELECT COUNT(DISTINCT name) as total FROM devices"
  ).get() as { total: number };
  const totalDevices = deviceCountResult.total;
  
  const images = db.prepare(`
    SELECT 
      i.id,
      i.file_path,
      i.thumbnail_path,
      i.width,
      i.height,
      i.orientation,
      i.processing_status,
      i.processing_error,
      p.color_primary,
      p.color_secondary,
      p.color_tertiary,
      COUNT(DISTINCT p.device_size) as processed_count
    FROM images i
    LEFT JOIN processed_images p ON i.id = p.image_id
    GROUP BY i.id
    ORDER BY i.ingested_at DESC
  `).all() as Array<{
    id: string;
    file_path: string;
    thumbnail_path: string | null;
    width: number;
    height: number;
    orientation: string;
    processing_status: string;
    processing_error: string | null;
    color_primary: string | null;
    color_secondary: string | null;
    color_tertiary: string | null;
    processed_count: number;
  }>;

  const imagesWithColors = images.map(img => ({
    id: img.id,
    file_path: img.file_path,
    thumbnail_path: img.thumbnail_path,
    width: img.width,
    height: img.height,
    orientation: img.orientation,
    processingStatus: img.processing_status,
    processingError: img.processing_error,
    processedCount: img.processed_count,
    totalDevices: totalDevices,
    colors: img.color_primary ? {
      primary: img.color_primary,
      secondary: img.color_secondary || "#000000",
      tertiary: img.color_tertiary || "#000000",
    } : null,
  }));

  return c.html(<Images images={imagesWithColors} />);
});

// Queues page
ui.get("/queues", (c) => {
  const db = getDb();
  
  // Get all devices with queue state
  const deviceQueues = db.prepare(`
    SELECT 
      d.id,
      d.name,
      q.queue_data,
      q.current_index
    FROM devices d
    LEFT JOIN device_queue_state q ON d.id = q.device_id
    WHERE q.queue_data IS NOT NULL
    ORDER BY d.created_at DESC
  `).all() as Array<{
    id: string;
    name: string;
    queue_data: string;
    current_index: number;
  }>;

  const queues = deviceQueues.map(dq => {
    const queueData = JSON.parse(dq.queue_data);
    return {
      deviceId: dq.id,
      deviceName: dq.name,
      queue: queueData.queue || [],
      currentIndex: dq.current_index,
    };
  });

  return c.html(<Queues queues={queues} />);
});

// Upload page
ui.get("/upload", (c) => {
  return c.html(<Upload />);
});

// Serve thumbnail images
ui.get("/thumbnails/:imageId", async (c) => {
  const imageId = c.req.param("imageId");
  const db = getDb();
  
  const image = db.prepare(
    "SELECT thumbnail_path FROM images WHERE id = ?"
  ).get(imageId) as { thumbnail_path: string | null } | undefined;
  
  if (!image || !image.thumbnail_path) {
    return c.notFound();
  }
  
  try {
    let imageData: Uint8Array;
    
    // Check if file is in GCS or local
    if (image.thumbnail_path.startsWith("gs://")) {
      const { downloadFile } = await import("../services/storage.ts");
      const gcsPath = image.thumbnail_path.replace(/^gs:\/\/[^/]+\//, "");
      const tempPath = await Deno.makeTempFile({ suffix: ".jpg" });
      await downloadFile(gcsPath, tempPath);
      imageData = await Deno.readFile(tempPath);
      await Deno.remove(tempPath);
    } else {
      imageData = await Deno.readFile(image.thumbnail_path);
    }
    
    return c.body(imageData, 200, {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=31536000",
    });
  } catch (error) {
    console.error(`Failed to serve thumbnail ${imageId}:`, error);
    return c.notFound();
  }
});

// Google Photos Picker page
ui.get("/photos-picker", async (c) => {
  const userId = getUserId(c);
  
  if (!userId) {
    // Not authenticated, redirect to login
    return c.redirect("/auth/google");
  }

  // Check if there's an active picker session for this user
  const db = getDb();
  const session = db.prepare(`
    SELECT picker_session_id, picker_uri 
    FROM picker_sessions 
    WHERE user_id = ? 
    ORDER BY created_at DESC 
    LIMIT 1
  `).get(userId) as { picker_session_id: string; picker_uri: string } | undefined;

  return c.html(<PhotosPicker session={session ? { sessionId: session.picker_session_id, pickerUri: session.picker_uri } : null} />);
});

export default ui;
