/**
 * Image layout service for aspect ratio calculations and layout configurations
 * This module handles aspect ratio detection and layout decisions for both
 * Google Photos downloads and direct uploads
 */

export type AspectRatio = {
  width: number;
  height: number;
  ratio: number;
  orientation: "portrait" | "landscape" | "square";
}

export type LayoutConfiguration = {
  deviceWidth: number;
  deviceHeight: number;
  deviceOrientation: "portrait" | "landscape";
  imageAspectRatio: AspectRatio;
  layoutType: "single" | "paired";
  cropStrategy: "center" | "smart";
}

/**
 * Calculate aspect ratio from dimensions
 */
export function calculateAspectRatio(width: number, height: number): AspectRatio {
  const ratio = width / height;
  let orientation: "portrait" | "landscape" | "square";

  if (Math.abs(ratio - 1) < 0.05) {
    orientation = "square";
  } else if (width > height) {
    orientation = "landscape";
  } else {
    orientation = "portrait";
  }

  return {
    width,
    height,
    ratio,
    orientation,
  };
}

/**
 * Determine if an aspect ratio is close to another (within tolerance)
 */
export function aspectRatioMatches(
  ratio1: number,
  ratio2: number,
  tolerance: number = 0.1
): boolean {
  return Math.abs(ratio1 - ratio2) < tolerance;
}

/**
 * Determine layout configuration for an image on a device
 */
export function determineLayoutConfiguration(
  imageWidth: number,
  imageHeight: number,
  deviceWidth: number,
  deviceHeight: number
): LayoutConfiguration {
  const imageAspectRatio = calculateAspectRatio(imageWidth, imageHeight);
  const deviceAspectRatio = calculateAspectRatio(deviceWidth, deviceHeight);

  // Determine if portrait images should be paired
  const shouldPair = 
    imageAspectRatio.orientation === "portrait" &&
    deviceAspectRatio.orientation === "landscape";

  // Determine device orientation (square devices are treated as landscape)
  let deviceOrientationResult: "portrait" | "landscape";
  if (deviceAspectRatio.orientation === "portrait") {
    deviceOrientationResult = "portrait";
  } else {
    deviceOrientationResult = "landscape"; // includes landscape and square
  }

  return {
    deviceWidth,
    deviceHeight,
    deviceOrientation: deviceOrientationResult,
    imageAspectRatio,
    layoutType: shouldPair ? "paired" : "single",
    cropStrategy: "center", // Default to center crop, can be enhanced with smart cropping later
  };
}

/**
 * Calculate target dimensions for resizing while maintaining aspect ratio
 */
export function calculateTargetDimensions(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  fitMode: "cover" | "contain" = "cover"
): { width: number; height: number } {
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = targetWidth / targetHeight;

  if (fitMode === "cover") {
    // Fill the entire target area, cropping if necessary
    if (sourceRatio > targetRatio) {
      // Source is wider, fit to height
      return {
        width: Math.round(targetHeight * sourceRatio),
        height: targetHeight,
      };
    } else {
      // Source is taller, fit to width
      return {
        width: targetWidth,
        height: Math.round(targetWidth / sourceRatio),
      };
    }
  } else {
    // Contain mode: fit entire image within target, may have letterboxing
    if (sourceRatio > targetRatio) {
      // Source is wider, fit to width
      return {
        width: targetWidth,
        height: Math.round(targetWidth / sourceRatio),
      };
    } else {
      // Source is taller, fit to height
      return {
        width: Math.round(targetHeight * sourceRatio),
        height: targetHeight,
      };
    }
  }
}

/**
 * Determine if two images are compatible for pairing (based on aspect ratios)
 */
export function areImagesCompatibleForPairing(
  image1Width: number,
  image1Height: number,
  image2Width: number,
  image2Height: number,
  tolerance: number = 0.15
): boolean {
  const ratio1 = image1Width / image1Height;
  const ratio2 = image2Width / image2Height;

  // Both should be portrait orientation
  if (ratio1 >= 1 || ratio2 >= 1) {
    return false;
  }

  // Aspect ratios should be similar
  return aspectRatioMatches(ratio1, ratio2, tolerance);
}

/**
 * Calculate layout for paired portrait images on a landscape device
 */
export function calculatePairedPortraitLayout(
  image1Width: number,
  image1Height: number,
  image2Width: number,
  image2Height: number,
  deviceWidth: number,
  deviceHeight: number
): {
  image1: { x: number; y: number; width: number; height: number };
  image2: { x: number; y: number; width: number; height: number };
} {
  // Each image gets half the device width
  const halfWidth = Math.floor(deviceWidth / 2);

  // Calculate dimensions for each image to fill its half
  const dims1 = calculateTargetDimensions(
    image1Width,
    image1Height,
    halfWidth,
    deviceHeight,
    "cover"
  );

  const dims2 = calculateTargetDimensions(
    image2Width,
    image2Height,
    halfWidth,
    deviceHeight,
    "cover"
  );

  return {
    image1: {
      x: 0,
      y: Math.floor((deviceHeight - dims1.height) / 2),
      width: halfWidth,
      height: deviceHeight,
    },
    image2: {
      x: halfWidth,
      y: Math.floor((deviceHeight - dims2.height) / 2),
      width: halfWidth,
      height: deviceHeight,
    },
  };
}

