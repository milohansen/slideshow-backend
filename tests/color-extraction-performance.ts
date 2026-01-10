/**
 * Performance test for color extraction using Material Color Utilities
 * Tests on real images at various resolutions to compare performance and color accuracy
 */

import { extractColors } from "../src/services/image-processing.ts";
import { walk } from "@std/fs";

const TEST_IMAGE_DIR = "/mnt/g/Photos/Exports/2025/12";
const MAX_IMAGES = 10; // Limit to first 10 images (will test multiple resolutions per image)
const TEST_RESOLUTIONS = [0, 3000, 2000, 1500, 1000, 500]; // 0 = no resize

interface ResolutionTest {
  resolution: number;
  extractionTime: number;
  colors: string[];
  pixelCount: number;
  error?: string;
}

interface TestResult {
  filename: string;
  fileSize: number;
  dimensions: { width: number; height: number };
  resolutionTests: ResolutionTest[];
}

/**
 * Get image dimensions using ImageMagick
 */
async function getImageDimensions(imagePath: string): Promise<{ width: number; height: number } | null> {
  try {
    const command = new Deno.Command("magick", {
      args: ["identify", "-format", "%w %h", imagePath],
      stdout: "piped",
      stderr: "piped",
    });

    const { code, stdout } = await command.output();
    if (code !== 0) return null;

    const output = new TextDecoder().decode(stdout).trim();
    const [width, height] = output.split(" ").map(Number);
    return { width, height };
  } catch {
    return null;
  }
}

/**
 * Calculate actual dimensions after resize operation
 */
function calculateResizedDimensions(
  originalWidth: number,
  originalHeight: number,
  maxResolution: number
): { width: number; height: number } {
  if (maxResolution === 0 || (originalWidth <= maxResolution && originalHeight <= maxResolution)) {
    return { width: originalWidth, height: originalHeight };
  }

  const aspectRatio = originalWidth / originalHeight;
  if (originalWidth > originalHeight) {
    return {
      width: maxResolution,
      height: Math.round(maxResolution / aspectRatio)
    };
  } else {
    return {
      width: Math.round(maxResolution * aspectRatio),
      height: maxResolution
    };
  }
}

/**
 * Format time in milliseconds with color coding
 */
function formatTime(ms: number): string {
  if (ms < 100) return `\x1b[32m${ms.toFixed(0)}ms\x1b[0m`; // Green: fast
  if (ms < 500) return `\x1b[33m${ms.toFixed(0)}ms\x1b[0m`; // Yellow: medium
  return `\x1b[31m${ms.toFixed(0)}ms\x1b[0m`; // Red: slow
}

/**
 * Format file size
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Display colors as colored blocks in terminal
 */
function displayColors(colors: string[], limit = 3): string {
  return colors.slice(0, limit).map(color => {
    // Convert hex to RGB for terminal color
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `\x1b[48;2;${r};${g};${b}m  \x1b[0m ${color}`;
  }).join(" ");
}

/**
 * Compare two color arrays and check if they're similar
 */
function colorsAreSimilar(colors1: string[], colors2: string[]): boolean {
  if (colors1.length !== colors2.length) return false;
  
  // Check if first 3 colors match (primary, secondary, tertiary)
  for (let i = 0; i < Math.min(3, colors1.length); i++) {
    if (colors1[i] !== colors2[i]) return false;
  }
  return true;
}

/**
 * Format resolution for display
 */
function formatResolution(resolution: number, width: number, height: number): string {
  if (resolution === 0) {
    return `Original (${width}x${height})`;
  }
  return `${resolution}px (${width}x${height})`;
}

/**
 * Run performance tests
 */
