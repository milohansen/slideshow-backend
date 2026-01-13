import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";
import type { DeviceVariant } from "../db/types.ts";

type ImageData = {
  id: string;
  file_path: string;
  width: number;
  height: number;
  orientation: string;
  processingStatus: string;
  processingError: string | null;
  variants: DeviceVariant[];
  colors: {
    primary: string;
    secondary: string;
    tertiary: string;
  } | null;
};

type ImageProps = {
  image: ImageData;
  error?: string;
};

export const Image: FC<ImageProps> = ({ image, error }) => {
  const variantCount = image.variants.length;
  const deviceCount = new Set(image.variants.map((v) => v.device)).size;

  const variantsByDevice = image.variants.reduce((acc, v) => {
    if (!acc[v.device]) acc[v.device] = [];
    acc[v.device].push(v);
    return acc;
  }, {} as Record<string, DeviceVariant[]>);
  return (
    <Layout title="Images">
      {error && (
        <div style="background-color: #fee; border: 1px solid #f88; border-radius: 4px; padding: 1rem; margin-bottom: 1rem; color: #c33;">
          <strong>Error:</strong> {error}
        </div>
      )}
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem;">
        <h1 style="margin-bottom: 0;">Image Details</h1>
        <a href="/images" class="btn">
          ← Back to Images
        </a>
      </div>

      <div class="card">
        <table>
          <thead>
            <tr>
              <th>Thumbnail</th>
              {/* <th>File Path</th> */}
              <th>Dimensions</th>
              <th>Orientation</th>
              <th>Processing Status</th>
              <th>Color Palette</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td title={image.id}>
                <img
                  src={`/thumbnails/${image.id}`}
                  alt={image.file_path.split("/").pop()}
                  style="width: 80px; height: 80px; object-fit: cover; border-radius: 4px;"
                  onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
                />
                <div style="width: 80px; height: 80px; background: #f0f0f0; border-radius: 4px; display: none; align-items: center; justify-content: center; font-size: 0.75rem; color: #999;">
                  No thumb
                </div>
              </td>
              <td>
                {image.width} × {image.height}
              </td>
              <td>
                <span class={`badge badge-${image.orientation}`}>{image.orientation}</span>
              </td>
              <td>
                {image.processingStatus === "complete" ? (
                  <span class="badge" style="background-color: #22c55e; color: white;">
                    ✓ Complete ({variantCount}/{deviceCount})
                  </span>
                ) : image.processingStatus === "failed" ? (
                  <div style="display: flex; gap: 0.5rem; align-items: center;">
                    <span class="badge" style="background-color: #ef4444; color: white; cursor: help;" title={image.processingError || "Processing failed"}>
                      ✗ Failed
                    </span>
                    <form method="post" action={`/images/${image.id}/retry`} style="margin: 0;">
                      <button
                        type="submit"
                        class="btn-small"
                        style="padding: 0.25rem 0.5rem; font-size: 0.85rem; background-color: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer;"
                      >
                        ⟳ Retry
                      </button>
                    </form>
                  </div>
                ) : image.processingStatus === "processing" ? (
                  <span class="badge" style="background-color: #3b82f6; color: white;">
                    ⟳ Processing ({variantCount}/{deviceCount})
                  </span>
                ) : (
                  <span class="badge" style="background-color: #94a3b8; color: white;">
                    ○ Pending
                  </span>
                )}
              </td>
              <td>
                {image.colors ? (
                  <div class="color-palette">
                    <span class="color-swatch" style={`background-color: ${image.colors.primary}`} title={`Primary: ${image.colors.primary}`}></span>
                    <span class="color-swatch" style={`background-color: ${image.colors.secondary}`} title={`Secondary: ${image.colors.secondary}`}></span>
                    <span class="color-swatch" style={`background-color: ${image.colors.tertiary}`} title={`Tertiary: ${image.colors.tertiary}`}></span>
                  </div>
                ) : (
                  <span style="color: #999;">Not processed yet</span>
                )}
              </td>
              <td>
                <button
                  class="delete-image-btn btn-small"
                  data-image-id={image.id}
                  style="padding: 0.25rem 0.5rem; font-size: 0.85rem; background-color: #ef4444; color: white; border: none; border-radius: 4px; cursor: pointer;"
                  title="Delete this image"
                >
                  🗑️
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {Object.entries(variantsByDevice).map(([device, variants]) => (
        <div class="card">
          <h2>Variants for {device} ({variants.length})</h2>
          <div style="display: flex; gap: 1rem; flex-wrap: wrap;">
            {variants.map((variant) => (
              <div style="flex: 1 1 300px; min-width: 200px;">
                <h3>Dimensions: {variant.width} × {variant.height}</h3>
                <h3>Layout Type: {variant.layout_type}</h3>
                <img
                  src={variant.storage_path.replace(/^gs:\/\//, "https://storage.googleapis.com/")}
                  alt={`Variant for ${variant.device}`}
                  style="max-width: 100%; height: auto; border-radius: 4px;"
                  onerror="this.style.display='none'; this.nextElementSibling.style.display='block';"
                />
                <div style="display: none; color: #999; font-size: 0.9rem; margin-top: 0.5rem;">
                  Variant image not available.
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      <pre>{JSON.stringify(image, null, 2)}</pre>

      <script src="/assets/js/images.js"></script>
    </Layout>
  );
};
