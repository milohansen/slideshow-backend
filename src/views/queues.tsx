import type { FC } from "hono/jsx";
import { Layout } from "./layout.tsx";

type QueueItem = {
  imageId: string;
  filePath: string;
  isPaired?: boolean;
  pairedWith?: string;
}

type DeviceQueue = {
  deviceId: string;
  deviceName: string;
  queue: QueueItem[];
  currentIndex: number;
}

type QueuesProps = {
  queues: DeviceQueue[];
  error?: string;
}

export const Queues: FC<QueuesProps> = ({ queues, error }) => {
  return (
    <Layout title="Slideshow Queues">
      {error && (
        <div style="background-color: #fee; border: 1px solid #f88; border-radius: 4px; padding: 1rem; margin-bottom: 1rem; color: #c33;">
          <strong>Error:</strong> {error}
        </div>
      )}
      <h1>Slideshow Queues</h1>
      
      {queues.length === 0 ? (
        <div class="card empty-state">
          <p>No slideshow queues generated yet.</p>
          <p style="margin-top: 1rem;">Queues are generated when devices request their slideshow.</p>
        </div>
      ) : (
        <div>
          {queues.map((deviceQueue) => (
            <div class="card">
              <h2 style="margin-bottom: 1rem;">
                {deviceQueue.deviceName}
                <span style="color: #7f8c8d; font-size: 0.9rem; font-weight: normal; margin-left: 1rem;">
                  ({deviceQueue.deviceId})
                </span>
              </h2>
              
              <p style="margin-bottom: 1rem; color: #7f8c8d;">
                Current position: <strong>{deviceQueue.currentIndex}</strong> / {deviceQueue.queue.length}
              </p>
              
              <div style="max-height: 400px; overflow-y: auto;">
                {deviceQueue.queue.slice(0, 20).map((item, index) => (
                  <div 
                    class={`queue-item ${item.isPaired ? 'paired' : ''}`}
                    style={index === deviceQueue.currentIndex ? 'font-weight: bold; border-left-width: 5px;' : ''}
                  >
                    <span style="color: #7f8c8d; margin-right: 1rem;">#{index + 1}</span>
                    <code style="font-size: 0.85rem;">
                      {item.filePath.split('/').pop()?.replace(/\.[^/.]+$/, '')}
                    </code>
                    {item.isPaired && (
                      <span style="margin-left: 1rem; color: #e74c3c; font-size: 0.85rem;">
                        ↔ Paired
                      </span>
                    )}
                    {index === deviceQueue.currentIndex && (
                      <span style="margin-left: 1rem; color: #3498db; font-size: 0.85rem;">
                        ← Current
                      </span>
                    )}
                  </div>
                ))}
                {deviceQueue.queue.length > 20 && (
                  <p style="text-align: center; color: #7f8c8d; margin-top: 1rem;">
                    ... and {deviceQueue.queue.length - 20} more images
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Layout>
  );
};
