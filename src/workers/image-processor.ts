/**
 * Web Worker for processing images in the background
 */

import { processImageForDevice, loadConfig } from "../services/image-processing.ts";

self.onmessage = async (e: MessageEvent) => {
  const { imageId, outputDir } = e.data;
  
  try {
    const config = await loadConfig();
    const results = [];
    
    for (const deviceSize of config.deviceSizes) {
      try {
        // Process image: resize for device and extract color palette
        await processImageForDevice(imageId, deviceSize, outputDir);
        results.push({
          deviceSize: deviceSize.name,
          success: true,
        });
        console.log(`✓ Processed ${imageId} for ${deviceSize.name} (resized + color extraction)`);
      } catch (error) {
        results.push({
          deviceSize: deviceSize.name,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        console.error(`✗ Failed to process ${imageId} for ${deviceSize.name}:`, error);
      }
    }
    
    self.postMessage({
      success: true,
      imageId,
      results,
    });
  } catch (error) {
    console.error(`Failed to process image ${imageId}:`, error);
    self.postMessage({
      success: false,
      imageId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  } finally {
    self.close();
  }
};
