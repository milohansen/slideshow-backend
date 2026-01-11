import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { serveStatic } from "hono/deno";
import { initDatabase, getDb } from "./db/schema.ts";
import { initStorage } from "./services/storage.ts";
import { initMetadataSync, stopMetadataSync } from "./services/metadata-sync.ts";
import { initJobQueue, shutdownJobQueue } from "./services/job-queue.ts";
import { DatabaseSyncManager } from "./db/sync.ts";
import { crypto } from "@std/crypto";
import deviceRoutes from "./routes/devices.ts";
import adminRoutes from "./routes/admin.ts";
import uiRoutes from "./routes/ui.tsx";
import authRoutes from "./routes/auth.ts";
import processingRoutes from "./routes/processing.ts";
import { requireAuth, optionalAuth } from "./middleware/auth.ts";

const app = new Hono();

// Generate unique app instance ID
export const APP_INSTANCE_ID = crypto.randomUUID();
console.log(`🆔 App instance ID: ${APP_INSTANCE_ID}`);

/**
 * Recover images that were being processed by a different app instance
 * (likely from a crashed or restarted instance)
 */
async function recoverOrphanedProcessingImages() {
  try {
    const db = getDb();
    
    // Find images that are marked as processing but belong to a different app instance
    const orphanedImages = db.prepare(`
      SELECT id, processing_app_id
      FROM images
      WHERE processing_status = 'processing'
        AND (processing_app_id IS NULL OR processing_app_id != ?)
    `).all(APP_INSTANCE_ID) as Array<{ id: string; processing_app_id: string | null }>;

    if (orphanedImages.length > 0) {
      console.log(`🔄 Found ${orphanedImages.length} orphaned processing images, re-queueing...`);
      
      const { queueImageProcessing } = await import("./services/job-queue.ts");
      for (const image of orphanedImages) {
        console.log(`  Re-queueing ${image.id} (was owned by ${image.processing_app_id || 'unknown'})`);
        // Reset status to pending before re-queueing
        db.prepare("UPDATE images SET processing_status = 'pending', processing_app_id = NULL, processing_error = NULL WHERE id = ?").run(image.id);
        queueImageProcessing(image.id);
      }
    }
  } catch (error) {
    console.error("Failed to recover orphaned processing images:", error);
  }
}

/**
 * Process any images that haven't been processed for all device sizes
 */
async function processUnprocessedImages() {
  try {
    const db = getDb();
    
    // Get total number of registered devices
    const deviceCountResult = db.prepare(`
      SELECT COUNT(DISTINCT name) as total
      FROM devices
    `).get() as { total: number };
    
    const totalDevices = deviceCountResult.total;
    
    if (totalDevices === 0) {
      console.log("📸 No devices registered, skipping startup image processing");
      return;
    }
    
    // Find images that don't have processed versions for all device sizes
    // Only process images that are not already processing or failed
    const unprocessedImages = db.prepare(`
      SELECT i.id, COALESCE(pi.device_count, 0) as processed_count
      FROM images i
      LEFT JOIN (
        SELECT image_id, COUNT(DISTINCT device_size) as device_count
        FROM processed_images
        GROUP BY image_id
      ) pi ON i.id = pi.image_id
      WHERE i.processing_status != 'processing'
        AND (pi.device_count IS NULL OR pi.device_count < ?)
      LIMIT 100
    `).all(totalDevices) as Array<{ id: string; processed_count: number }>;

    if (unprocessedImages.length > 0) {
      console.log(`📸 Found ${unprocessedImages.length} images to process on startup (${totalDevices} device sizes each)`);
      
      const { queueImageProcessing } = await import("./services/job-queue.ts");
      for (const image of unprocessedImages) {
        queueImageProcessing(image.id);
      }
    } else {
      console.log("✓ All images are processed for all device sizes");
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

// Initialize metadata sync service (if GCS is enabled)
initMetadataSync();

// Initialize job queue service
initJobQueue();

// Recover orphaned processing images first (don't block server start)
recoverOrphanedProcessingImages().catch(err => 
  console.error("Error recovering orphaned images:", err)
);

// Process any unprocessed images on startup (don't block server start)
processUnprocessedImages().catch(err => 
  console.error("Error processing unprocessed images:", err)
);

// Health check endpoint for Cloud Run
app.get("/_health", (c) => {
  return c.json({ 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    dbSync: dbSync?.getStatus(),
  });
});

// Routes
app.route("/auth", authRoutes);

// Serve static assets
app.use("/assets/*", serveStatic({ root: "./" }));

// Public UI routes (with optional auth for better UX)
app.use("/ui/*", optionalAuth);
app.route("/ui", uiRoutes);

// Device API routes (public for now - devices authenticate via device ID)
app.route("/api/devices", deviceRoutes);

// Processing API routes (authenticated by processor service account)
app.route("/api/processing", processingRoutes);
app.route("/api/processed-images", processingRoutes);
app.route("/api/images", processingRoutes);

// Protected admin routes (require authentication)
app.use("/api/admin/*", requireAuth);
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
    // Flush pending job queue
    await shutdownJobQueue();
    
    // Stop metadata sync
    stopMetadataSync();
    
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
