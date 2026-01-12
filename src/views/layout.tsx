/** @jsx jsx */
/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import type { Child } from "hono/jsx";

interface LayoutProps {
  title: string;
  children: Child | Child[];
}

export const Layout: FC<LayoutProps> = ({ title, children }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title} - Slideshow Backend</title>
        <link rel="stylesheet" href="/assets/css/layout.css" />
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
