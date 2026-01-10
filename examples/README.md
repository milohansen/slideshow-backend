# Image Processing Pipeline Examples

This directory contains example scripts demonstrating the image processing pipeline.

## Running the Examples

### Image Processing Demo

This example demonstrates:
- Aspect ratio calculations
- Layout configuration determination
- Portrait pairing compatibility checks
- Paired portrait layout calculations
- Processing uploaded images with the consistent pipeline

```bash
deno run --allow-read --allow-write --allow-env --allow-ffi --allow-run examples/image-processing-demo.ts
```

## What the Examples Show

### 1. Aspect Ratio Calculations
See how different image dimensions are classified as portrait, landscape, or square.

### 2. Layout Configuration
Understand how the system determines whether an image should be displayed as a single image or paired with another.

### 3. Portrait Pairing Compatibility
Learn how the system checks if two portrait images have compatible aspect ratios for pairing.

### 4. Paired Portrait Layout
See how the system calculates exact positioning for two portrait images on a landscape device.

### 5. Common Aspect Ratios
Reference common aspect ratios used in photography and device screens.

### 6. Process Test Images
If test images are available, see the full pipeline in action.

## Creating Composite Images

The examples show how to use the composition functions to:
- Pair two portrait images side-by-side for landscape devices
- Add color overlays for visual harmony
- Blend images for transitions
- Apply vignette effects

See the example output for code snippets you can use in your own scripts.
