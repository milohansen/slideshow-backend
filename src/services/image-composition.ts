/**
 * Image composition service for later-stage processing with ImageMagick
 * This module handles composite operations like pairing portrait images,
 * adding overlays, and creating combined layouts
 */

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import type { ColorPalette } from "./image-processing.ts";
import { calculatePairedPortraitLayout } from "./image-layout.ts";
import { isGCSEnabled, uploadFile, localPathToGCSPath, downloadFile, parseGCSUri } from "./storage.ts";

export interface CompositeImageOptions {
  outputPath: string;
  deviceWidth: number;
  deviceHeight: number;
  backgroundColor?: string;
  quality?: number;
}

export interface PairedPortraitCompositeOptions extends CompositeImageOptions {
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

    // Step 3: Create a blank canvas with background color
    const canvas = await Deno.makeTempFile({ suffix: ".jpg" });
    tempFiles.push(canvas);
    
    const createCanvasCommand = new Deno.Command("magick", {
      args: [
        "-size",
        `${deviceWidth}x${deviceHeight}`,
        `xc:${backgroundColor}`,
        canvas,
      ],
      stdout: "piped",
      stderr: "piped",
    });

    const canvasResult = await createCanvasCommand.output();
    if (canvasResult.code !== 0) {
      const error = new TextDecoder().decode(canvasResult.stderr);
      throw new Error(`Failed to create canvas: ${error}`);
    }

    // Step 4: Composite both images onto the canvas
    const compositeCommand = new Deno.Command("magick", {
      args: [
        canvas,
        temp1,
        "-geometry",
        `${halfWidth}x${deviceHeight}+0+0`,
        "-composite",
        temp2,
        "-geometry",
        `${halfWidth}x${deviceHeight}+${halfWidth}+0`,
        "-composite",
        "-quality",
        quality.toString(),
        outputPath,
      ],
      stdout: "piped",
      stderr: "piped",
    });

    const compositeResult = await compositeCommand.output();
    if (compositeResult.code !== 0) {
      const error = new TextDecoder().decode(compositeResult.stderr);
      throw new Error(`Failed to composite images: ${error}`);
    }

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
  const command = new Deno.Command("magick", {
    args: [
      sourcePath,
      "-resize",
      `${width}x${height}^`,
      "-gravity",
      "center",
      "-extent",
      `${width}x${height}`,
      outputPath,
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stderr } = await command.output();

  if (code !== 0) {
    const error = new TextDecoder().decode(stderr);
    throw new Error(`Failed to resize and crop image: ${error}`);
  }
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
