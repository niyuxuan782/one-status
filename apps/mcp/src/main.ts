#!/usr/bin/env node
import { startStdioMcp } from "./stdio.js";

startStdioMcp().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
