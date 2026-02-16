import { bootstrapRuntime } from "./runtime/bootstrapRuntime";

async function main(): Promise<void> {
  await bootstrapRuntime({
    startDashboard: true
  });
}

main().catch((error) => {
  process.stderr.write(`Fatal startup error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
