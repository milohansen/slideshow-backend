## Plan: Build ESPHome Photo Slideshow Backend

Build a containerized backend service to ingest, process, and serve photos to ESPHome devices via REST API. Start with local filesystem images, TypeScript/Hono/Deno stack, SQLite database, and basic slideshow queue generation with multi-screen support and portrait pairing.

### Steps

1. **Initialize Deno/Hono project** — Create [deno.json](deno.json), project structure (src/routes, src/services, src/db), Dockerfile, and .gitignore with basic Hono server setup
2. **Build image ingestion service** — Scan hardcoded local directory, extract metadata (dimensions, orientation), hash for deduplication, and store in SQLite schema (images, processed_images, devices tables)
3. **Implement image processing pipeline** — Use sharp library to resize images for multiple device screen sizes, integrate @material/material-color-utilities to extract full color scheme (primary, secondary, tertiary), use worker threads for parallel background processing, store processed variants with color palette metadata
4. **Create device API endpoints** — Build `/api/devices/{deviceId}/slideshow` to generate shuffled queue, `/api/devices/{deviceId}/images/{imageId}` to serve processed images, handle portrait pairing logic in queue builder using color similarity comparison
5. **Add slideshow queue builder** — Generate infinite shuffled sequences (weighted random without immediate repeats), pair portrait images by comparing color similarity across full palettes (primary, secondary, tertiary), persist queue state per device

### Implementation Decisions

1. **Screen size configuration** — Device dimensions will be stored in a config file (JSON/YAML), since they won't change frequently
2. **Portrait pairing strategy** — Use color similarity by comparing full color palettes (primary, secondary, tertiary colors) to find compatible portrait pairs
3. **Image processing timing** — Background job queue with worker threads to parallelize image processing, non-blocking for large libraries

