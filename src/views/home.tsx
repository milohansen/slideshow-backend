import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";

interface HomeProps {
  stats: {
    totalImages: number;
    totalDevices: number;
    processedVariants: number;
    orientations: Record<string, number>;
    error?: string;
  };
}

export const Home: FC<HomeProps> = ({ stats }) => {
  return (
    <Layout title="Home">
      <h1>Dashboard</h1>
      
      {stats.error && (
        <div class="card error">
          <h2 style="color: #d73a49;">⚠️ Error Loading Data</h2>
          <p>{stats.error}</p>
          <p>Please check your Firestore security rules and authentication setup.</p>
        </div>
      )}
      
      <div class="grid">
        <div class="card stat">
          <div class="stat-value">{stats.totalImages}</div>
          <div class="stat-label">Total Images</div>
        </div>
        
        <div class="card stat">
          <div class="stat-value">{stats.totalDevices}</div>
          <div class="stat-label">Devices</div>
        </div>
        
        <div class="card stat">
          <div class="stat-value">{stats.processedVariants}</div>
          <div class="stat-label">Processed Variants</div>
        </div>
      </div>
      
      <div class="card">
        <h2 style="margin-bottom: 1rem;">Images by Orientation</h2>
        <div style="display: flex; gap: 2rem; flex-wrap: wrap;">
          {Object.entries(stats.orientations).map(([orientation, count]) => (
            <div>
              <span class={`badge badge-${orientation}`}>{orientation}</span>
              <strong style="margin-left: 0.5rem;">{count}</strong>
            </div>
          ))}
        </div>
      </div>
      
      <div class="card">
        <h2 style="margin-bottom: 1rem;">Quick Actions</h2>
        <p>Use the CLI tool to manage images:</p>
        <ul style="margin-top: 1rem; margin-left: 2rem;">
          <li><code>deno task cli ingest /path/to/images</code> - Ingest new images</li>
          <li><code>deno task cli process</code> - Process images for all device sizes</li>
          <li><code>deno task cli stats</code> - View statistics</li>
        </ul>
      </div>
    </Layout>
  );
};
