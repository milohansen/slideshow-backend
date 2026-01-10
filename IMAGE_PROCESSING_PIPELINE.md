# Image Processing Pipeline Architecture

This document describes the image processing pipeline implementation for both Google Photos downloads and direct uploads.

## Overview

The image processing system is divided into three main stages:

1. **Initial Processing** - Image ingestion and metadata extraction
2. **Device Processing** - Resizing and color extraction for specific devices
3. **Composition Processing** - Advanced operations like pairing and overlays

## Pipeline Structure

### Initial Processing Pipeline

Both Google Photos and direct uploads follow a consistent 6-step pipeline:

#### For Direct Uploads (`processUploadedImage`)

1. **Extract Metadata** - Extract dimensions, hash, and orientation from the uploaded file
2. **Check Duplicates** - Use file hash to detect duplicates
3. **Store Metadata** - Save image metadata to the database
4. **Queue Processing** - Add image to the processing queue for device-specific operations

#### For Google Photos (`processGooglePhotosImage`)

1. **Download Image** - Download the image from Google Photos API
2. **Extract Metadata** - Calculate hash for duplicate detection
3. **Check Duplicates** - Use file hash to detect duplicates
4. **Extract Full Metadata** - Get dimensions and orientation from Google Photos metadata
5. **Store Metadata** - Save image metadata to the database (with GCS upload if enabled)
6. **Queue Processing** - Add image to the processing queue for device-specific operations

### Function Naming Convention

To maximize code clarity and maintain structural similarity:

- `processUploadedImage()` - Initial pipeline for direct uploads
- `processGooglePhotosImage()` - Initial pipeline for Google Photos downloads
- Both return `InitialProcessingResult` with consistent structure

## Aspect Ratio and Layout System

The `image-layout.ts` module provides aspect ratio calculations and layout configurations:

### Key Functions

- `calculateAspectRatio(width, height)` - Calculate aspect ratio and orientation
- `determineLayoutConfiguration(imageWidth, imageHeight, deviceWidth, deviceHeight)` - Determine if an image should be displayed single or paired
- `calculateTargetDimensions(sourceWidth, sourceHeight, targetWidth, targetHeight, fitMode)` - Calculate resize dimensions
- `areImagesCompatibleForPairing(image1Width, image1Height, image2Width, image2Height)` - Check if two portrait images can be paired
- `calculatePairedPortraitLayout(...)` - Calculate exact positioning for paired portrait images

### Layout Types

- **Single** - One image fills the entire device screen
- **Paired** - Two portrait images displayed side-by-side on a landscape device

### Common Aspect Ratios

The module includes common aspect ratio constants:
- Square: 1:1
- Portrait: 4:3, 3:2, 9:16
- Landscape: 16:9, 3:2, 4:3

## Image Composition

The `image-composition.ts` module handles later-stage processing with ImageMagick composite operations:

### Key Functions

- `composePairedPortraitImages(options)` - Combine two portrait images side-by-side
- `addColorOverlay(sourcePath, outputPath, overlayColor, opacity)` - Add a color tint

### Composite Pipeline

The composite operations use ImageMagick's `-composite` operator:

1. Download images from GCS if needed
2. Resize individual images to target dimensions
3. Create a blank canvas
4. Composite images onto canvas with precise positioning
5. Upload final composite to GCS if enabled
6. Clean up temporary files

## Processing Flow

```
Upload/Google Photos
    ↓
Initial Processing (image-ingestion.ts)
    ├─ Extract metadata
    ├─ Check duplicates
    └─ Store in database
    ↓
Device Processing (image-processing.ts)
    ├─ Resize for device dimensions
    ├─ Extract color palette
    └─ Store processed image
    ↓
Composition (image-composition.ts) - Optional
    ├─ Pair portrait images
    ├─ Apply effects
    └─ Generate final display image
```

## Key Design Decisions

1. **Consistent Function Names** - Both pipelines use `process*Image()` naming
2. **Shared Return Type** - `InitialProcessingResult` used by both pipelines
3. **Separation of Concerns** - Layout logic separate from composition logic
4. **GCS Integration** - Automatic upload and cleanup when cloud storage is enabled
5. **Aspect Ratio Awareness** - Layout decisions based on image and device aspect ratios

## Future Enhancements

- Smart cropping based on content analysis
- Automatic color harmony adjustments for paired images
- Machine learning for optimal image pairing
- Advanced transition effects between slideshow images
