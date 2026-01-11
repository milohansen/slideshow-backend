/**
 * Image processing service using sharp for resizing
 * and color extraction
 */

import { QuantizerCelebi, Score, argbFromRgb } from "@material/material-color-utilities";
import { crypto } from "@std/crypto";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import sharp from "sharp";
import { getDb } from "../db/schema.ts";
import { determineLayoutConfiguration, type LayoutConfiguration } from "./image-layout.ts";
import { downloadFile, isGCSEnabled, localPathToGCSPath, parseGCSUri, uploadFile } from "./storage.ts";

// Thumbnail size for UI
const THUMBNAIL_WIDTH = 300;
const THUMBNAIL_HEIGHT = 200;

export type DeviceSize = {
  name: string;
  width: number;
  height: number;
};

export type ColorPalette = {
  primary: string;
  secondary: string;
  tertiary: string;
  sourceColor: string; // The dominant/seed color used for generating the scheme
  allColors: string[];
};

type ProcessedImageData = {
  id: string;
  imageId: string;
  deviceSize: string;
  width: number;
  height: number;
  filePath: string;
  colorPalette: ColorPalette;
  layoutType?: "single" | "paired";
  layoutConfiguration?: LayoutConfiguration;
};

/**
 * Load configuration settings from database
 */
// deno-lint-ignore require-await
export async function loadConfig() {
  const db = getDb();

  // Get all registered devices from the database
  const devices = db
    .prepare(
      `
    SELECT name, width, height, orientation
    FROM devices
    ORDER BY name
  `
    )
    .all() as Array<{
    name: string;
    width: number;
    height: number;
    orientation: string;
  }>;

  if (devices.length === 0) {
    throw new Error("No devices registered in database. Please register devices first.");
  }

  // Convert to DeviceSize format
  const deviceSizes: DeviceSize[] = devices.map((d) => ({
    name: d.name,
    width: d.width,
    height: d.height,
  }));

  return { deviceSizes };
}

/**
 * Extract dominant colors from an image using Material Color Utilities
 * Uses Material Design 3's quantization and scoring algorithms for better color selection
 * @param imagePath - Path to the image file
 * @param numColors - Number of colors to extract (default: 8)
 * @param maxResolution - Maximum resolution for processing (default: 256 for performance).
 */
