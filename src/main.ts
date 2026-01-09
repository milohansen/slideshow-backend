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
async function processUnprocessedImages() {
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
      
      const { queueImageProcessing } = await import("./services/worker-queue.ts");
      for (const image of unprocessedImages) {
        queueImageProcessing(image.id);
      }
    }
  } catch (error) {
    console.error("Failed to check for unprocessed images:", error);
  }
}

// Middleware
app.use("*", logger());
app.use("*", cors());

// Initialize storage first
initStorage();

// Initialize database sync manager BEFORE initializing database (Cloud Run only)
let dbSync: DatabaseSyncManager | null = null;
const gcsBucketName = Deno.env.get("GCS_BUCKET_NAME");

if (gcsBucketName && Deno.env.get("DENO_ENV") === "production") {
  console.log("🌩️  Cloud Run environment detected - initializing database sync");
  const instanceId = crypto.randomUUID();
  
  dbSync = new DatabaseSyncManager({
    bucketName: gcsBucketName,
    dbPath: "slideshow.db",
    gcsDbPath: "database/slideshow.db",
    syncIntervalMs: 30000, // 30 seconds
    leaseTimeoutMs: 60000, // 60 seconds
    instanceId,
  });
  
  // Download database from GCS BEFORE initializing
  await dbSync.initialize();
}

// NOW initialize database (will use downloaded file if it exists)
await initDatabase();

// Process any unprocessed images on startup
processUnprocessedImages();

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
