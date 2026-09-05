#!/usr/bin/env node

import { runBoundaryCheck } from "./check.js";
import { formatCheckError, formatHumanReport } from "./reporter.js";

async function main(): Promise<void> {
  const rootDirectory = process.cwd();
  try {
    const args = process.argv.slice(2);
    let configPath: string | undefined;
    if (args.length > 0) {
      if (args[0] !== "--config") throw new Error(`Unknown argument: ${args[0]}`);
      if (!args[1] || args[1].startsWith("--")) throw new Error("--config requires a file path.");
      if (args.length > 2) throw new Error(`Unexpected argument: ${args[2]}`);
      configPath = args[1];
    }
    const result = await runBoundaryCheck({ rootDirectory,
      ...(configPath === undefined ? {} : { configPath }) });
    process.stdout.write(formatHumanReport(result));
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(formatCheckError(error, rootDirectory));
    process.exitCode = 2;
  }
}

await main();
