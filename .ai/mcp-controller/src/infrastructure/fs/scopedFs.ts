import { readText, writeText } from "../../shared/fileStore";
import { normalizeSafePath } from "../../shared/fsPaths";

export async function readScopedText(root: string, relativePath: string): Promise<{ filePath: string; content: string }> {
  const filePath = normalizeSafePath(root, relativePath);
  const content = await readText(filePath);
  return { filePath, content };
}

export async function writeScopedText(
  root: string,
  relativePath: string,
  content: string
): Promise<{ filePath: string; bytes: number }> {
  const filePath = normalizeSafePath(root, relativePath);
  await writeText(filePath, content);
  return { filePath, bytes: Buffer.byteLength(content, "utf8") };
}
