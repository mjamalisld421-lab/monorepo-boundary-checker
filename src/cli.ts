#!/usr/bin/env node

import { runBoundaryCheck } from "./check.js";
import { formatCheckError, formatHumanReport, formatJsonError, formatJsonReport } from "./reporter.js";

class CliArgumentError extends Error {
  readonly code = "CLI_ARGUMENT_ERROR";
}

async function main(): Promise<void> {
  const rootDirectory = process.cwd();
  const args = process.argv.slice(2);
  const jsonRequested = args.includes("--json");
  try {
    let configPath: string | undefined;
    let json = false;
    for (let index = 0; index < args.length; index++) {
      const argument = args[index];
      if (argument === "--json") {
        if (json) throw new CliArgumentError("Unexpected argument: --json");
        json = true;
      } else if (argument === "--config") {
        const value = args[index + 1];
        if (!value || value.startsWith("--")) throw new CliArgumentError("--config requires a file path.");
        if (configPath !== undefined) throw new CliArgumentError("Unexpected argument: --config");
        configPath = value;
        index++;
      } else {
        throw new CliArgumentError(`Unknown argument: ${argument}`);
      }
    }
    const result = await runBoundaryCheck({ rootDirectory,
      ...(configPath === undefined ? {} : { configPath }) });
    process.stdout.write(json ? formatJsonReport(result) : formatHumanReport(result));
    process.exitCode = result.exitCode;
  } catch (error) {
    if (jsonRequested) process.stdout.write(formatJsonError(error, rootDirectory));
    else process.stderr.write(formatCheckError(error, rootDirectory));
    process.exitCode = 2;
  }
}

await main();
