#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-ffi --allow-run

/**
 * Example script demonstrating the image processing pipeline
 * This script shows how to:
 * 1. Process uploaded images with consistent pipeline
 * 2. Calculate aspect ratios and layout configurations
 * 3. Create composite images (paired portraits)
 */

import { initDatabase } from "../src/db/schema.ts";
import { 
  processUploadedImage,
  extractImageMetadata
} from "../src/services/image-ingestion.ts";
import {
  calculateAspectRatio,
  determineLayoutConfiguration,
  areImagesCompatibleForPairing,
  calculatePairedPortraitLayout,
  COMMON_ASPECT_RATIOS
} from "../src/services/image-layout.ts";
import {
  composePairedPortraitImages
} from "../src/services/image-composition.ts";

console.log("=== Image Processing Pipeline Examples ===\n");

// Initialize database
await initDatabase();

// Example 1: Calculate aspect ratios
console.log("1. Aspect Ratio Calculations:");
console.log("   Portrait 4:3 image (600x800):");
const portrait = calculateAspectRatio(600, 800);
console.log(`   - Ratio: ${portrait.ratio.toFixed(3)}`);
console.log(`   - Orientation: ${portrait.orientation}`);

console.log("\n   Landscape 16:9 image (1920x1080):");
const landscape = calculateAspectRatio(1920, 1080);
console.log(`   - Ratio: ${landscape.ratio.toFixed(3)}`);
console.log(`   - Orientation: ${landscape.orientation}`);

console.log("\n   Square image (1000x1000):");
const square = calculateAspectRatio(1000, 1000);
console.log(`   - Ratio: ${square.ratio.toFixed(3)}`);
console.log(`   - Orientation: ${square.orientation}`);

// Example 2: Layout determination
console.log("\n2. Layout Configuration:");
console.log("   Portrait image on landscape device:");
const layoutConfig = determineLayoutConfiguration(
  600, 800,    // Portrait image
  1024, 600    // Landscape device
);
console.log(`   - Layout type: ${layoutConfig.layoutType}`);
console.log(`   - Device orientation: ${layoutConfig.deviceOrientation}`);
console.log(`   - Image orientation: ${layoutConfig.imageAspectRatio.orientation}`);
console.log(`   - Crop strategy: ${layoutConfig.cropStrategy}`);

// Example 3: Check if images are compatible for pairing
console.log("\n3. Portrait Pairing Compatibility:");
const portrait1 = { width: 600, height: 800 };
const portrait2 = { width: 640, height: 960 };
const compatible = areImagesCompatibleForPairing(
  portrait1.width, portrait1.height,
  portrait2.width, portrait2.height
);
console.log(`   Portrait 600x800 + Portrait 640x960: ${compatible ? "Compatible" : "Not compatible"}`);

// Example 4: Calculate paired portrait layout
console.log("\n4. Paired Portrait Layout:");
const layout = calculatePairedPortraitLayout(
  600, 800,    // Image 1
  640, 960,    // Image 2
  1024, 600    // Device dimensions
);
console.log("   Image 1 position:");
console.log(`   - X: ${layout.image1.x}, Y: ${layout.image1.y}`);
console.log(`   - Width: ${layout.image1.width}, Height: ${layout.image1.height}`);
console.log("   Image 2 position:");
console.log(`   - X: ${layout.image2.x}, Y: ${layout.image2.y}`);
console.log(`   - Width: ${layout.image2.width}, Height: ${layout.image2.height}`);

// Example 5: Common aspect ratios reference
console.log("\n5. Common Aspect Ratios Reference:");
console.log(`   - Square: ${COMMON_ASPECT_RATIOS.SQUARE}`);
console.log(`   - Portrait 9:16: ${COMMON_ASPECT_RATIOS.PORTRAIT_9_16.toFixed(3)}`);
console.log(`   - Landscape 16:9: ${COMMON_ASPECT_RATIOS.LANDSCAPE_16_9.toFixed(3)}`);

// Example 6: Process a test image (if available)
const testImagePath = "data/test-images/portrait1.jpg";
try {
  const stat = await Deno.stat(testImagePath);
  if (stat.isFile) {
    console.log("\n6. Processing Test Image:");
    console.log(`   Processing: ${testImagePath}`);
    
    const metadata = await extractImageMetadata(testImagePath);
    console.log(`   - Dimensions: ${metadata.width}x${metadata.height}`);
    console.log(`   - Orientation: ${metadata.orientation}`);
    console.log(`   - Aspect Ratio: ${(metadata.width / metadata.height).toFixed(3)}`);
    
    // Demonstrate the consistent pipeline
    console.log("\n   Using processUploadedImage pipeline:");
    const result = await processUploadedImage(testImagePath);
    console.log(`   - Status: ${result.status}`);
    if (result.status === "success") {
      console.log(`   - Image ID: ${result.imageId}`);
      console.log(`   - Queued for processing: Yes`);
    } else if (result.reason) {
      console.log(`   - Reason: ${result.reason}`);
    }
  }
} catch (error) {
  console.log("\n6. Test Image Processing:");
  console.log(`   (Skipped - test image not found: ${testImagePath})`);
}

console.log("\n=== Examples Complete ===");
console.log("\nTo create a composite paired portrait image:");
console.log("  import { composePairedPortraitImages } from '../src/services/image-composition.ts';");
console.log("  await composePairedPortraitImages({");
console.log("    image1Path: 'path/to/portrait1.jpg',");
console.log("    image1Width: 600, image1Height: 800,");
console.log("    image2Path: 'path/to/portrait2.jpg',");
console.log("    image2Width: 640, image2Height: 960,");
console.log("    outputPath: 'output/paired.jpg',");
console.log("    deviceWidth: 1024, deviceHeight: 600");
console.log("  });");
