#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-ffi --allow-run
/**
 * CLI tool for managing the slideshow backend
 */

import { parseArgs } from "@std/cli/parse-args";
import { initDatabase } from "./db/schema.ts";
import { getImageStats, ingestImagesFromDirectory } from "./services/image-ingestion.ts";
import { processAllImages } from "./services/image-processing.ts";

const COMMANDS = {
  ingest: "Ingest images from a directory",
  process: "Process images for all device sizes",
  stats: "Show statistics about ingested images",
  help: "Show this help message",
};

function showHelp() {
  console.log("ESPHome Photo Slideshow Backend - CLI Tool\n");
  console.log("Usage: deno task cli <command> [options]\n");
  console.log("Commands:");
  for (const [cmd, description] of Object.entries(COMMANDS)) {
    console.log(`  ${cmd.padEnd(15)} ${description}`);
  }
  console.log("\nExamples:");
  console.log("  deno task cli ingest /path/to/images");
  console.log("  deno task cli ingest /path/to/images --verbose");
  console.log("  deno task cli process --verbose");
  console.log("  deno task cli stats");
}

async function runIngest(args: string[]) {
  const parsed = parseArgs(args, {
    boolean: ["verbose", "recursive"],
    default: {
      recursive: true,
      verbose: false,
    },
  });

  const directory = parsed._[0] as string;

  if (!directory) {
    console.error("Error: Directory path required");
    console.log("\nUsage: deno task cli ingest <directory> [--verbose] [--no-recursive]");
    Deno.exit(1);
  }

  try {
    await Deno.stat(directory);
  } catch {
    console.error(`Error: Directory not found: ${directory}`);
    Deno.exit(1);
  }

  console.log(`Scanning directory: ${directory}`);
  console.log(`Recursive: ${parsed.recursive}`);
  console.log(`Verbose: ${parsed.verbose}\n`);

  const startTime = Date.now();
  const result = await ingestImagesFromDirectory(directory, {
    recursive: parsed.recursive,
    verbose: parsed.verbose,
  });
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log("\n" + "=".repeat(50));
  console.log("Ingestion Complete");
  console.log("=".repeat(50));
  console.log(`Processed: ${result.processed}`);
  console.log(`Skipped:   ${result.skipped}`);
  console.log(`Errors:    ${result.errors}`);
  console.log(`Duration:  ${duration}s`);
}

async function runProcess(args: string[]) {
  const parsed = parseArgs(args, {
    boolean: ["verbose"],
    default: {
      verbose: false,
    },
  });

  const outputDir = "data/processed";

  console.log(`Processing images for all device sizes`);
  console.log(`Output directory: ${outputDir}`);
  console.log(`Verbose: ${parsed.verbose}\n`);

  const startTime = Date.now();
  const result = await processAllImages(outputDir, {
    verbose: parsed.verbose,
  });
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log("\n" + "=".repeat(50));
  console.log("Processing Complete");
  console.log("=".repeat(50));
  console.log(`Processed: ${result.processed}`);
  console.log(`Skipped:   ${result.skipped}`);
  console.log(`Errors:    ${result.errors}`);
  console.log(`Duration:  ${duration}s`);
}

function runStats() {
  const stats = getImageStats();

  console.log("\n" + "=".repeat(50));
  console.log("Image Statistics");
  console.log("=".repeat(50));
  console.log(`Total Images: ${stats.total}`);
  console.log("\nBy Orientation:");
  for (const [orientation, count] of Object.entries(stats.byOrientation)) {
    console.log(`  ${orientation.padEnd(12)}: ${count}`);
  }
}

async function main() {
  const args = Deno.args;

  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    showHelp();
    Deno.exit(0);
  }

  // Initialize database
  await initDatabase();

  const command = args[0];
  const commandArgs = args.slice(1);

  switch (command) {
    case "ingest":
      await runIngest(commandArgs);
      break;

    case "process":
      await runProcess(commandArgs);
      break;

    case "stats":
      runStats();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.log("\nRun 'deno task cli help' for usage information");
      Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
