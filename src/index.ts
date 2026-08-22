#!/usr/bin/env node
// The `thicket` binary. All logic lives in cli.ts so tests can drive it.
import { run } from "./cli.js";

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
