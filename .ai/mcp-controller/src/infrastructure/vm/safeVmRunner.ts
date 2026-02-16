import vm from "node:vm";

export interface VmRunInput {
  iife: string;
  context: Record<string, unknown>;
  timeoutMs: number;
}

export async function runAsyncIife(input: VmRunInput): Promise<unknown> {
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
