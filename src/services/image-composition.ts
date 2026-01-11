/**
 * Image composition service for later-stage processing with sharp
 * This module handles composite operations like pairing portrait images,
 * adding overlays, and creating combined layouts
 */

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import sharp from "sharp";
import { calculatePairedPortraitLayout } from "./image-layout.ts";
import { downloadFile, isGCSEnabled, localPathToGCSPath, parseGCSUri, uploadFile } from "./storage.ts";

export type CompositeImageOptions = {
  outputPath: string;
  deviceWidth: number;
  deviceHeight: number;
  backgroundColor?: string;
  quality?: number;
}

export type PairedPortraitCompositeOptions = CompositeImageOptions & {
  image1Path: string;
  image1Width: number;
  image1Height: number;
  image2Path: string;
  image2Width: number;
  image2Height: number;
}

/**
 * Create a composite image by pairing two portrait images side-by-side
 * Uses ImageMagick's composite operator
 */
export async function composePairedPortraitImages(
  options: PairedPortraitCompositeOptions
): Promise<string> {
  const {
    image1Path,
    image1Width,
    image1Height,
    image2Path,
    image2Width,
    image2Height,
    outputPath,
    deviceWidth,
    deviceHeight,
    backgroundColor = "#000000",
    quality = 90,
  } = options;

  await ensureDir(join(outputPath, ".."));

  // Calculate layout for the two images
  const layout = calculatePairedPortraitLayout(
    image1Width,
    image1Height,
    image2Width,
    image2Height,
    deviceWidth,
    deviceHeight
  );

  const halfWidth = Math.floor(deviceWidth / 2);

  // Download from GCS if needed
  let tempFiles: string[] = [];
  let localImage1Path = image1Path;
  let localImage2Path = image2Path;

  if (image1Path.startsWith("gs://")) {
    const tempPath = await Deno.makeTempFile({ suffix: ".jpg" });
    const gcsInfo = parseGCSUri(image1Path);
    if (gcsInfo) {
      await downloadFile(gcsInfo.path, tempPath);
      localImage1Path = tempPath;
      tempFiles.push(tempPath);
    }
  }

  if (image2Path.startsWith("gs://")) {
    const tempPath = await Deno.makeTempFile({ suffix: ".jpg" });
    const gcsInfo = parseGCSUri(image2Path);
    if (gcsInfo) {
      await downloadFile(gcsInfo.path, tempPath);
      localImage2Path = tempPath;
      tempFiles.push(tempPath);
    }
  }

  try {
    // Step 1: Resize first image to fit left half
    const temp1 = await Deno.makeTempFile({ suffix: ".jpg" });
    tempFiles.push(temp1);
    await resizeAndCropImage(localImage1Path, temp1, halfWidth, deviceHeight);

    // Step 2: Resize second image to fit right half
    const temp2 = await Deno.makeTempFile({ suffix: ".jpg" });
    tempFiles.push(temp2);
    await resizeAndCropImage(localImage2Path, temp2, halfWidth, deviceHeight);

    // Step 3 & 4: Create composite using sharp
    // Load both resized images
    const [img1Buffer, img2Buffer] = await Promise.all([
      sharp(temp1).toBuffer(),
      sharp(temp2).toBuffer()
    ]);

    // Create canvas with background color and composite both images
    await sharp({
      create: {
        width: deviceWidth,
        height: deviceHeight,
        channels: 3,
        background: backgroundColor
      }
    })
    .composite([
      { input: img1Buffer, top: 0, left: 0 },
      { input: img2Buffer, top: 0, left: halfWidth }
    ])
    .jpeg({ quality })
    .toFile(outputPath);

    // Upload to GCS if enabled
    if (isGCSEnabled()) {
      const gcsPath = localPathToGCSPath(outputPath);
      try {
        const gcsUri = await uploadFile(outputPath, gcsPath, "image/jpeg");
        console.log(`Uploaded composite to GCS: ${gcsUri}`);
        // Clean up local file after successful upload
        await Deno.remove(outputPath).catch(() => {});
        return gcsUri;
      } catch (error) {
        console.error(`Failed to upload composite to GCS, keeping local file:`, error);
      }
    }

    return outputPath;
  } finally {
    // Clean up temporary files
    for (const tempFile of tempFiles) {
      await Deno.remove(tempFile).catch(() => {});
    }
  }
}

/**
 * Helper function to resize and crop an image to exact dimensions
 */
async function resizeAndCropImage(
  sourcePath: string,
  outputPath: string,
  width: number,
  height: number
): Promise<void> {
  await sharp(sourcePath)
    .resize(width, height, {
      fit: "cover",
      position: "centre"
    })
    .toFile(outputPath);
}

/**
 * Add a color overlay or border to an image
 * Useful for creating visual harmony with color palettes
 */
export async function addColorOverlay(
  sourcePath: string,
  outputPath: string,
  overlayColor: string,
  opacity: number = 0.1
): Promise<string> {
  await ensureDir(join(outputPath, ".."));

  const command = new Deno.Command("magick", {
    args: [
      sourcePath,
      "-fill",
      overlayColor,
      "-colorize",
      `${Math.round(opacity * 100)}%`,
      outputPath,
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stderr } = await command.output();

  if (code !== 0) {
    const error = new TextDecoder().decode(stderr);
    throw new Error(`Failed to add color overlay: ${error}`);
  }

  // Upload to GCS if enabled
  if (isGCSEnabled()) {
    const gcsPath = localPathToGCSPath(outputPath);
    try {
      const gcsUri = await uploadFile(outputPath, gcsPath, "image/jpeg");
      await Deno.remove(outputPath).catch(() => {});
      return gcsUri;
    } catch (error) {
      console.error(`Failed to upload to GCS:`, error);
    }
  }

  return outputPath;
}
