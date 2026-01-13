# Implementation Summary: Image Processing Pipelines

## Overview

This implementation adds comprehensive image processing pipeline infrastructure with consistent structure for both Google Photos downloads and direct uploads, aspect ratio handling, layout configurations, and ImageMagick composite operations.

## What Was Implemented

### 1. Image Layout Service (`src/services/image-layout.ts`)

**Purpose**: Handles aspect ratio calculations and layout configuration decisions.

**Key Features**:
- **Aspect ratio calculation** with orientation detection (portrait/landscape/square)
- **Layout configuration determination** - decides if images should be displayed single or paired
- **Target dimension calculations** for resizing with "cover" or "contain" modes
- **Portrait pairing compatibility checks** based on aspect ratio similarity
- **Paired portrait layout calculations** for side-by-side positioning
- **Common aspect ratio constants** for reference

**Main Functions**:
- `calculateAspectRatio(width, height)` - Calculate ratio and orientation
- `determineLayoutConfiguration(imageW, imageH, deviceW, deviceH)` - Determine single vs paired layout
- `calculateTargetDimensions(sourceW, sourceH, targetW, targetH, fitMode)` - Calculate resize dimensions
- `areImagesCompatibleForPairing(img1W, img1H, img2W, img2H)` - Check pairing compatibility
- `calculatePairedPortraitLayout(img1, img2, device)` - Calculate exact positioning

### 2. Image Composition Service (`src/services/image-composition.ts`)

**Purpose**: Handles later-stage processing with ImageMagick composite operations.

**Key Features**:
- **Paired portrait compositing** - Combine two portrait images side-by-side
- **Color overlay application** - Add tints for visual harmony
- **Image blending** - Create smooth transitions
- **Vignette effects** - Add artistic edge darkening
- **GCS integration** - Automatic upload and cleanup
- **Temporary file management** - Proper cleanup of intermediate files

**Main Functions**:
- `composePairedPortraitImages(options)` - Create side-by-side portrait pair
- `addColorOverlay(source, output, color, opacity)` - Apply color tint

### 3. Consistent Pipeline Structure (`src/services/image-ingestion.ts`)

**Purpose**: Provide structurally similar pipelines for both Google Photos and uploads.

**New Functions**:
- `processUploadedImage(filePath)` - 4-step pipeline for direct uploads
  1. Extract metadata (dimensions, hash, orientation)
  2. Check for duplicates
  3. Store metadata in database
  4. Queue for device processing

- `processGooglePhotosImage(accessToken, mediaItem, tempDir)` - 6-step pipeline for Google Photos
  1. Download image from Google Photos
  2. Extract metadata and calculate hash
  3. Check for duplicates
  4. Extract full metadata from API
  5. Store in database (with GCS upload if enabled)
  6. Queue for device processing

**Consistent Return Type**:
```typescript
type InitialProcessingResult = {
  imageId: string;
  metadata: ImageMetadata;
  status: "success" | "skipped" | "failed";
  reason?: string;
}
```

### 4. Layout-Aware Processing (`src/services/image-processing.ts`)

**Enhancements**:
- Import and use `determineLayoutConfiguration` from image-layout service
- Add `layoutType` and `layoutConfiguration` to `ProcessedImageData` interface
- Log layout decisions during processing
- Add `getPortraitImagesForPairing()` helper function

**Key Changes**:
- `processImageForDevice()` now determines and stores layout configuration
- Returns layout information with processed image data
- New function to query portrait images that need pairing

### 5. Documentation

**Architecture Documentation** (`IMAGE_PROCESSING_PIPELINE.md`):
- Complete pipeline architecture overview
- Function naming conventions
- Processing flow diagrams
- Design decisions and rationale

**Example Script** (`examples/image-processing-demo.ts`):
- Demonstrates all key functions
- Shows aspect ratio calculations
- Illustrates layout determination
- Tests pairing compatibility
- Processes sample images

**README Updates**:
- Added examples section
- Updated project structure
- Added reference to architecture documentation

## Design Principles

1. **Structural Similarity**: Both Google Photos and upload pipelines follow similar steps with consistent function naming (`process*Image`)

2. **Separation of Concerns**: 
   - Initial processing (ingestion) → `image-ingestion.ts`
   - Device-specific processing → `image-processing.ts`
   - Layout calculations → `image-layout.ts`
   - Composite operations → `image-composition.ts`

3. **Aspect Ratio Awareness**: All processing decisions consider image and device aspect ratios

4. **Consistent Return Types**: Both pipelines return `InitialProcessingResult` for predictable handling

5. **Function Clarity**: Clear, descriptive function names that match between pipelines

## Integration Points

The new services integrate with existing code:

1. **Database**: Layout information ready to be stored (interface updated, DB schema can be extended if needed)

2. **Worker Queue**: Existing queue system continues to work, now with layout awareness

3. **Slideshow Queue**: Can use `getPortraitImagesForPairing()` to find images that need pairing

4. **Storage**: Full GCS integration for both local and cloud deployments

## Usage Example

```typescript
// Process an uploaded image
import { processUploadedImage } from './src/services/image-ingestion.ts';

const result = await processUploadedImage('/path/to/image.jpg');
if (result.status === 'success') {
  console.log(`Image ${result.imageId} queued for processing`);
}

// Create paired portrait composite
import { composePairedPortraitImages } from './src/services/image-composition.ts';

await composePairedPortraitImages({
  image1Path: 'portrait1.jpg',
  image1Width: 600, image1Height: 800,
  image2Path: 'portrait2.jpg', 
  image2Width: 640, image2Height: 960,
  outputPath: 'output/paired.jpg',
  deviceWidth: 1024, deviceHeight: 600
});
```

## Testing

Run the example script to see the implementation in action:

```bash
deno run --allow-read --allow-write --allow-env --allow-ffi --allow-run examples/image-processing-demo.ts
```

## Future Enhancements

The implementation is designed to support future enhancements:

- Smart cropping based on content analysis
- Automatic color harmony for paired images
- ML-based optimal pairing
- Advanced transition effects
- More composite operations

## Files Changed

1. **New Files**:
   - `src/services/image-layout.ts` (216 lines)
   - `src/services/image-composition.ts` (357 lines)
   - `IMAGE_PROCESSING_PIPELINE.md` (164 lines)
   - `examples/image-processing-demo.ts` (153 lines)
   - `examples/README.md` (52 lines)

2. **Modified Files**:
   - `src/services/image-ingestion.ts` (+209 lines)
   - `src/services/image-processing.ts` (+49 lines)
   - `README.md` (+13 lines)

## Total Impact

- **~1,200 lines of new code**
- **4 new service modules**
- **2 new pipeline functions with consistent structure**
- **Comprehensive documentation**
- **Working examples**

All changes maintain backward compatibility with existing functionality while adding new capabilities.
