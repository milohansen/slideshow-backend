import { parseArgs } from "jsr:@std/cli/parse-args";
import * as path from "jsr:@std/path";
import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const args = parseArgs(process.argv.slice(2), {
  string: ["path", "width", "height"],
  alias: { p: "path", w: "width", h: "height" },
});

if (!args.path || !args.width || !args.height) {
  console.error("Usage: deno run --allow-read --allow-net resize.ts --path <image_path> --width <width> --height <height>");
  process.exit(1);
}

const buffer = Buffer.from(await readFile(args.path));

const parsed = path.parse(args.path);

const positions = ["entropy", "attention", undefined];

for (const position of positions) {
  const resizedBuffer = await sharp(buffer)
    .resize(parseInt(args.width), parseInt(args.height), {
      fit: "cover",
      position: position, // Smart crop
      kernel: sharp.kernel.mks2021,
    })
    .jpeg({ quality: 90 })
    .toBuffer();

  const outDir = "./temp";
  const outputPath = `${outDir}/${parsed.name}_resized_${args.width}x${args.height}_${position || "none"}.jpg`;
  await writeFile(outputPath, resizedBuffer);
  console.log(`Resized image saved to ${outputPath}`);
}
