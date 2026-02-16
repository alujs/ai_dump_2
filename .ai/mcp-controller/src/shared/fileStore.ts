import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function writeText(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, content, "utf8");
}

export async function readText(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

export async function appendJsonl(filePath: string, row: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await appendFile(filePath, `${JSON.stringify(row)}\n`, "utf8");
}
