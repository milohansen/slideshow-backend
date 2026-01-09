/**
 * Web Worker for processing a single image for a single device size
 * One task per worker for better parallelism
 */

import { processImageForDevice, type DeviceSize } from "../services/image-processing.ts";

self.onmessage = async (e: MessageEvent) => {
  const { imageId, deviceName, deviceWidth, deviceHeight, outputDir } = e.data;
  
  try {
    const deviceSize: DeviceSize = {
      name: deviceName,
      width: deviceWidth,
      height: deviceHeight,
    };
    
    // Process image for this specific device size
    await processImageForDevice(imageId, deviceSize, outputDir);
    
    self.postMessage({
      success: true,
      imageId,
      deviceName,
    });
  } catch (error) {
    console.error(`✗ Failed to process ${imageId} for ${deviceName}:`, error);
    self.postMessage({
      success: false,
      imageId,
      deviceName,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  } finally {
    self.close();
  }
};
