/** Task-local provider gateway. Provider credentials belong to this process only. */
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { startProviderBudgetGateway } from "./lib/provider-budget-gateway.js";
import { BudgetError, check } from "./lib/provider-budget-policy.js";

function parseArgs(args: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const option = args[i];
    const value = args[i + 1];
    check(option && ["--port", "--task", "--journal", "--scope", "--profile"].includes(option) && value && !value.startsWith("--") && !values.has(option),
      "BUDGET_GATEWAY_ARGUMENTS_INVALID", 503);
    values.set(option, value);
  }
  const port = Number(values.get("--port"));
  const journal = values.get("--journal");
  check(Number.isInteger(port) && port >= 1024 && port <= 65535 && journal, "BUDGET_GATEWAY_ARGUMENTS_INVALID", 503);
  const scopePath = values.get("--scope");
  const scope: unknown = scopePath ? JSON.parse(readFileSync(scopePath, "utf8")) : undefined;
  return { port, task: values.get("--task") ?? "local-task", journalPath: resolve(journal), scope, profile: values.get("--profile") };
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    console.log("Usage: node --import tsx scripts/tools/provider-budget-gateway.mts --port PORT --journal PATH [--task ID] [--scope FILE] [--profile case|workflow|workflow-v2]");
    return;
  }
  check(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0" && !process.env.NODE_USE_ENV_PROXY,
    "BUDGET_GATEWAY_REQUIRES_DIRECT_VERIFIED_TLS", 503);
  const gateway = await startProviderBudgetGateway({
    ...parseArgs(process.argv.slice(2)),
    clientToken: process.env.WORKLOOM_BUDGET_GATEWAY_TOKEN ?? "",
    deepSeekApiKey: process.env.WORKLOOM_BUDGET_DEEPSEEK_API_KEY ?? "",
    arkApiKey: process.env.WORKLOOM_BUDGET_ARK_API_KEY ?? "",
  });
  console.log(JSON.stringify({ ready: true, baseUrl: gateway.baseUrl }));
  const stop = () => {
    void gateway.close().catch(() => {
      console.error(JSON.stringify({ code: "BUDGET_GATEWAY_CLOSE_FAILED" }));
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ code: error instanceof BudgetError ? error.code : "BUDGET_GATEWAY_START_FAILED" }));
  process.exitCode = 1;
}
