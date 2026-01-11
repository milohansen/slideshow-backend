/**
 * Metadata Sync Service
 * Polls GCS for metadata JSON files written by the processor,
 * imports missing processed images to the database,
 * and archives completed metadata files.
 */

import { Storage } from "@google-cloud/storage";
import { getDb } from "../db/schema.ts";
import { isGCSEnabled } from "./storage.ts";

let storage: Storage | null = null;
let bucketName: string | null = null;
let syncInterval: number | null = null;
let isRunning = false;

/**
 * Initialize metadata sync service
 */
export function initMetadataSync() {
  bucketName = Deno.env.get("GCS_BUCKET_NAME") ?? null;

  if (!bucketName || !isGCSEnabled()) {
    console.log("⚠️  Metadata sync disabled (GCS not configured)");
    return;
  }

  storage = new Storage();

  // Configure bucket lifecycle policy for auto-deletion
  configureBucketLifecycle().catch((err) =>
    console.error("Failed to configure bucket lifecycle:", err)
  );

  // Start sync loop
  startSyncLoop();

  console.log("✅ Metadata sync service initialized");
}

/**
 * Configure bucket lifecycle to auto-delete archived metadata after 30 days
 */
async function configureBucketLifecycle() {
  if (!storage || !bucketName) return;

  try {
    const bucket = storage.bucket(bucketName);
    
    // Set lifecycle rule for archived metadata
    await bucket.setMetadata({
      lifecycle: {
        rule: [
          {
            action: { type: "Delete" },
            condition: {
              matchesPrefix: ["images/metadata/archive/"],
              age: 30, // Days
            },
          },
        ],
      },
    });

    console.log("✅ Bucket lifecycle policy configured (30-day TTL for archived metadata)");
  } catch (error) {
    // Don't fail if we can't set lifecycle - it's not critical
    console.warn("Could not configure bucket lifecycle:", error);
  }
}

/**
 * Start the sync loop
 */
function startSyncLoop() {
  if (isRunning) {
    console.warn("Metadata sync loop already running");
    return;
  }

  isRunning = true;
  
  // Run sync every 60 seconds
  syncInterval = setInterval(() => {
    syncMetadata().catch((err) => 
      console.error("Metadata sync error:", err)
    );
  }, 60000);

  // Run once immediately on startup
  syncMetadata().catch((err) =>
    console.error("Initial metadata sync error:", err)
  );
}

/**
 * Stop the sync loop
 */
export function stopMetadataSync() {
  if (syncInterval !== null) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  isRunning = false;
  console.log("🛑 Metadata sync service stopped");
}

/**
 * Main sync logic
 */
async function syncMetadata() {
  if (!storage || !bucketName) return;

  const bucket = storage.bucket(bucketName);
  const metadataPrefix = "images/metadata/";

  try {
    // List all JSON files in metadata directory (not in archive/)
    const [files] = await bucket.getFiles({
      prefix: metadataPrefix,
      matchGlob: "**/*.json",
    });

    // Filter out archived files
    const pendingFiles = files.filter(
      (file) => !file.name.includes("/archive/")
    );

    if (pendingFiles.length === 0) {
      return; // Nothing to sync
    }

    console.log(`🔄 Syncing ${pendingFiles.length} metadata files...`);

    let imported = 0;
    let skipped = 0;
    let errors = 0;

    for (const file of pendingFiles) {
      try {
        const result = await processMetadataFile(file, bucket);
        if (result === "imported") {
          imported++;
        } else if (result === "skipped") {
          skipped++;
        }
      } catch (error) {
        errors++;
        console.error(`Failed to process ${file.name}:`, error);
      }
    }

    console.log(`✅ Metadata sync complete: ${imported} imported, ${skipped} skipped, ${errors} errors`);
  } catch (error) {
    console.error("Failed to list metadata files:", error);
  }
}

interface MetadataResult {
  deviceSize: string;
  width: number;
  height: number;
  filePath: string;
  colors: string[];
  primary: string;
  secondary: string;
  tertiary: string;
}

interface MetadataFile {
  imageId: string;
  processedAt: string;
  results: MetadataResult[];
}

/**
 * Process a single metadata file
 */
async function processMetadataFile(
  file: any,
  bucket: any
): Promise<"imported" | "skipped"> {
  // Download and parse JSON
  const [content] = await file.download();
  const metadata: MetadataFile = JSON.parse(content.toString());

  const db = getDb();

  // Check if we already have all processed images for this image
  const existingCount = db.prepare(`
    SELECT COUNT(*) as count
    FROM processed_images
    WHERE image_id = ?
  `).get(metadata.imageId) as { count: number };

  const totalDevices = db.prepare(`
    SELECT COUNT(*) as count FROM devices
  `).get() as { count: number };

  if (existingCount.count >= totalDevices.count) {
    // Already fully processed - archive the file
    await archiveMetadataFile(file, bucket, metadata.imageId);
    return "skipped";
  }

  // Import missing processed images
  let importedAny = false;

  for (const result of metadata.results) {
    const processedId = `${metadata.imageId}_${result.deviceSize}`;

    // Check if already exists
    const existing = db.prepare(`
      SELECT id FROM processed_images WHERE id = ?
    `).get(processedId);

    if (existing) {
      continue; // Already have this one
    }

    // Import it
    try {
      db.prepare(`
        INSERT INTO processed_images (
          id, image_id, device_size, width, height, file_path,
          color_primary, color_secondary, color_tertiary, color_source, color_palette,
          processed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        processedId,
        metadata.imageId,
        result.deviceSize,
        result.width,
        result.height,
        result.filePath,
        result.primary,
        result.secondary,
        result.tertiary,
        result.primary, // Use primary as source color
        JSON.stringify(result.colors),
        metadata.processedAt
      );

      importedAny = true;
    } catch (error) {
      console.error(`Failed to import ${processedId}:`, error);
    }
  }

  if (importedAny) {
    // Check if image is now complete
    const newCount = db.prepare(`
      SELECT COUNT(*) as count
      FROM processed_images
      WHERE image_id = ?
    `).get(metadata.imageId) as { count: number };

    if (newCount.count >= totalDevices.count) {
      // Mark image as complete
      db.prepare(`
        UPDATE images
        SET processing_status = 'complete', processing_error = NULL
        WHERE id = ?
      `).run(metadata.imageId);

      console.log(`✅ Completed ${metadata.imageId} via metadata sync`);
    }
  }

  // Archive the file
  await archiveMetadataFile(file, bucket, metadata.imageId);

  return importedAny ? "imported" : "skipped";
}

/**
 * Move metadata file to archive folder
 */
async function archiveMetadataFile(
  file: any,
  bucket: any,
  imageId: string
) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");

  const archivePath = `images/metadata/archive/${year}/${month}/${imageId}.json`;

  try {
    await file.copy(bucket.file(archivePath));
    await file.delete();
    console.log(`📦 Archived ${file.name} to ${archivePath}`);
  } catch (error) {
    console.error(`Failed to archive ${file.name}:`, error);
  }
}
