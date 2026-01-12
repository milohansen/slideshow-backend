/**
 * Color extraction utilities using Material Color Utilities
 * This file contains ONLY color extraction logic, no image resizing
 * Image preparation (resizing for color extraction) happens in the processor
 */

import { QuantizerCelebi, Score, argbFromRgb } from "@material/material-color-utilities";

export interface ColorPalette {
  primary: string;
  secondary: string;
  tertiary: string;
  sourceColor: string;
  allColors: string[];
}

/**
 * Extract colors from RGBA pixel data
 * Expects pre-resized image data (e.g., from processor's Sharp instance)
 * 
 * @param pixelData - RGBA pixel data (Uint8Array)
 * @param width - Image width
 * @param height - Image height
 * @param numColors - Number of colors to extract (default: 8)
 * @returns Array of hex color strings
 */
export function extractColorsFromPixels(
  pixelData: Uint8Array,
  width: number,
  height: number,
  numColors = 8
): string[] {
  // Convert RGBA bytes to ARGB integers
  const pixels: number[] = [];
  
  for (let i = 0; i < pixelData.length; i += 4) {
    const r = pixelData[i];
    const g = pixelData[i + 1];
    const b = pixelData[i + 2];
    const a = pixelData[i + 3];

    // Skip fully transparent pixels
    if (a < 255) {
      continue;
    }

    const argb = argbFromRgb(r, g, b);
    pixels.push(argb);
  }

  if (pixels.length === 0) {
    console.warn("No valid pixels found in image, returning fallback color");
    return ["#4285F4"]; // Google Blue fallback
  }

  // Quantize to get color histogram
  const quantized = QuantizerCelebi.quantize(pixels, 128);

  // Score colors using Material Design principles
  const rankedColors = Score.score(quantized, {
    desired: numColors,
    filter: true, // Filter out unsuitable colors
    fallbackColorARGB: 0xff4285f4, // Google Blue as fallback
  });

  // Convert ARGB integers to hex strings
  const colors: string[] = [];
  for (const argb of rankedColors) {
    const hex = "#" + (argb & 0xffffff).toString(16).padStart(6, "0").toUpperCase();
    colors.push(hex);
  }

  // Ensure we always return at least numColors
  while (colors.length < numColors && colors.length > 0) {
    colors.push(colors[0]); // Duplicate primary color as fallback
  }

  return colors;
}

/**
 * Convert extracted colors to ColorPalette structure
 */
export function createColorPalette(colors: string[]): ColorPalette {
  return {
    primary: colors[0] || "#4285F4",
    secondary: colors[1] || colors[0] || "#34A853",
    tertiary: colors[2] || colors[0] || "#FBBC04",
    sourceColor: colors[0] || "#4285F4",
    allColors: colors,
  };
}

/**
 * Calculate color similarity (0-1, where 1 is identical)
 * Uses Euclidean distance in RGB space
 */
export function calculateColorSimilarity(color1: string, color2: string): number {
  const rgb1 = hexToRgb(color1);
  const rgb2 = hexToRgb(color2);

  if (!rgb1 || !rgb2) {
    return 0;
  }

  // Euclidean distance in RGB space
  const distance = Math.sqrt(
    Math.pow(rgb1.r - rgb2.r, 2) +
    Math.pow(rgb1.g - rgb2.g, 2) +
    Math.pow(rgb1.b - rgb2.b, 2)
  );

  // Normalize to 0-1 (max distance is ~441)
  return 1 - distance / 441;
}

/**
 * Calculate palette similarity between two color palettes
 */
export function calculatePaletteSimilarity(palette1: ColorPalette, palette2: ColorPalette): number {
  const primarySim = calculateColorSimilarity(palette1.primary, palette2.primary);
  const secondarySim = calculateColorSimilarity(palette1.secondary, palette2.secondary);
  const tertiarySim = calculateColorSimilarity(palette1.tertiary, palette2.tertiary);

  // Weighted average (primary is most important)
  return primarySim * 0.5 + secondarySim * 0.3 + tertiarySim * 0.2;
}

/**
 * Convert hex color to RGB object
 */
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
 * Convert RGB to hex
 */
export function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map(x => {
    const hex = Math.round(x).toString(16);
    return hex.length === 1 ? "0" + hex : hex;
  }).join("").toUpperCase();
}
