import { Hono } from "hono";
import { getDb } from "../db/schema.ts";
import { Home } from "../views/home.tsx";
import { Devices } from "../views/devices.tsx";
import { Images } from "../views/images.tsx";
import { Queues } from "../views/queues.tsx";

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

// Images page
ui.get("/images", (c) => {
  const db = getDb();
  
  const images = db.prepare(`
    SELECT 
      i.id,
      i.file_path,
      i.width,
      i.height,
      i.orientation,
      p.color_primary,
      p.color_secondary,
      p.color_tertiary
    FROM images i
    LEFT JOIN processed_images p ON i.id = p.image_id
    GROUP BY i.id
    ORDER BY i.ingested_at DESC
  `).all() as Array<{
    id: string;
    file_path: string;
    width: number;
    height: number;
    orientation: string;
    color_primary: string | null;
    color_secondary: string | null;
    color_tertiary: string | null;
  }>;

  const imagesWithColors = images.map(img => ({
    id: img.id,
    file_path: img.file_path,
    width: img.width,
    height: img.height,
    orientation: img.orientation,
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

export default ui;
