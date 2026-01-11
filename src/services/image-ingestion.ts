import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { walk } from "@std/fs/walk";
import { join } from "@std/path";
import sharp from "sharp";
import { getDb } from "../db/schema.ts";
import { downloadMediaItem, type PickedMediaItem } from "./google-photos.ts";
import { queueImageProcessing } from "./job-queue.ts";
import { isGCSEnabled, uploadFile } from "./storage.ts";

const SUPPORTED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

export type ImageMetadata = {
  filePath: string;
  fileHash: string;
  width: number;
  height: number;
  ratio: number; // width / height rounded to 5 decimal places
  orientation: "portrait" | "landscape" | "square";
  lastModified: Date;
};

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
  const metadata = await sharp(filePath).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error(`Unable to extract dimensions from ${filePath}`);
  }
  return [metadata.width, metadata.height];
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
  const ratio = parseFloat((width / height).toFixed(5));

  return {
    filePath,
    fileHash,
    width,
    height,
    ratio,
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
      id, file_path, file_hash, width, height, aspect_ratio, orientation, processing_status, last_modified
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    ON CONFLICT(file_path) DO UPDATE SET
      file_hash = excluded.file_hash,
      width = excluded.width,
      height = excluded.height,
      aspect_ratio = excluded.aspect_ratio,
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
    metadata.ratio,
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
  accessToken: string,
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
      const imageData = await downloadMediaItem(accessToken, item.mediaFile.baseUrl);

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
      const ratio = parseFloat((width / height).toFixed(5));
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
      db.prepare(
        `
        INSERT INTO images (
          id, file_path, file_hash, width, height, aspect_ratio, orientation, processing_status, last_modified
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `
      ).run(imageId, storagePath, fileHash, width, height, ratio, orientation, creationTime.toISOString());

      // Queue for processing
      // Note: Google Photos API resizing feature preserved in worker-queue.ts for future use
      queueImageProcessing(imageId);

      console.log(`  ✅ Ingested: ${item.mediaFile.filename} (${width}x${height}, ${orientation})`);
      details.push({ filename: item.mediaFile.filename, status: "success" });
      ingested++;
    } catch (error) {
      console.error(`  ❌ Failed to ingest ${item.mediaFile.filename}:`, error);
      details.push({
        filename: item.mediaFile.filename,
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

/**
 * Initial processing pipeline for uploaded images
 * Maintains consistent structure with Google Photos pipeline
 */
export type InitialProcessingResult = {
  imageId: string;
  metadata: ImageMetadata;
  status: "success" | "skipped" | "failed";
  reason?: string;
};

/**
 * Process a single uploaded image through the initial pipeline
 * This function provides a consistent interface for uploaded images
 */
export async function processUploadedImage(filePath: string): Promise<InitialProcessingResult> {
  try {
    // Step 1: Extract metadata (dimensions, hash, orientation)
    const metadata = await extractImageMetadata(filePath);

    // Step 2: Check for duplicates
    if (imageExists(metadata.fileHash)) {
      return {
        imageId: "",
        metadata,
        status: "skipped",
        reason: "Duplicate image",
      };
    }

    // Step 3: Store metadata in database
    const imageId = generateImageId();
    await storeImageMetadata(imageId, metadata);

    // Step 4: Queue for device-specific processing
    queueImageProcessing(imageId);

    return {
      imageId,
      metadata,
      status: "success",
    };
  } catch (error) {
    return {
      imageId: "",
      metadata: {
        filePath,
        fileHash: "",
        width: 0,
        height: 0,
        ratio: 1.0,
        orientation: "landscape",
        lastModified: new Date(),
      },
      status: "failed",
      reason: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Process a single Google Photos image through the initial pipeline
 * Maintains structural similarity with processUploadedImage for code clarity
 */
export async function processGooglePhotosImage(accessToken: string, mediaItem: PickedMediaItem, tempDir: string = "data/temp-google-photos"): Promise<InitialProcessingResult> {
  try {
    // Skip videos
    if (mediaItem.type !== "PHOTO") {
      return {
        imageId: "",
        metadata: {
          filePath: "",
          fileHash: "",
          width: 0,
          height: 0,
          ratio: 1.0,
          orientation: "landscape",
          lastModified: new Date(),
        },
        status: "skipped",
        reason: "Not an image",
      };
    }

    // Ensure temp directory exists
    try {
      await Deno.mkdir(tempDir, { recursive: true });
    } catch {
      // Directory already exists
    }

    // Step 1: Download image from Google Photos
    const imageData = await downloadMediaItem(accessToken, mediaItem.mediaFile.baseUrl);

    // Determine file extension from mime type
    const ext = mediaItem.mediaFile.mimeType.split("/")[1] || "jpg";
    const tempPath = join(tempDir, `${crypto.randomUUID()}.${ext}`);

    // Save to temporary file
    await Deno.writeFile(tempPath, imageData);

    // Step 2: Extract metadata (hash for duplicate detection)
    const fileHash = await calculateFileHash(tempPath);

    // Step 3: Check for duplicates
    if (imageExists(fileHash)) {
      await Deno.remove(tempPath).catch(() => {});
      const width = mediaItem.mediaFile.mediaFileMetadata.width;
      const height = mediaItem.mediaFile.mediaFileMetadata.height;
      const ratio = parseFloat((width / height).toFixed(5));
      return {
        imageId: "",
        metadata: {
          filePath: "", // Empty since temp file was deleted
          fileHash,
          width,
          height,
          ratio,
          orientation: determineOrientation(width, height),
          lastModified: new Date(mediaItem.createTime),
        },
        status: "skipped",
        reason: "Duplicate image",
      };
    }

    // Step 4: Extract full metadata
    const width = mediaItem.mediaFile.mediaFileMetadata.width;
    const height = mediaItem.mediaFile.mediaFileMetadata.height;
    const ratio = parseFloat((width / height).toFixed(5));
    const orientation = determineOrientation(width, height);
    const creationTime = new Date(mediaItem.createTime);

    const imageId = generateImageId();
    let storagePath = tempPath;

    // Upload to GCS if enabled
    if (isGCSEnabled()) {
      try {
        const gcsPath = `images/originals/${imageId}.${ext}`;
        const gcsUri = await uploadFile(tempPath, gcsPath, mediaItem.mediaFile.mimeType);
        storagePath = gcsUri;

        // Clean up local temp file after successful upload
        await Deno.remove(tempPath).catch(() => {});
      } catch (error) {
        console.error(`Failed to upload to GCS, using local path:`, error);
      }
    }

    // Step 5: Store in database using consistent metadata structure
    const metadata: ImageMetadata = {
      filePath: storagePath,
      fileHash,
      width,
      height,
      ratio,
      orientation,
      lastModified: creationTime,
    };

    // Store metadata in database
    const db = getDb();
    db.prepare(
      `
      INSERT INTO images (
        id, file_path, file_hash, width, height, aspect_ratio, orientation, processing_status, last_modified
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `
    ).run(imageId, metadata.filePath, metadata.fileHash, metadata.width, metadata.height, metadata.ratio, metadata.orientation, metadata.lastModified.toISOString());

    // Step 6: Queue for device-specific processing
    // Note: Google Photos API resizing feature preserved in worker-queue.ts for future use
    queueImageProcessing(imageId);

    return {
      imageId,
      metadata,
      status: "success",
    };
  } catch (error) {
    return {
      imageId: "",
      metadata: {
        filePath: "",
        fileHash: "",
        width: 0,
        height: 0,
        ratio: 1.0,
        orientation: "landscape",
        lastModified: new Date(),
      },
      status: "failed",
      reason: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
