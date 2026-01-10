/**
 * Image processing service using ImageMagick for resizing
 * and color extraction
 */

import { getDb } from "../db/schema.ts";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { crypto } from "@std/crypto";
import { 
  isGCSEnabled, 
  uploadFile, 
  downloadFile, 
  localPathToGCSPath 
} from "./storage.ts";
import { determineLayoutConfiguration, type LayoutConfiguration } from "./image-layout.ts";

// Thumbnail size for UI
const THUMBNAIL_WIDTH = 300;
const THUMBNAIL_HEIGHT = 200;

export interface DeviceSize {
  name: string;
  width: number;
  height: number;
}

export interface ColorPalette {
  primary: string;
  secondary: string;
  tertiary: string;
  allColors: string[];
}

interface ProcessedImageData {
  id: string;
  imageId: string;
  deviceSize: string;
  width: number;
  height: number;
  filePath: string;
  colorPalette: ColorPalette;
  layoutType?: "single" | "paired";
  layoutConfiguration?: LayoutConfiguration;
}

/**
 * Load configuration settings from database
 */
// deno-lint-ignore require-await
export async function loadConfig() {
  const db = getDb();
  
  // Get all registered devices from the database
  const devices = db.prepare(`
    SELECT name, width, height, orientation
    FROM devices
    ORDER BY name
  `).all() as Array<{
    name: string;
    width: number;
    height: number;
    orientation: string;
  }>;

  if (devices.length === 0) {
    throw new Error("No devices registered in database. Please register devices first.");
  }

  // Convert to DeviceSize format
  const deviceSizes: DeviceSize[] = devices.map(d => ({
    name: d.name,
    width: d.width,
    height: d.height,
  }));

  return { deviceSizes };
}

/**
 * Extract dominant colors from an image using ImageMagick
 */
