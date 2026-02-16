export function replaceWithGuard(
  value: string,
  pattern: string | RegExp,
  replacement: string,
  context: string
): string {
  try {
    return value.replace(pattern, replacement);
  } catch (error) {
    const details = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`[replace-guard] ${context}\n`);
    process.stderr.write(`[replace-guard] ${details}\n`);
    throw error;
  }
}