async function runTests() {
  console.log("🎨 Color Extraction Performance Test - Resolution Comparison");
  console.log("=============================================================\n");
  console.log(`Test directory: ${TEST_IMAGE_DIR}`);
  console.log(`Test images: ${MAX_IMAGES}`);
  console.log(`Test resolutions: ${TEST_RESOLUTIONS.map(r => r === 0 ? 'Original' : `${r}px`).join(', ')}\n`);

  const results: TestResult[] = [];
  let imageCount = 0;

  // Find image files
  console.log("Scanning for images...\n");
  
  try {
    for await (const entry of walk(TEST_IMAGE_DIR, { maxDepth: 1 })) {
      if (imageCount >= MAX_IMAGES) break;
      
      if (entry.isFile) {
        const ext = entry.path.toLowerCase().split(".").pop();
        if (!["jpg", "jpeg", "png", "webp"].includes(ext || "")) continue;

        imageCount++;
        const filename = entry.name;
        
        console.log(`\n[${imageCount}/${MAX_IMAGES}] Testing: ${filename}`);
        console.log("─".repeat(60));

        try {
          // Get file size
          const stat = await Deno.stat(entry.path);
          const fileSize = stat.size;

          // Get dimensions
          const dimensions = await getImageDimensions(entry.path);
          if (!dimensions) {
            console.log("⚠️  Could not determine image dimensions");
            continue;
          }

          console.log(`📏 Size: ${formatSize(fileSize)} | Original: ${dimensions.width}x${dimensions.height}\n`);

          const resolutionTests: ResolutionTest[] = [];

          // Test each resolution
          for (const resolution of TEST_RESOLUTIONS) {
            const resizedDims = calculateResizedDimensions(dimensions.width, dimensions.height, resolution);
            const pixelCount = resizedDims.width * resizedDims.height;
            
            try {
              const startTime = performance.now();
              const colors = await extractColors(entry.path, 8, resolution);
              const endTime = performance.now();
              const extractionTime = endTime - startTime;

              resolutionTests.push({
                resolution,
                extractionTime,
                colors,
                pixelCount,
              });

              const resLabel = formatResolution(resolution, resizedDims.width, resizedDims.height).padEnd(25);
              console.log(`   ${resLabel} | ${formatTime(extractionTime).padEnd(20)} | ${displayColors(colors)}`);
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : String(error);
              resolutionTests.push({
                resolution,
                extractionTime: 0,
                colors: [],
                pixelCount,
                error: errorMsg,
              });
              console.log(`   ${formatResolution(resolution, resizedDims.width, resizedDims.height)} | ❌ Error: ${errorMsg}`);
            }
          }

          // Compare colors across resolutions
          console.log();
          const baselineColors = resolutionTests[0]?.colors || [];
          let allSimilar = true;
          for (let i = 1; i < resolutionTests.length; i++) {
            if (!colorsAreSimilar(baselineColors, resolutionTests[i].colors)) {
              allSimilar = false;
              break;
            }
          }
          
          if (allSimilar) {
            console.log(`   ✅ Color consistency: All resolutions produced identical primary colors`);
          } else {
            console.log(`   ⚠️  Color consistency: Different colors at different resolutions`);
          }

          results.push({
            filename,
            fileSize,
            dimensions,
            resolutionTests,
          });

        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.log(`❌ Error: ${errorMsg}`);
        }
      }
    }
  } catch (error) {
    console.error(`\n❌ Error accessing directory: ${error}`);
    console.error("Please ensure the directory exists and is accessible.");
    Deno.exit(1);
  }

  // Summary statistics
  console.log("\n\n📊 Summary Statistics - Performance by Resolution");
  console.log("=================================================\n");

  if (results.length === 0) {
    console.log("❌ No tests completed");
    return;
  }

  // Analyze by resolution
  for (const resolution of TEST_RESOLUTIONS) {
    const resolutionData = results.flatMap(r => 
      r.resolutionTests.filter(rt => rt.resolution === resolution && !rt.error)
    );

    if (resolutionData.length === 0) continue;

    const times = resolutionData.map(rt => rt.extractionTime);
    const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const avgPixels = resolutionData.reduce((a, b) => a + b.pixelCount, 0) / resolutionData.length;
    const avgMegapixels = avgPixels / 1_000_000;

    const resLabel = resolution === 0 ? "Original (no resize)" : `${resolution}px max`;
    console.log(`📐 ${resLabel}`);
    console.log(`   Avg time: ${formatTime(avgTime)} | Min: ${formatTime(minTime)} | Max: ${formatTime(maxTime)}`);
    console.log(`   Avg resolution: ${avgMegapixels.toFixed(2)}MP`);
    console.log();
  }

  // Color consistency analysis
  console.log("\n🎨 Color Consistency Analysis");
  console.log("==============================\n");
  
  let consistentCount = 0;
  let inconsistentCount = 0;

  for (const result of results) {
    const validTests = result.resolutionTests.filter(rt => !rt.error && rt.colors.length > 0);
    if (validTests.length < 2) continue;

    const baselineColors = validTests[0].colors;
    let isConsistent = true;

    for (let i = 1; i < validTests.length; i++) {
      if (!colorsAreSimilar(baselineColors, validTests[i].colors)) {
        isConsistent = false;
        break;
      }
    }

    if (isConsistent) {
      consistentCount++;
    } else {
      inconsistentCount++;
    }
  }

  const totalTested = consistentCount + inconsistentCount;
  if (totalTested > 0) {
    const consistencyRate = (consistentCount / totalTested * 100).toFixed(0);
    console.log(`✅ Consistent colors: ${consistentCount}/${totalTested} (${consistencyRate}%)`);
    console.log(`⚠️  Inconsistent colors: ${inconsistentCount}/${totalTested}`);
    
    if (inconsistentCount > 0) {
      console.log(`\n⚠️  Images with different colors at different resolutions:`);
      for (const result of results) {
        const validTests = result.resolutionTests.filter(rt => !rt.error && rt.colors.length > 0);
        if (validTests.length < 2) continue;

        const baselineColors = validTests[0].colors;
        let isConsistent = true;

        for (let i = 1; i < validTests.length; i++) {
          if (!colorsAreSimilar(baselineColors, validTests[i].colors)) {
            isConsistent = false;
            break;
          }
        }

        if (!isConsistent) {
          console.log(`   - ${result.filename}`);
        }
      }
    }
  }

  // Recommendation
  console.log("\n\n💡 Recommendation");
  console.log("==================\n");
  
  const allResolutionData: Array<{resolution: number; avgTime: number; avgMP: number}> = [];
  for (const resolution of TEST_RESOLUTIONS) {
    const resolutionData = results.flatMap(r => 
      r.resolutionTests.filter(rt => rt.resolution === resolution && !rt.error)
    );
    if (resolutionData.length === 0) continue;
    
    const avgTime = resolutionData.reduce((a, b) => a + b.extractionTime, 0) / resolutionData.length;
    const avgPixels = resolutionData.reduce((a, b) => a + b.pixelCount, 0) / resolutionData.length;
    allResolutionData.push({ resolution, avgTime, avgMP: avgPixels / 1_000_000 });
  }

  if (allResolutionData.length >= 2) {
    const consistencyRate = totalTested > 0 ? (consistentCount / totalTested * 100) : 100;
    
    if (consistencyRate >= 80) {
      console.log(`✅ Current setting (2000px) appears optimal:`);
      console.log(`   - ${consistencyRate.toFixed(0)}% color consistency across resolutions`);
      console.log(`   - Reasonable performance`);
      console.log(`   - Good quality color extraction`);
    } else {
      console.log(`⚠️  Consider testing with larger resolution threshold:`);
      console.log(`   - Only ${consistencyRate.toFixed(0)}% color consistency`);
      console.log(`   - Colors vary significantly at different resolutions`);
      console.log(`   - May need higher resolution for accurate extraction`);
    }
  }

  console.log("\n✅ Test complete!\n");
}

// Run the tests
if (import.meta.main) {
  runTests();
}
