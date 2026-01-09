import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";

interface Device {
  id: string;
  name: string;
  width: number;
  height: number;
  orientation: string;
  created_at: string;
  last_seen: string | null;
}

interface DevicesProps {
  devices: Device[];
}

export const Devices: FC<DevicesProps> = ({ devices }) => {
  return (
    <Layout title="Devices">
      <h1>Registered Devices</h1>
      
      {devices.length === 0 ? (
        <div class="card empty-state">
          <p>No devices registered yet.</p>
          <p style="margin-top: 1rem;">Register a device via the API:</p>
          <code>POST /api/devices</code>
        </div>
      ) : (
        <div class="card">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>ID</th>
                <th>Resolution</th>
                <th>Orientation</th>
                <th>Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((device) => (
                <tr>
                  <td><strong>{device.name}</strong></td>
                  <td><code>{device.id}</code></td>
                  <td>{device.width} × {device.height}</td>
                  <td>
                    <span class={`badge badge-${device.orientation}`}>
                      {device.orientation}
                    </span>
                  </td>
                  <td class="device-info">
                    {device.last_seen 
                      ? new Date(device.last_seen).toLocaleString()
                      : "Never"}
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
