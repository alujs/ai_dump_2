import vm from "node:vm";
import { Worker } from "node:worker_threads";

export interface VmRunInput {
  iife: string;
  context: Record<string, unknown>;
  timeoutMs: number;
  /** Memory cap in MB. When > 0, execution uses worker_threads with resourceLimits. */
  memoryCapMb?: number;
}

/**
 * Run an async IIFE in an isolated context.
 * When memoryCapMb is specified, spawns a worker thread with resourceLimits
 * to enforce the memory cap (vm.Script has no memory limits).
 */
export async function runAsyncIife(input: VmRunInput): Promise<unknown> {
  if (input.memoryCapMb && input.memoryCapMb > 0) {
    return runInWorker(input);
  }
  return runInVm(input);
}

/** Legacy path: vm.Script (timeout only, no memory cap) */
function runInVm(input: VmRunInput): Promise<unknown> {
  const script = new vm.Script(input.iife, {
    filename: "code_run.iife.js"
  });
  const context = vm.createContext({
    ...input.context,
    console
  });
  const result = script.runInContext(context, {
    timeout: input.timeoutMs
  });
  return Promise.resolve(result);
}

/** Worker path: worker_threads with resourceLimits (timeout + memory cap) */
function runInWorker(input: VmRunInput): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const workerScript = `
      const { parentPort, workerData } = require("node:worker_threads");
      const vm = require("node:vm");
      const script = new vm.Script(workerData.iife, { filename: "code_run.iife.js" });
      const context = vm.createContext({ ...workerData.context, console });
      try {
        const result = script.runInContext(context, { timeout: workerData.timeoutMs });
        Promise.resolve(result).then(
          (val) => parentPort.postMessage({ ok: true, value: val }),
          (err) => parentPort.postMessage({ ok: false, error: err?.message ?? String(err) })
        );
      } catch (err) {
        parentPort.postMessage({ ok: false, error: err?.message ?? String(err) });
      }
    `;

    const worker = new Worker(workerScript, {
      eval: true,
      workerData: {
        iife: input.iife,
        context: input.context,
        timeoutMs: input.timeoutMs,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: input.memoryCapMb,
        maxYoungGenerationSizeMb: Math.max(1, Math.floor((input.memoryCapMb ?? 64) / 4)),
      },
    });

    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`Code run exceeded timeout of ${input.timeoutMs}ms`));
    }, input.timeoutMs + 500); // small grace period over vm timeout

    worker.on("message", (msg: { ok: boolean; value?: unknown; error?: string }) => {
      clearTimeout(timer);
      worker.terminate();
      if (msg.ok) resolve(msg.value);
      else reject(new Error(msg.error ?? "CODE_RUN_FAILED"));
    });

    worker.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    worker.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Worker exited with code ${code} (likely exceeded memory limit of ${input.memoryCapMb}MB)`));
      }
    });
  });
}
