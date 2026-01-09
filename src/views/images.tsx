import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";

interface ImageData {
  id: string;
  file_path: string;
  width: number;
  height: number;
  orientation: string;
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
      <h1>Ingested Images</h1>
      
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
                <th>File Path</th>
                <th>Dimensions</th>
                <th>Orientation</th>
                <th>Color Palette</th>
              </tr>
            </thead>
            <tbody>
              {images.map((image) => (
                <tr>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Layout>
  );
};