export async function extractColors(imagePath: string, numColors = 8, maxResolution = 256): Promise<string[]> {
  // Step 1: Extract raw RGBA pixel data using sharp
  // Resize large images to max resolution for performance
  const { data, info } = await sharp(imagePath).resize(maxResolution, maxResolution, { fit: "inside", withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const pixelData = new Uint8Array(data);

  // Step 2: Convert RGBA bytes to ARGB integers
  const pixels: number[] = [];
  for (let i = 0; i < pixelData.length; i += 4) {
    const r = pixelData[i];
    const g = pixelData[i + 1];
    const b = pixelData[i + 2];
    const a = pixelData[i + 3];

    // Skip fully transparent pixels
    if (a < 255) continue;

    const argb = argbFromRgb(r, g, b);
    pixels.push(argb);
  }

  if (pixels.length === 0) {
    throw new Error("No valid pixels found in image");
  }

  // Step 3: Quantize to get color histogram
  const quantized = QuantizerCelebi.quantize(pixels, 128);

  // Step 4: Score colors using Material Design principles
  const rankedColors = Score.score(quantized, {
    desired: numColors,
    filter: true, // Filter out unsuitable colors (low chroma, etc.)
    fallbackColorARGB: 0xff4285f4, // Google Blue as fallback
  });

  // Step 5: Convert ARGB integers to hex strings
  const colors: string[] = [];
  for (const argb of rankedColors) {
    const hex = "#" + (argb & 0xffffff).toString(16).padStart(6, "0").toUpperCase();
    colors.push(hex);
  }

  // Ensure we always return at least numColors (pad with fallback if needed)
  while (colors.length < numColors && colors.length > 0) {
    colors.push(colors[0]); // Duplicate primary color as fallback
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
  const distance = Math.sqrt(Math.pow(rgb1.r - rgb2.r, 2) + Math.pow(rgb1.g - rgb2.g, 2) + Math.pow(rgb1.b - rgb2.b, 2));

  // Normalize to 0-1 (max distance is ~441)
  return 1 - distance / 441;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

/**
 * Calculate palette similarity between two images
 */
export function calculatePaletteSimilarity(palette1: ColorPalette, palette2: ColorPalette): number {
  // Compare primary, secondary, and tertiary colors with weights
  const primarySim = calculateColorSimilarity(palette1.primary, palette2.primary);
  const secondarySim = calculateColorSimilarity(palette1.secondary, palette2.secondary);
  const tertiarySim = calculateColorSimilarity(palette1.tertiary, palette2.tertiary);

  // Weighted average (primary is most important)
  return primarySim * 0.5 + secondarySim * 0.3 + tertiarySim * 0.2;
}

/**
 * Resize image from Google Photos using their API
 * This avoids downloading the full original and lets Google Photos do the resizing
 * Falls back to local file if no valid access token is available
 */
async function resizeImageFromGooglePhotos(baseUrl: string, outputPath: string, width: number, height: number, localFallbackPath: string): Promise<void> {
  await ensureDir(join(outputPath, ".."));

  // Use Google Photos API to download pre-resized image
  // Format: baseUrl=w{width}-h{height}
  const resizedUrl = `${baseUrl}=w${width}-h${height}`;

  console.log(`[Processing] Downloading pre-resized image from Google Photos API`);

  // Get the most recent active access token
  const db = getDb();
  const session = db.prepare("SELECT access_token FROM auth_sessions WHERE datetime(token_expiry) > datetime('now') ORDER BY created_at DESC LIMIT 1").get() as { access_token: string } | undefined;

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
        await Deno.remove(outputPath).catch((err) => console.warn("Failed to clean up local file:", err));
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
async function resizeImage(sourcePath: string, outputPath: string, width: number, height: number): Promise<void> {
  console.log(`[resizeImage] 🔧 Starting resize: ${sourcePath} -> ${outputPath} (${width}x${height})`);

  console.log(`[resizeImage] 📁 Ensuring output directory exists...`);
  await ensureDir(join(outputPath, ".."));
  console.log(`[resizeImage] ✅ Output directory ready`);

  console.log(`[resizeImage] ⚙️ Running sharp resize...`);
  await sharp(sourcePath)
    .resize(width, height, {
      fit: "cover",
      position: "centre",
    })
    .jpeg({ quality: 90 })
    .toFile(outputPath);

  console.log(`[resizeImage] ✅ Sharp resize successful`);

  // Upload to GCS if enabled
  if (isGCSEnabled()) {
    console.log(`[resizeImage] ☁️ GCS enabled, uploading...`);
    const gcsPath = localPathToGCSPath(outputPath);
    try {
      const gcsUri = await uploadFile(outputPath, gcsPath, "image/jpeg");
      console.log(`[resizeImage] ✅ Uploaded to GCS: ${gcsUri}`);
      // Clean up local file after successful upload
      await Deno.remove(outputPath).catch(() => {});
    } catch (error) {
      console.error(`[resizeImage] ⚠️ Failed to upload to GCS, keeping local file:`, error);
    }
  } else {
    console.log(`[resizeImage] 💾 GCS not enabled, keeping local file`);
  }
  console.log(`[resizeImage] ✅✅ Resize completed successfully`);
}

/**
 * Generate thumbnail for UI display
 * Exported for use by worker-queue
 */
export async function generateThumbnail(sourcePath: string, imageId: string): Promise<string> {
  const thumbnailDir = "data/processed/thumbnails";
  await ensureDir(thumbnailDir);

  const ext = sourcePath.substring(sourcePath.lastIndexOf("."));
  const thumbnailPath = join(thumbnailDir, `${imageId}${ext}`);

  const command = new Deno.Command("magick", {
    args: [sourcePath, "-resize", `${THUMBNAIL_WIDTH}x${THUMBNAIL_HEIGHT}^`, "-gravity", "center", "-extent", `${THUMBNAIL_WIDTH}x${THUMBNAIL_HEIGHT}`, "-quality", "85", thumbnailPath],
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

  const image = db.prepare("SELECT file_path, thumbnail_path FROM images WHERE id = ?").get(imageId) as { file_path: string; thumbnail_path: string | null } | undefined;

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
 * @param imageId - The image ID
 * @param deviceSize - The target device dimensions
 * @param outputDir - Output directory for processed images
 * @param googlePhotosBaseUrl - Optional Google Photos base URL for API resizing
 */
/**
 * Process image for device without database dependency (for use in workers)
 * Returns the processing result data without storing to database
 */
export async function processImageForDeviceWorker(
  imageData: {
    id: string;
    file_path: string;
    width: number;
    height: number;
  },
  deviceSize: DeviceSize,
  outputDir: string,
  googlePhotosBaseUrl?: string
): Promise<{
  processedId: string;
  imageId: string;
  deviceSize: string;
  width: number;
  height: number;
  filePath: string;
  colorPalette: ColorPalette;
  layoutType: "single" | "paired";
  layoutConfiguration: LayoutConfiguration;
}> {
  const imageId = imageData.id;
  console.log(`[Processing] 🎯 Starting processImageForDeviceWorker: ${imageId} for ${deviceSize.name}`);
  console.log(`[Processing] 📋 Parameters:`, {
    imageId,
    deviceName: deviceSize.name,
    deviceWidth: deviceSize.width,
    deviceHeight: deviceSize.height,
    outputDir,
    hasGooglePhotosUrl: !!googlePhotosBaseUrl,
  });

  console.log(`[Processing] ✅ Received image data: ${imageData.file_path} (${imageData.width}x${imageData.height})`);

  // Determine layout configuration for this image on this device
  console.log(`[Processing] 📊 Determining layout configuration...`);
  const layoutConfig = determineLayoutConfiguration(imageData.width, imageData.height, deviceSize.width, deviceSize.height);

  console.log(`[Processing] 📋 Layout type: ${layoutConfig.layoutType} (image: ${layoutConfig.imageAspectRatio.orientation}, device: ${layoutConfig.deviceOrientation})`);

  // Generate output path
  const ext = imageData.file_path.substring(imageData.file_path.lastIndexOf("."));
  const outputPath = join(outputDir, deviceSize.name, `${imageId}${ext}`);
  console.log(`[Processing] 💾 Output path: ${outputPath}`);

  // Download source file from GCS if needed
  let sourceFilePath = imageData.file_path;
  let tempSourceFile: string | null = null;

  if (imageData.file_path.startsWith("gs://")) {
    console.log(`[Processing] ☁️ Source file is in GCS, downloading: ${imageData.file_path}`);
    const gcsInfo = parseGCSUri(imageData.file_path);
    if (!gcsInfo) {
      throw new Error(`Invalid GCS URI: ${imageData.file_path}`);
    }

    tempSourceFile = join(Deno.makeTempDirSync(), `source-${imageId}${ext}`);
    await downloadFile(gcsInfo.path, tempSourceFile);
    sourceFilePath = tempSourceFile;
    console.log(`[Processing] ✅ Downloaded source file to: ${sourceFilePath}`);
  }

  // Resize image using Google Photos API if available, otherwise use ImageMagick
  console.log(`[Processing] 📸 Resizing ${imageId} to ${deviceSize.width}x${deviceSize.height}`);

  try {
    if (googlePhotosBaseUrl) {
      // Use Google Photos API resizing with fallback to local file
      console.log(`[Processing] ☁️ Using Google Photos API resizing for ${imageId}`);
      await resizeImageFromGooglePhotos(
        googlePhotosBaseUrl,
        outputPath,
        deviceSize.width,
        deviceSize.height,
        sourceFilePath // Use downloaded file if from GCS
      );
    } else {
      // Use ImageMagick for local files
      console.log(`[Processing] 🛠️ Using ImageMagick for resize`);
      await resizeImage(sourceFilePath, outputPath, deviceSize.width, deviceSize.height);
    }
    console.log(`[Processing] ✅ Resize completed`);
  } finally {
    // Clean up temp source file if we downloaded from GCS
    if (tempSourceFile) {
      console.log(`[Processing] 🧹 Cleaning up temp source file: ${tempSourceFile}`);
      await Deno.remove(tempSourceFile).catch(() => {});
    }
  }

  // Determine the final storage path
  const storagePath = isGCSEnabled() ? `gs://${Deno.env.get("GCS_BUCKET_NAME")}/${localPathToGCSPath(outputPath)}` : outputPath;
  console.log(`[Processing] 💾 Storage path: ${storagePath}`);

  console.log(`[Processing] 🎨 Extracting colors from ${imageId}...`);
  // Extract colors - use local file if it exists, otherwise download from GCS
  let colorExtractionPath = outputPath;
  if (
    isGCSEnabled() &&
    !(await Deno.stat(outputPath)
      .then(() => true)
      .catch(() => false))
  ) {
    // File was uploaded and removed, need to download for color extraction
    console.log(`[Processing] ☁️ File not found locally, downloading from GCS for color extraction`);
    const tempPath = join(Deno.makeTempDirSync(), `temp${ext}`);
    const gcsPath = localPathToGCSPath(outputPath);
    await downloadFile(gcsPath, tempPath);
    colorExtractionPath = tempPath;
  }

  console.log(`[Processing] 🎨 Extracting colors from: ${colorExtractionPath}`);
  const colors = await extractColors(colorExtractionPath);
  console.log(`[Processing] ✅ Extracted ${colors.length} colors:`, colors);

  // Clean up temp file if used
  if (colorExtractionPath !== outputPath) {
    console.log(`[Processing] 🧹 Cleaning up temp file: ${colorExtractionPath}`);
    await Deno.remove(colorExtractionPath).catch(() => {});
  }

  const colorPalette: ColorPalette = {
    primary: colors[0] || "#000000",
    secondary: colors[1] || "#000000",
    tertiary: colors[2] || "#000000",
    sourceColor: colors[0] || "#000000",
    allColors: colors,
  };
  console.log(`[Processing] 🎨 Color palette created:`, colorPalette);

  const processedId = crypto.randomUUID();
  console.log(`[Processing] ✅✅✅ FULLY COMPLETED processing ${imageId} for ${deviceSize.name}`);

  return {
    processedId,
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
 * Process image for device with database operations (for use in main thread)
 */
export async function processImageForDevice(imageId: string, deviceSize: DeviceSize, outputDir: string, googlePhotosBaseUrl?: string): Promise<ProcessedImageData> {
  console.log(`[Processing] 🎯 Starting processImageForDevice: ${imageId} for ${deviceSize.name}`);
  console.log(`[Processing] 📋 Parameters:`, {
    imageId,
    deviceName: deviceSize.name,
    deviceWidth: deviceSize.width,
    deviceHeight: deviceSize.height,
    outputDir,
    hasGooglePhotosUrl: !!googlePhotosBaseUrl,
  });
  const db = getDb();

  // Get original image info
  console.log(`[Processing] 🔍 Querying database for image ${imageId}`);
  const image = db.prepare("SELECT * FROM images WHERE id = ?").get(imageId) as
    | {
        id: string;
        file_path: string;
        width: number;
        height: number;
        thumbnail_path?: string;
      }
    | undefined;

  if (!image) {
    console.error(`[Processing] ❌ Image not found in database: ${imageId}`);
    throw new Error(`Image not found: ${imageId}`);
  }
  console.log(`[Processing] ✅ Found image: ${image.file_path} (${image.width}x${image.height})`);

  // Check if already processed
  console.log(`[Processing] 🔍 Checking if already processed for ${deviceSize.name}`);
  const existing = db.prepare("SELECT * FROM processed_images WHERE image_id = ? AND device_size = ?").get(imageId, deviceSize.name) as ProcessedImageData | undefined;

  if (existing) {
    console.log(`[Processing] ⏩ Image ${imageId} already processed for ${deviceSize.name}, skipping`);
    return {
      ...existing,
      colorPalette: JSON.parse(existing.colorPalette as unknown as string),
    };
  }
  console.log(`[Processing] ✅ Not yet processed, continuing...`);

  // Determine layout configuration for this image on this device
  console.log(`[Processing] 📊 Determining layout configuration...`);
  const layoutConfig = determineLayoutConfiguration(image.width, image.height, deviceSize.width, deviceSize.height);

  console.log(`[Processing] 📋 Layout type: ${layoutConfig.layoutType} (image: ${layoutConfig.imageAspectRatio.orientation}, device: ${layoutConfig.deviceOrientation})`);

  // Generate output path
  const ext = image.file_path.substring(image.file_path.lastIndexOf("."));
  const outputPath = join(outputDir, deviceSize.name, `${imageId}${ext}`);
  console.log(`[Processing] 💾 Output path: ${outputPath}`);

  // Download source file from GCS if needed
  let sourceFilePath = image.file_path;
  let tempSourceFile: string | null = null;

  if (image.file_path.startsWith("gs://")) {
    console.log(`[Processing] ☁️ Source file is in GCS, downloading: ${image.file_path}`);
    const gcsInfo = parseGCSUri(image.file_path);
    if (!gcsInfo) {
      throw new Error(`Invalid GCS URI: ${image.file_path}`);
    }

    tempSourceFile = join(Deno.makeTempDirSync(), `source-${imageId}${ext}`);
    await downloadFile(gcsInfo.path, tempSourceFile);
    sourceFilePath = tempSourceFile;
    console.log(`[Processing] ✅ Downloaded source file to: ${sourceFilePath}`);
  }

  // Resize image using Google Photos API if available, otherwise use ImageMagick
  console.log(`[Processing] 📸 Resizing ${imageId} to ${deviceSize.width}x${deviceSize.height}`);

  try {
    if (googlePhotosBaseUrl) {
      // Use Google Photos API resizing with fallback to local file
      console.log(`[Processing] ☁️ Using Google Photos API resizing for ${imageId}`);
      await resizeImageFromGooglePhotos(
        googlePhotosBaseUrl,
        outputPath,
        deviceSize.width,
        deviceSize.height,
        sourceFilePath // Use downloaded file if from GCS
      );
    } else {
      // Use ImageMagick for local files
      console.log(`[Processing] 🛠️ Using ImageMagick for resize`);
      await resizeImage(sourceFilePath, outputPath, deviceSize.width, deviceSize.height);
    }
    console.log(`[Processing] ✅ Resize completed`);
  } finally {
    // Clean up temp source file if we downloaded from GCS
    if (tempSourceFile) {
      console.log(`[Processing] 🧹 Cleaning up temp source file: ${tempSourceFile}`);
      await Deno.remove(tempSourceFile).catch(() => {});
    }
  }

  // Determine the final storage path
  const storagePath = isGCSEnabled() ? `gs://${Deno.env.get("GCS_BUCKET_NAME")}/${localPathToGCSPath(outputPath)}` : outputPath;
  console.log(`[Processing] 💾 Storage path: ${storagePath}`);

  console.log(`[Processing] 🎨 Extracting colors from ${imageId}...`);
  // Extract colors - use local file if it exists, otherwise download from GCS
  let colorExtractionPath = outputPath;
  if (
    isGCSEnabled() &&
    !(await Deno.stat(outputPath)
      .then(() => true)
      .catch(() => false))
  ) {
    // File was uploaded and removed, need to download for color extraction
    console.log(`[Processing] ☁️ File not found locally, downloading from GCS for color extraction`);
    const tempPath = join(Deno.makeTempDirSync(), `temp${ext}`);
    const gcsPath = localPathToGCSPath(outputPath);
    await downloadFile(gcsPath, tempPath);
    colorExtractionPath = tempPath;
  }

  console.log(`[Processing] 🎨 Extracting colors from: ${colorExtractionPath}`);
  const colors = await extractColors(colorExtractionPath);
  console.log(`[Processing] ✅ Extracted ${colors.length} colors:`, colors);

  // Clean up temp file if used
  if (colorExtractionPath !== outputPath) {
    console.log(`[Processing] 🧹 Cleaning up temp file: ${colorExtractionPath}`);
    await Deno.remove(colorExtractionPath).catch(() => {});
  }

  const colorPalette: ColorPalette = {
    primary: colors[0] || "#000000",
    secondary: colors[1] || "#000000",
    tertiary: colors[2] || "#000000",
    sourceColor: colors[0] || "#000000", // Use the most dominant color as source
    allColors: colors,
  };
  console.log(`[Processing] 🎨 Color palette created:`, colorPalette);

  // Store in database with storage path (either GCS URI or local path)
  const processedId = crypto.randomUUID();
  console.log(`[Processing] 💾 Storing processed image ${imageId} for ${deviceSize.name} in database with ID ${processedId}`);
  db.prepare(
    `
    INSERT INTO processed_images (
      id, image_id, device_size, width, height, file_path,
      color_primary, color_secondary, color_tertiary, color_source, color_palette
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    processedId,
    imageId,
    deviceSize.name,
    deviceSize.width,
    deviceSize.height,
    storagePath, // Store GCS URI or local path
    colorPalette.primary,
    colorPalette.secondary,
    colorPalette.tertiary,
    colorPalette.sourceColor,
    JSON.stringify(colorPalette)
  );
  console.log(`[Processing] ✅ Database insert completed`);

  console.log(`[Processing] ✅✅✅ FULLY COMPLETED processing ${imageId} for ${deviceSize.name}`);
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
export async function processAllImages(outputDir: string, options: { verbose?: boolean } = {}): Promise<{ processed: number; errors: number; skipped: number }> {
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
        const existing = db.prepare("SELECT id FROM processed_images WHERE image_id = ? AND device_size = ?").get(image.id, deviceSize.name);

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

        // Note: processAllImages processes local files, so no Google Photos URL
        await processImageForDevice(image.id, deviceSize, outputDir, undefined);
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

  const results = db
    .prepare(
      `
    SELECT id, image_id, file_path, color_palette
    FROM processed_images
    WHERE device_size = ?
  `
    )
    .all(deviceSize) as Array<{
    id: string;
    image_id: string;
    file_path: string;
    color_palette: string;
  }>;

  return results.map((r) => ({
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
  const results = db
    .prepare(
      `
    SELECT pi.id, pi.image_id, pi.file_path, pi.color_palette
    FROM processed_images pi
    JOIN images i ON pi.image_id = i.id
    WHERE pi.device_size = ? AND i.orientation = 'portrait'
  `
    )
    .all(deviceSize) as Array<{
    id: string;
    image_id: string;
    file_path: string;
    color_palette: string;
  }>;

  return results.map((r) => ({
    id: r.id,
    imageId: r.image_id,
    filePath: r.file_path,
    colorPalette: JSON.parse(r.color_palette),
  }));
}