async function extractColors(imagePath: string, numColors = 8): Promise<string[]> {
  const command = new Deno.Command("magick", {
    args: [
      imagePath,
      "-resize", "100x100",
      "-colors", numColors.toString(),
      "-unique-colors",
      "-format", "%c",
      "histogram:info:-"
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await command.output();

  if (code !== 0) {
    const error = new TextDecoder().decode(stderr);
    throw new Error(`Failed to extract colors: ${error}`);
  }

  const output = new TextDecoder().decode(stdout);
  const colors: string[] = [];

  // Parse ImageMagick histogram output
  // Format: "count: (r,g,b) #hex color-name"
  const lines = output.trim().split("\n");
  for (const line of lines) {
    const hexMatch = line.match(/#([0-9A-Fa-f]{6})/);
    if (hexMatch) {
      colors.push(`#${hexMatch[1]}`);
    }
  }

  return colors;
}

/**
 * Calculate color similarity (0-1, where 1 is identical)
 */
export function calculateColorSimilarity(color1: string, color2: string): number {
  const rgb1 = hexToRgb(color1);
  const rgb2 = hexToRgb(color2);

  if (!rgb1 || !rgb2) return 0;

  // Euclidean distance in RGB space
  const distance = Math.sqrt(
    Math.pow(rgb1.r - rgb2.r, 2) +
    Math.pow(rgb1.g - rgb2.g, 2) +
    Math.pow(rgb1.b - rgb2.b, 2)
  );

  // Normalize to 0-1 (max distance is ~441)
  return 1 - (distance / 441);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

/**
 * Calculate palette similarity between two images
 */
export function calculatePaletteSimilarity(
  palette1: ColorPalette,
  palette2: ColorPalette
): number {
  // Compare primary, secondary, and tertiary colors with weights
  const primarySim = calculateColorSimilarity(palette1.primary, palette2.primary);
  const secondarySim = calculateColorSimilarity(palette1.secondary, palette2.secondary);
  const tertiarySim = calculateColorSimilarity(palette1.tertiary, palette2.tertiary);

  // Weighted average (primary is most important)
  return (primarySim * 0.5) + (secondarySim * 0.3) + (tertiarySim * 0.2);
}

/**
 * Resize image from Google Photos using their API
 * This avoids downloading the full original and lets Google Photos do the resizing
 * Falls back to local file if no valid access token is available
 */
async function resizeImageFromGooglePhotos(
  baseUrl: string,
  outputPath: string,
  width: number,
  height: number,
  localFallbackPath: string
): Promise<void> {
  await ensureDir(join(outputPath, ".."));

  // Use Google Photos API to download pre-resized image
  // Format: baseUrl=w{width}-h{height}
  const resizedUrl = `${baseUrl}=w${width}-h${height}`;
  
  console.log(`[Processing] Downloading pre-resized image from Google Photos API`);
  
  // Get the most recent active access token
  const db = getDb();
  const session = db.prepare(
    "SELECT access_token FROM auth_sessions WHERE datetime(token_expiry) > datetime('now') ORDER BY created_at DESC LIMIT 1"
  ).get() as { access_token: string } | undefined;
  
  if (!session) {
    console.warn(`[Processing] No valid auth session found, falling back to local file`);
    // Fall back to using ImageMagick with the local file
    await resizeImage(localFallbackPath, outputPath, width, height);
    return;
  }

  try {
    const response = await fetch(resizedUrl, {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    });

    if (!response.ok) {
      console.warn(`[Processing] Google Photos API returned ${response.status}, falling back to local file`);
      await resizeImage(localFallbackPath, outputPath, width, height);
      return;
    }

    const imageData = await response.arrayBuffer();
    await Deno.writeFile(outputPath, new Uint8Array(imageData));
    
    console.log(`[Processing] Downloaded pre-resized image (${width}x${height})`);
    
    // Upload to GCS if enabled
    if (isGCSEnabled()) {
      const gcsPath = localPathToGCSPath(outputPath);
      
      // Determine MIME type from file extension
      const extIndex = outputPath.lastIndexOf(".");
      const ext = extIndex !== -1 ? outputPath.substring(extIndex).toLowerCase() : "";
      const mimeTypeMap: Record<string, string> = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
      };
      const mimeType = mimeTypeMap[ext] || "image/jpeg";
      
      try {
        const gcsUri = await uploadFile(outputPath, gcsPath, mimeType);
        console.log(`Uploaded to GCS: ${gcsUri}`);
        // Clean up local file after successful upload
        await Deno.remove(outputPath).catch((err) => console.warn('Failed to clean up local file:', err));
      } catch (error) {
        console.error(`Failed to upload to GCS, keeping local file:`, error);
      }
    }
  } catch (error) {
    console.warn(`[Processing] Failed to use Google Photos API: ${error}, falling back to local file`);
    await resizeImage(localFallbackPath, outputPath, width, height);
  }
}

/**
 * Resize image to target dimensions
 */
async function resizeImage(
  sourcePath: string,
  outputPath: string,
  width: number,
  height: number
): Promise<void> {
  await ensureDir(join(outputPath, ".."));

  const command = new Deno.Command("magick", {
    args: [
      sourcePath,
      "-resize", `${width}x${height}^`,
      "-gravity", "center",
      "-extent", `${width}x${height}`,
      "-quality", "90",
      outputPath
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stderr } = await command.output();

  if (code !== 0) {
    const error = new TextDecoder().decode(stderr);
    throw new Error(`Failed to resize image: ${error}`);
  }
  
  // Upload to GCS if enabled
  if (isGCSEnabled()) {
    const gcsPath = localPathToGCSPath(outputPath);
    try {
      const gcsUri = await uploadFile(outputPath, gcsPath, "image/jpeg");
      console.log(`Uploaded to GCS: ${gcsUri}`);
      // Clean up local file after successful upload
      await Deno.remove(outputPath).catch(() => {});
    } catch (error) {
      console.error(`Failed to upload to GCS, keeping local file:`, error);
    }
  }
}

/**
 * Generate thumbnail for UI display
 * Exported for use by worker-queue
 */
export async function generateThumbnail(
  sourcePath: string,
  imageId: string
): Promise<string> {
  const thumbnailDir = "data/processed/thumbnails";
  await ensureDir(thumbnailDir);
  
  const ext = sourcePath.substring(sourcePath.lastIndexOf("."));
  const thumbnailPath = join(thumbnailDir, `${imageId}${ext}`);

  const command = new Deno.Command("magick", {
    args: [
      sourcePath,
      "-resize", `${THUMBNAIL_WIDTH}x${THUMBNAIL_HEIGHT}^`,
      "-gravity", "center",
      "-extent", `${THUMBNAIL_WIDTH}x${THUMBNAIL_HEIGHT}`,
      "-quality", "85",
      thumbnailPath
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stderr } = await command.output();

  if (code !== 0) {
    const error = new TextDecoder().decode(stderr);
    throw new Error(`Failed to generate thumbnail: ${error}`);
  }
  
  // Upload to GCS if enabled
  if (isGCSEnabled()) {
    const gcsPath = localPathToGCSPath(thumbnailPath);
    try {
      const gcsUri = await uploadFile(thumbnailPath, gcsPath, "image/jpeg");
      // Clean up local file after successful upload
      await Deno.remove(thumbnailPath).catch(() => {});
      return gcsUri;
    } catch (error) {
      console.error(`Failed to upload thumbnail to GCS, keeping local file:`, error);
    }
  }
  
  return thumbnailPath;
}

/**
 * Generate thumbnail for an image, handling GCS downloads if needed
 */
export async function generateImageThumbnail(imageId: string): Promise<void> {
  const db = getDb();
  
  const image = db.prepare(
    "SELECT file_path, thumbnail_path FROM images WHERE id = ?"
  ).get(imageId) as { file_path: string; thumbnail_path: string | null } | undefined;

  if (!image) {
    console.error(`[Thumbnail] Image not found: ${imageId}`);
    return;
  }

  // Only generate if not already created
  if (image.thumbnail_path) {
    console.log(`[Thumbnail] Skipping ${imageId} (already exists at ${image.thumbnail_path})`);
    return;
  }

  console.log(`[Thumbnail] Generating thumbnail for ${imageId}`);
  try {
    let sourcePath = image.file_path;
    let tempFile: string | null = null;
    
    // If file is in GCS, download it first
    if (image.file_path.startsWith("gs://")) {
      console.log(`[Thumbnail] Downloading from GCS: ${image.file_path}`);
      const { parseGCSUri } = await import("./storage.ts");
      const gcsInfo = parseGCSUri(image.file_path);
      if (!gcsInfo) {
        throw new Error(`Invalid GCS URI: ${image.file_path}`);
      }
      
      const ext = image.file_path.substring(image.file_path.lastIndexOf("."));
      tempFile = await Deno.makeTempFile({ suffix: ext });
      await downloadFile(gcsInfo.path, tempFile);
      sourcePath = tempFile;
    }
    
    const thumbnailPath = await generateThumbnail(sourcePath, imageId);
    db.prepare("UPDATE images SET thumbnail_path = ? WHERE id = ?").run(thumbnailPath, imageId);
    console.log(`[Thumbnail] ✓ Generated thumbnail for ${imageId}: ${thumbnailPath}`);
    
    // Clean up temp file
    if (tempFile) {
      await Deno.remove(tempFile).catch(() => {});
    }
  } catch (error) {
    console.error(`[Thumbnail] ✗ Failed to generate thumbnail for ${imageId}:`, error);
  }
}

/**
 * Process a single image for a specific device size
 */
export async function processImageForDevice(
  imageId: string,
  deviceSize: DeviceSize,
  outputDir: string
): Promise<ProcessedImageData> {
  console.log(`[Processing] Starting processImageForDevice: ${imageId} for ${deviceSize.name}`);
  const db = getDb();

  // Get original image info
  const image = db.prepare("SELECT * FROM images WHERE id = ?").get(imageId) as {
    id: string;
    file_path: string;
    width: number;
    height: number;
    thumbnail_path?: string;
    google_photos_base_url?: string | null;
  } | undefined;

  if (!image) {
    throw new Error(`Image not found: ${imageId}`);
  }

  // Check if already processed
  const existing = db.prepare(
    "SELECT * FROM processed_images WHERE image_id = ? AND device_size = ?"
  ).get(imageId, deviceSize.name) as ProcessedImageData | undefined;

  if (existing) {
    console.log(`[Processing] Image ${imageId} already processed for ${deviceSize.name}, skipping`);
    return {
      ...existing,
      colorPalette: JSON.parse(existing.colorPalette as unknown as string),
    };
  }

  // Determine layout configuration for this image on this device
  const layoutConfig = determineLayoutConfiguration(
    image.width,
    image.height,
    deviceSize.width,
    deviceSize.height
  );

  console.log(`[Processing] Layout type: ${layoutConfig.layoutType} (image: ${layoutConfig.imageAspectRatio.orientation}, device: ${layoutConfig.deviceOrientation})`);

  // Generate output path
  const ext = image.file_path.substring(image.file_path.lastIndexOf("."));
  const outputPath = join(
    outputDir,
    deviceSize.name,
    `${imageId}${ext}`
  );

  // Resize image using Google Photos API if available, otherwise use ImageMagick
  console.log(`[Processing] Resizing ${imageId} to ${deviceSize.width}x${deviceSize.height}`);
  
  if (image.google_photos_base_url) {
    // Use Google Photos API resizing with fallback to local file
    console.log(`[Processing] Using Google Photos API resizing for ${imageId}`);
    await resizeImageFromGooglePhotos(
      image.google_photos_base_url,
      outputPath,
      deviceSize.width,
      deviceSize.height,
      image.file_path // Fallback to local file if API fails
    );
  } else {
    // Use ImageMagick for local files
    await resizeImage(image.file_path, outputPath, deviceSize.width, deviceSize.height);
  }

  // Determine the final storage path
  const storagePath = isGCSEnabled() 
    ? `gs://${Deno.env.get("GCS_BUCKET_NAME")}/${localPathToGCSPath(outputPath)}`
    : outputPath;

  console.log(`[Processing] Extracting colors from ${imageId}`);
  // Extract colors - use local file if it exists, otherwise download from GCS
  let colorExtractionPath = outputPath;
  if (isGCSEnabled() && !await Deno.stat(outputPath).then(() => true).catch(() => false)) {
    // File was uploaded and removed, need to download for color extraction
    const tempPath = join(Deno.makeTempDirSync(), `temp${ext}`);
    const gcsPath = localPathToGCSPath(outputPath);
    await downloadFile(gcsPath, tempPath);
    colorExtractionPath = tempPath;
  }
  
  const colors = await extractColors(colorExtractionPath);
  
  // Clean up temp file if used
  if (colorExtractionPath !== outputPath) {
    await Deno.remove(colorExtractionPath).catch(() => {});
  }

  const colorPalette: ColorPalette = {
    primary: colors[0] || "#000000",
    secondary: colors[1] || "#000000",
    tertiary: colors[2] || "#000000",
    allColors: colors,
  };

  // Store in database with storage path (either GCS URI or local path)
  const processedId = crypto.randomUUID();
  console.log(`[Processing] Storing processed image ${imageId} for ${deviceSize.name} in database`);
  db.prepare(`
    INSERT INTO processed_images (
      id, image_id, device_size, width, height, file_path,
      color_primary, color_secondary, color_tertiary, color_palette
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    processedId,
    imageId,
    deviceSize.name,
    deviceSize.width,
    deviceSize.height,
    storagePath,  // Store GCS URI or local path
    colorPalette.primary,
    colorPalette.secondary,
    colorPalette.tertiary,
    JSON.stringify(colorPalette)
  );

  console.log(`[Processing] ✓ Completed processing ${imageId} for ${deviceSize.name}`);
  return {
    id: processedId,
    imageId,
    deviceSize: deviceSize.name,
    width: deviceSize.width,
    height: deviceSize.height,
    filePath: storagePath,
    colorPalette,
    layoutType: layoutConfig.layoutType,
    layoutConfiguration: layoutConfig,
  };
}

/**
 * Process all images for all device sizes
 */
export async function processAllImages(
  outputDir: string,
  options: { verbose?: boolean } = {}
): Promise<{ processed: number; errors: number; skipped: number }> {
  const { verbose = false } = options;
  const config = await loadConfig();
  const deviceSizes: DeviceSize[] = config.deviceSizes;
  
  const db = getDb();
  const images = db.prepare("SELECT id FROM images").all() as Array<{ id: string }>;

  let processed = 0;
  let errors = 0;
  let skipped = 0;

  for (const image of images) {
    for (const deviceSize of deviceSizes) {
      try {
        // Check if already processed
        const existing = db.prepare(
          "SELECT id FROM processed_images WHERE image_id = ? AND device_size = ?"
        ).get(image.id, deviceSize.name);

        if (existing) {
          if (verbose) {
            console.log(`  Skipped: ${image.id} for ${deviceSize.name} (already processed)`);
          }
          skipped++;
          continue;
        }

        if (verbose) {
          console.log(`  Processing: ${image.id} for ${deviceSize.name}...`);
        }

        await processImageForDevice(image.id, deviceSize, outputDir);
        processed++;
      } catch (error) {
        console.error(`Error processing ${image.id} for ${deviceSize.name}:`, error);
        errors++;
      }
    }
  }

  return { processed, errors, skipped };
}

/**
 * Get all processed images for a device size
 */
export function getProcessedImagesForDevice(deviceSize: string): Array<{
  id: string;
  imageId: string;
  filePath: string;
  colorPalette: ColorPalette;
}> {
  const db = getDb();
  
  const results = db.prepare(`
    SELECT id, image_id, file_path, color_palette
    FROM processed_images
    WHERE device_size = ?
  `).all(deviceSize) as Array<{
    id: string;
    image_id: string;
    file_path: string;
    color_palette: string;
  }>;

  return results.map(r => ({
    id: r.id,
    imageId: r.image_id,
    filePath: r.file_path,
    colorPalette: JSON.parse(r.color_palette),
  }));
}

/**
 * Get portrait images that need pairing for a landscape device
 * Returns images that have layoutType === "paired"
 */
export function getPortraitImagesForPairing(deviceSize: string): Array<{
  id: string;
  imageId: string;
  filePath: string;
  colorPalette: ColorPalette;
}> {
  const db = getDb();
  
  // Get all portrait images for this device
  // Note: We check the original image orientation to find portraits
  const results = db.prepare(`
    SELECT pi.id, pi.image_id, pi.file_path, pi.color_palette
    FROM processed_images pi
    JOIN images i ON pi.image_id = i.id
    WHERE pi.device_size = ? AND i.orientation = 'portrait'
  `).all(deviceSize) as Array<{
    id: string;
    image_id: string;
    file_path: string;
    color_palette: string;
  }>;

  return results.map(r => ({
    id: r.id,
    imageId: r.image_id,
    filePath: r.file_path,
    colorPalette: JSON.parse(r.color_palette),
  }));
}
