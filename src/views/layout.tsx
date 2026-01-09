import type { FC } from "hono/jsx";

interface LayoutProps {
  title: string;
  children: any;
}

export const Layout: FC<LayoutProps> = ({ title, children }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title} - Slideshow Backend</title>
        <style>{`
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            color: #333;
            background: #f5f5f5;
          }
          
          nav {
            background: #2c3e50;
            padding: 1rem 2rem;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          
          nav ul {
            list-style: none;
            display: flex;
            gap: 2rem;
            align-items: center;
          }
          
          nav a {
            color: white;
            text-decoration: none;
            font-weight: 500;
            transition: opacity 0.2s;
          }
          
          nav a:hover {
            opacity: 0.8;
          }
          
          nav .logo {
            font-size: 1.2rem;
            font-weight: bold;
          }
          
          .container {
            max-width: 1200px;
            margin: 2rem auto;
            padding: 0 2rem;
          }
          
          h1 {
            color: #2c3e50;
            margin-bottom: 2rem;
            font-size: 2rem;
          }
          
          .card {
            background: white;
            padding: 1.5rem;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            margin-bottom: 1.5rem;
          }
          
          .grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 1.5rem;
          }
          
          .stat {
            text-align: center;
            padding: 2rem;
          }
          
          .stat-value {
            font-size: 3rem;
            font-weight: bold;
            color: #3498db;
          }
          
          .stat-label {
            color: #7f8c8d;
            font-size: 0.9rem;
            text-transform: uppercase;
          }
          
          table {
            width: 100%;
            border-collapse: collapse;
          }
          
          th, td {
            padding: 0.75rem;
            text-align: left;
            border-bottom: 1px solid #ecf0f1;
          }
          
          th {
            background: #f8f9fa;
            font-weight: 600;
            color: #2c3e50;
          }
          
          .badge {
            display: inline-block;
            padding: 0.25rem 0.75rem;
            border-radius: 4px;
            font-size: 0.85rem;
            font-weight: 500;
          }
          
          .badge-portrait { background: #e8f5e9; color: #2e7d32; }
          .badge-landscape { background: #e3f2fd; color: #1565c0; }
          .badge-square { background: #fff3e0; color: #e65100; }
          
          .color-swatch {
            display: inline-block;
            width: 30px;
            height: 30px;
            border-radius: 4px;
            border: 2px solid #ddd;
            vertical-align: middle;
            margin-right: 0.5rem;
          }
          
          .color-palette {
            display: flex;
            gap: 0.5rem;
            align-items: center;
          }
          
          .device-info {
            font-size: 0.9rem;
            color: #7f8c8d;
          }
          
          .queue-item {
            padding: 0.5rem;
            border-left: 3px solid #3498db;
            background: #f8f9fa;
            margin-bottom: 0.5rem;
            font-size: 0.9rem;
          }
          
          .queue-item.paired {
            border-left-color: #e74c3c;
            background: #ffebee;
          }
          
          .empty-state {
            text-align: center;
            padding: 3rem;
            color: #7f8c8d;
          }
        `}</style>
      </head>
      <body>
        <nav>
          <ul>
            <li><a href="/" class="logo">📸 Slideshow Backend</a></li>
            <li><a href="/">Home</a></li>
            <li><a href="/ui/devices">Devices</a></li>
            <li><a href="/ui/images">Images</a></li>
            <li><a href="/ui/queues">Queues</a></li>
            <li><a href="/ui/upload">Upload</a></li>
            <li><a href="/ui/photos-picker">Google Photos</a></li>
          </ul>
        </nav>
        <div class="container">
          {children}
        </div>
      </body>
    </html>
  );
};