/**
 * Get common aspect ratios for reference
 */
export const COMMON_ASPECT_RATIOS = {
  SQUARE: 1.0,
  PORTRAIT_4_3: 3 / 4,
  PORTRAIT_3_2: 2 / 3,
  PORTRAIT_9_16: 9 / 16,
  LANDSCAPE_16_9: 16 / 9,
  LANDSCAPE_3_2: 3 / 2,
  LANDSCAPE_4_3: 4 / 3,
};

/**
 * Layout slot definition from device configuration
 */
export type LayoutSlot = {
  type: "single" | "pair-vertical" | "pair-horizontal";
  width: number;
  height: number;
  divider?: number;
  preferredAspectRatios?: string[];
  minAspectRatio?: number;
  maxAspectRatio?: number;
};

/**
 * Layout evaluation result with crop calculation
 */
export type LayoutEvaluation = {
  layoutType: "single" | "pair-vertical" | "pair-horizontal";
  width: number;
  height: number;
  cropPercentage: number; // 0-100, lower is better
  isPreferred: boolean; // Matches preferred aspect ratio
};

/**
 * Calculate crop percentage when fitting an image to target dimensions
 * Returns percentage of image area that will be cropped (0-100)
 */
export function calculateCropPercentage(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number
): number {
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = targetWidth / targetHeight;
  
  if (Math.abs(sourceRatio - targetRatio) < 0.001) {
    return 0; // Perfect match, no crop
  }
  
  if (sourceRatio > targetRatio) {
    // Source is wider - will crop width
    // Final height = targetHeight, final width = targetWidth
    // Used width = targetHeight * sourceRatio (before crop)
    const usedWidth = targetHeight * sourceRatio;
    const croppedWidth = usedWidth - targetWidth;
    const cropPercentage = (croppedWidth / usedWidth) * 100;
    return cropPercentage;
  } else {
    // Source is taller - will crop height
    // Final width = targetWidth, final height = targetHeight
    // Used height = targetWidth / sourceRatio (before crop)
    const usedHeight = targetWidth / sourceRatio;
    const croppedHeight = usedHeight - targetHeight;
    const cropPercentage = (croppedHeight / usedHeight) * 100;
    return cropPercentage;
  }
}

/**
 * Evaluate which layouts an image is eligible for and calculate crop percentages
 * Returns layouts sorted by crop percentage (least crop first)
 */
export function evaluateImageForLayouts(
  imageWidth: number,
  imageHeight: number,
  layouts: LayoutSlot[]
): LayoutEvaluation[] {
  const imageAspectRatio = calculateAspectRatio(imageWidth, imageHeight);
  const evaluations: LayoutEvaluation[] = [];
  
  for (const layout of layouts) {
    const cropPercentage = calculateCropPercentage(
      imageWidth,
      imageHeight,
      layout.width,
      layout.height
    );
    
    // Check if image matches preferred aspect ratios
    let isPreferred = false;
    if (layout.preferredAspectRatios) {
      isPreferred = layout.preferredAspectRatios.includes(imageAspectRatio.orientation);
    }
    
    // Check aspect ratio constraints
    let meetsConstraints = true;
    if (layout.minAspectRatio !== undefined && imageAspectRatio.ratio < layout.minAspectRatio) {
      meetsConstraints = false;
    }
    if (layout.maxAspectRatio !== undefined && imageAspectRatio.ratio > layout.maxAspectRatio) {
      meetsConstraints = false;
    }
    
    // Only include layouts that meet constraints
    if (meetsConstraints) {
      evaluations.push({
        layoutType: layout.type,
        width: layout.width,
        height: layout.height,
        cropPercentage,
        isPreferred,
      });
    }
  }
  
  // Sort by crop percentage (least crop first)
  evaluations.sort((a, b) => a.cropPercentage - b.cropPercentage);
  
  return evaluations;
}

/**
 * Select the best layout for an image based on crop minimization
 * Returns the layout with the least crop percentage
 */
export function selectBestLayout(
  imageWidth: number,
  imageHeight: number,
  layouts: LayoutSlot[]
): LayoutEvaluation | null {
  const evaluations = evaluateImageForLayouts(imageWidth, imageHeight, layouts);
  
  if (evaluations.length === 0) {
    return null;
  }
  
  // Return the layout with minimum crop (first in sorted array)
  return evaluations[0];
}
