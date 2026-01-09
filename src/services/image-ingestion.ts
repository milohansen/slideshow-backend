import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { walk } from "@std/fs/walk";
import { join } from "@std/path";
import { getDb } from "../db/schema.ts";
import { isGCSEnabled, uploadFile } from "./storage.ts";
import { queueImageProcessing } from "./worker-queue.ts";
import { downloadMediaItem, type PickedMediaItem } from "./google-photos.ts";

const SUPPORTED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

export interface ImageMetadata {
  filePath: string;
  fileHash: string;
  width: number;
  height: number;
  orientation: "portrait" | "landscape" | "square";
  lastModified: Date;
}

/**
 * Calculate SHA-256 hash of a file
 */
async function calculateFileHash(filePath: string): Promise<string> {
  const fileData = await Deno.readFile(filePath);
  const hashBuffer = await crypto.subtle.digest("SHA-256", fileData);
  return encodeHex(new Uint8Array(hashBuffer));
}

/**
 * Extract image dimensions from file
 * Returns [width, height]
 */
async function getImageDimensions(filePath: string): Promise<[number, number]> {
  // Use ImageMagick identify command if available, otherwise use a simple approach
  try {
    const command = new Deno.Command("identify", {
      args: ["-format", "%w %h", filePath],
      stdout: "piped",
      stderr: "piped",
    });

    const { code, stdout } = await command.output();

    if (code === 0) {
      const output = new TextDecoder().decode(stdout).trim();
      const [width, height] = output.split(" ").map(Number);
      return [width, height];
    }
  } catch {
    // ImageMagick not available, fall through
  }

  // Fallback: Try using ffprobe for image dimensions
  try {
    const command = new Deno.Command("ffprobe", {
      args: ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", filePath],
      stdout: "piped",
      stderr: "piped",
    });

    const { code, stdout } = await command.output();

    if (code === 0) {
      const output = new TextDecoder().decode(stdout).trim();
      const [width, height] = output.split("x").map(Number);
      return [width, height];
    }
  } catch {
    // ffprobe not available
  }

  throw new Error(`Unable to extract dimensions from ${filePath}. Please install ImageMagick or ffmpeg.`);
}

/**
 * Determine image orientation based on dimensions
 */
function determineOrientation(width: number, height: number): "portrait" | "landscape" | "square" {
  const ratio = width / height;

  if (Math.abs(ratio - 1) < 0.05) {
    return "square";
  } else if (width > height) {
    return "landscape";
  } else {
    return "portrait";
  }
}

/**
 * Extract metadata from an image file
 */
export async function extractImageMetadata(filePath: string): Promise<ImageMetadata> {
  const [width, height] = await getImageDimensions(filePath);
  const fileHash = await calculateFileHash(filePath);
  const fileInfo = await Deno.stat(filePath);
  const lastModified = fileInfo.mtime || new Date();
  const orientation = determineOrientation(width, height);

  return {
    filePath,
    fileHash,
    width,
    height,
    orientation,
    lastModified,
  };
}

/**
 * Check if image already exists in database (by hash)
 */
function imageExists(fileHash: string): boolean {
  const db = getDb();
  const result = db.prepare("SELECT id FROM images WHERE file_hash = ?").get(fileHash);
  return result !== undefined;
}

/**
 * Store image metadata in database
 */
async function storeImageMetadata(id: string, metadata: ImageMetadata): Promise<void> {
  const db = getDb();

  let storagePath = metadata.filePath;

  // Upload original image to GCS if enabled
  if (isGCSEnabled()) {
    try {
      const gcsPath = `images/originals/${id}${metadata.filePath.substring(metadata.filePath.lastIndexOf("."))}`;
      const gcsUri = await uploadFile(metadata.filePath, gcsPath, "image/jpeg");
      storagePath = gcsUri;
      console.log(`  Uploaded original to GCS: ${gcsUri}`);
    } catch (error) {
      console.error(`  Failed to upload original to GCS, using local path:`, error);
    }
  }

  db.prepare(
    `
    INSERT INTO images (
      id, file_path, file_hash, width, height, orientation, processing_status, last_modified
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    ON CONFLICT(file_path) DO UPDATE SET
      file_hash = excluded.file_hash,
      width = excluded.width,
      height = excluded.height,
      orientation = excluded.orientation,
      processing_status = 'pending',
      last_modified = excluded.last_modified
  `
  ).run(
    id,
    storagePath, // Store GCS URI or local path
    metadata.fileHash,
    metadata.width,
    metadata.height,
    metadata.orientation,
    metadata.lastModified.toISOString()
  );
}

/**
 * Generate a unique ID for an image
 */
function generateImageId(): string {
  return crypto.randomUUID();
}

/**
 * Scan a directory for images and ingest them into the database
 */
