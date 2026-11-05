#!/usr/bin/env node
/** Private worker entry; the operation and destination come only from the existing job receipt. */
import { runEditAgentWorker } from './lib/edit-agent-workflow.mjs';
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--job-id' || args[2] !== '--action') process.exitCode = 2;
else {
  try { await runEditAgentWorker(args[1], args[3]); }
  catch { process.exitCode = 1; }
}
