import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { initDatabase, getDb } from "./db/schema.ts";
import { initStorage } from "./services/storage.ts";
import { DatabaseSyncManager } from "./db/sync.ts";
import { crypto } from "@std/crypto";
import deviceRoutes from "./routes/devices.ts";
import adminRoutes from "./routes/admin.ts";
import uiRoutes from "./routes/ui.tsx";

const app = new Hono();

/**
 * Process any images that haven't been processed for all device sizes
 */
function processUnprocessedImages() {
  try {
    const db = getDb();
    
    // Find images that don't have processed versions for all device sizes
    const unprocessedImages = db.prepare(`
      SELECT DISTINCT i.id
      FROM images i
      LEFT JOIN (
        SELECT image_id, COUNT(DISTINCT device_size) as device_count
        FROM processed_images
        GROUP BY image_id
      ) pi ON i.id = pi.image_id
      LEFT JOIN (
        SELECT COUNT(DISTINCT name) as total_devices
        FROM devices
      ) d
      WHERE pi.device_count IS NULL OR pi.device_count < d.total_devices
    `).all() as Array<{ id: string }>;

    if (unprocessedImages.length > 0) {
      console.log(`📸 Found ${unprocessedImages.length} images to process on startup`);
      
      for (const image of unprocessedImages) {
        const workerUrl = new URL("./workers/image-processor.ts", import.meta.url);
        const worker = new Worker(workerUrl.href, {
          type: "module",
          deno: {
            permissions: {
              read: true,
              write: true,
              env: true,
              net: true,
              run: true,
            },
          },
        });

        worker.postMessage({
          imageId: image.id,
          outputDir: "data/processed",
        });

        worker.onmessage = (e: MessageEvent) => {
          const { success, imageId } = e.data;
          if (success) {
            console.log(`✓ Startup processing completed for ${imageId}`);
          }
        };

        worker.onerror = (e: ErrorEvent) => {
          console.error(`✗ Startup worker error:`, e.message);
        };
      }
    }
  } catch (error) {
    console.error("Failed to check for unprocessed images:", error);
  }
}

// Middleware
app.use("*", logger());
app.use("*", cors());

// Initialize database and storage
await initDatabase();
initStorage();

// Process any unprocessed images on startup
processUnprocessedImages();

// Initialize database sync manager (Cloud Run only)
let dbSync: DatabaseSyncManager | null = null;
const gcsBucketName = Deno.env.get("GCS_BUCKET_NAME");

if (gcsBucketName && Deno.env.get("DENO_ENV") === "production") {
  const instanceId = crypto.randomUUID();
  
  dbSync = new DatabaseSyncManager({
    bucketName: gcsBucketName,
    dbPath: "slideshow.db",
    gcsDbPath: "database/slideshow.db",
    syncIntervalMs: 30000, // 30 seconds
    leaseTimeoutMs: 60000, // 60 seconds
    instanceId,
  });
  
  await dbSync.initialize();
}

// Health check endpoint for Cloud Run
app.get("/_health", (c) => {
  return c.json({ 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    dbSync: dbSync?.getStatus(),
  });
});

// Routes
app.route("/ui", uiRoutes);
app.route("/api/devices", deviceRoutes);
app.route("/api/admin", adminRoutes);

// Redirect root to UI
app.get("/", (c) => {
  return c.redirect("/ui");
});

// Cloud Run sets PORT environment variable (default to 8080 for local dev)
const port = Number(Deno.env.get("PORT")) || 8080;

const server = Deno.serve({ 
  port, 
  hostname: "0.0.0.0",
  onListen: ({ hostname, port }) => {
    console.log(`🚀 Server running on http://${hostname}:${port}`);
  }
}, app.fetch);

// Graceful shutdown handling for Cloud Run
const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, starting graceful shutdown...`);
  
  try {
    // Shutdown database sync first
    if (dbSync) {
      await dbSync.shutdown();
    }
    
    await server.shutdown();
    console.log("Server closed successfully");
    Deno.exit(0);
  } catch (error) {
    console.error("Error during shutdown:", error);
    Deno.exit(1);
  }
};

// Handle termination signals (Cloud Run sends SIGTERM)
Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));
Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
