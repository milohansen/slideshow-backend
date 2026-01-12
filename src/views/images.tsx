import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";

interface ImageData {
  id: string;
  file_path: string;
  width: number;
  height: number;
  orientation: string;
  processingStatus: string;
  processingError: string | null;
  processedCount: number;
  totalDevices: number;
  colors: {
    primary: string;
    secondary: string;
    tertiary: string;
  } | null;
}

interface ImagesProps {
  images: ImageData[];
}

export const Images: FC<ImagesProps> = ({ images }) => {
  return (
    <Layout title="Images">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem;">
        <h1 style="margin-bottom: 0;">Ingested Images</h1>
        <button 
          id="delete-all-btn" 
          class="button button-secondary"
          style="background-color: #ef4444;"
        >
          🗑️ Delete All Images
        </button>
      </div>
      
      {images.length === 0 ? (
        <div class="card empty-state">
          <p>No images ingested yet.</p>
          <p style="margin-top: 1rem;">Ingest images using the CLI:</p>
          <code>deno task cli ingest /path/to/images</code>
        </div>
      ) : (
        <div class="card">
          <table>
            <thead>
              <tr>
                <th>Thumbnail</th>
                <th>File Path</th>
                <th>Dimensions</th>
                <th>Orientation</th>
                <th>Processing Status</th>
                <th>Color Palette</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {images.map((image) => {
                return (
                <tr>
                  <td>
                    <img 
                      src={`/ui/thumbnails/${image.id}`} 
                      alt={image.file_path.split('/').pop()}
                      style="width: 80px; height: 53px; object-fit: cover; border-radius: 4px;"
                      onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
                    />
                    <div style="width: 80px; height: 53px; background: #f0f0f0; border-radius: 4px; display: none; align-items: center; justify-content: center; font-size: 0.75rem; color: #999;">No thumb</div>
                  </td>
                  <td>
                    <code style="font-size: 0.85rem;">
                      {image.file_path.split('/').pop()}
                    </code>
                  </td>
                  <td>{image.width} × {image.height}</td>
                  <td>
                    <span class={`badge badge-${image.orientation}`}>
                      {image.orientation}
                    </span>
                  </td>
                  <td>
                    {image.processingStatus === 'complete' ? (
                      <span class="badge" style="background-color: #22c55e; color: white;">
                        ✓ Complete ({image.processedCount}/{image.totalDevices})
                      </span>
                    ) : image.processingStatus === 'failed' ? (
                      <div style="display: flex; gap: 0.5rem; align-items: center;">
                        <span 
                          class="badge" 
                          style="background-color: #ef4444; color: white; cursor: help;"
                          title={image.processingError || 'Processing failed'}
                        >
                          ✗ Failed
                        </span>
                        <form method="post" action={`/ui/images/${image.id}/retry`} style="margin: 0;">
                          <button 
                            type="submit" 
                            class="btn-small"
                            style="padding: 0.25rem 0.5rem; font-size: 0.85rem; background-color: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer;"
                          >
                            ⟳ Retry
                          </button>
                        </form>
                      </div>
                    ) : image.processingStatus === 'processing' ? (
                      <span class="badge" style="background-color: #3b82f6; color: white;">
                        ⟳ Processing ({image.processedCount}/{image.totalDevices})
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
                        <span 
                          class="color-swatch" 
                          style={`background-color: ${image.colors.primary}`}
                          title={`Primary: ${image.colors.primary}`}
                        ></span>
                        <span 
                          class="color-swatch" 
                          style={`background-color: ${image.colors.secondary}`}
                          title={`Secondary: ${image.colors.secondary}`}
                        ></span>
                        <span 
                          class="color-swatch" 
                          style={`background-color: ${image.colors.tertiary}`}
                          title={`Tertiary: ${image.colors.tertiary}`}
                        ></span>
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      
      <script src="/assets/js/images.js"></script>
    </Layout>
  );
};