export async function ingestImagesFromDirectory(
  directoryPath: string,
  options: {
    recursive?: boolean;
    verbose?: boolean;
    autoProcess?: boolean;
  } = {}
): Promise<{
  processed: number;
  skipped: number;
  errors: number;
}> {
  const { recursive = true, verbose = false, autoProcess = true } = options;

  let processed = 0;
  let skipped = 0;
  let errors = 0;
  const ingestedImageIds: string[] = [];

  try {
    for await (const entry of walk(directoryPath, {
      maxDepth: recursive ? Infinity : 1,
      includeFiles: true,
      includeDirs: false,
      followSymlinks: false,
    })) {
      // Check if file has supported extension
      const ext = entry.path.substring(entry.path.lastIndexOf(".")).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.includes(ext)) {
        continue;
      }

      try {
        if (verbose) {
          console.log(`Processing: ${entry.path}`);
        }

        // Extract metadata
        const metadata = await extractImageMetadata(entry.path);

        // Check if already exists (by hash to avoid duplicates)
        if (imageExists(metadata.fileHash)) {
          if (verbose) {
            console.log(`  Skipped (duplicate): ${entry.path}`);
          }
          skipped++;
          continue;
        }

        // Store in database
        const imageId = generateImageId();
        await storeImageMetadata(imageId, metadata);

        if (verbose) {
          console.log(`  ✓ Ingested: ${entry.path} (${metadata.width}x${metadata.height}, ${metadata.orientation})`);
        }
        processed++;
        ingestedImageIds.push(imageId);
      } catch (error) {
        console.error(`Error processing ${entry.path}:`, error);
        errors++;
      }
    }
  } catch (error) {
    console.error(`Error scanning directory ${directoryPath}:`, error);
    throw error;
  }

  // Queue processing for newly ingested images
  if (autoProcess && ingestedImageIds.length > 0) {
    for (const imageId of ingestedImageIds) {
      queueImageProcessing(imageId);
    }
  }

  return { processed, skipped, errors };
}

/**
 * Get statistics about ingested images
 */
export function getImageStats(): {
  total: number;
  byOrientation: Record<string, number>;
} {
  const db = getDb();

  const total = db.prepare("SELECT COUNT(*) as count FROM images").get() as { count: number };

  const byOrientation = db
    .prepare(
      `
    SELECT orientation, COUNT(*) as count 
    FROM images 
    GROUP BY orientation
  `
    )
    .all() as Array<{ orientation: string; count: number }>;

  const orientationMap: Record<string, number> = {};
  for (const row of byOrientation) {
    orientationMap[row.orientation] = row.count;
  }

  return {
    total: total.count,
    byOrientation: orientationMap,
  };
}

/**
 * Ingest images from Google Photos Picker API
 */
export async function ingestFromGooglePhotos(
  mediaItems: PickedMediaItem[]
): Promise<{
  ingested: number;
  skipped: number;
  failed: number;
  details: Array<{ filename: string; status: string; error?: string }>;
}> {
  let ingested = 0;
  let skipped = 0;
  let failed = 0;
  const details: Array<{ filename: string; status: string; error?: string }> = [];
  const tempDir = "data/temp-google-photos";

  // Create temporary directory
  try {
    await Deno.mkdir(tempDir, { recursive: true });
  } catch {
    // Directory already exists
  }

  console.log(`📥 Processing ${mediaItems.length} images from Google Photos`);

  for (const item of mediaItems) {
    try {
      // Skip videos
      if (item.type !== "PHOTO") {
        console.log(`  ⏭️  Skipped (video): ${item.mediaFile.filename}`);
        details.push({ filename: item.mediaFile.filename, status: "skipped", error: "Not an image" });
        skipped++;
        continue;
      }

      console.log(`  📥 Downloading: ${item.mediaFile.filename}`);

      // Download image from Google Photos (original size)
      const imageData = await downloadMediaItem(item.mediaFile.baseUrl);

      // Determine file extension from mime type
      const ext = item.mediaFile.mimeType.split("/")[1] || "jpg";
      const tempPath = join(tempDir, `${crypto.randomUUID()}.${ext}`);

      // Save to temporary file
      await Deno.writeFile(tempPath, imageData);

      // Calculate hash to check for duplicates
      const fileHash = await calculateFileHash(tempPath);

      if (imageExists(fileHash)) {
        console.log(`  ⏭️  Skipped (duplicate): ${item.mediaFile.filename}`);
        details.push({ filename: item.mediaFile.filename, status: "skipped", error: "Duplicate" });
        await Deno.remove(tempPath).catch(() => {});
        skipped++;
        continue;
      }

      // Extract metadata
      const width = item.mediaFile.mediaFileMetadata.width;
      const height = item.mediaFile.mediaFileMetadata.height;
      const orientation = determineOrientation(width, height);
      const creationTime = new Date(item.createTime);

      const imageId = generateImageId();
      let storagePath = tempPath;

      // Upload to GCS if enabled
      if (isGCSEnabled()) {
        try {
          const gcsPath = `images/originals/${imageId}.${ext}`;
          const gcsUri = await uploadFile(tempPath, gcsPath, item.mediaFile.mimeType);
          storagePath = gcsUri;
          console.log(`    ☁️  Uploaded to GCS: ${gcsUri}`);
          
          // Clean up local temp file after successful upload
          await Deno.remove(tempPath).catch(() => {});
        } catch (error) {
          console.error(`    ⚠️  Failed to upload to GCS, using local path:`, error);
        }
      }

      // Store in database
      const db = getDb();
      db.prepare(`
        INSERT INTO images (
          id, file_path, file_hash, width, height, orientation, processing_status, last_modified
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        imageId,
        storagePath,
        fileHash,
        width,
        height,
        orientation,
        creationTime.toISOString()
      );

      // Queue for processing
      queueImageProcessing(imageId);

      console.log(`  ✅ Ingested: ${item.filename} (${width}x${height}, ${orientation})`);
      details.push({ filename: item.filename, status: "success" });
      ingested++;
    } catch (error) {
      console.error(`  ❌ Failed to ingest ${item.filename}:`, error);
      details.push({
        filename: item.filename,
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
      });
      failed++;
    }
  }

  console.log(`\n✅ Google Photos import complete:`);
  console.log(`   Ingested: ${ingested}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Failed: ${failed}`);

  return { ingested, skipped, failed, details };
}
