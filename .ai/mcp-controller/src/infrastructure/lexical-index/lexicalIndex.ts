export interface LexicalHit {
  filePath: string;
  line: number;
  preview: string;
  score: number;
}

interface IndexedLine {
  filePath: string;
  line: number;
  text: string;
  tokens: Set<string>;
}

export class LexicalIndex {
  private readonly lines: IndexedLine[] = [];

  clear(): void {
    this.lines.length = 0;
  }

  addDocument(filePath: string, content: string): void {
    const rows = content.split("\n");
    for (let i = 0; i < rows.length; i += 1) {
      const lineText = rows[i];
      const tokens = new Set(tokenize(lineText));
      if (tokens.size === 0) {
        continue;
      }
      this.lines.push({
        filePath,
        line: i + 1,
        text: lineText,
        tokens
      });
    }
  }

  searchLexeme(query: string, limit = 20): LexicalHit[] {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
      return [];
    }
    const hits: LexicalHit[] = [];
    for (const row of this.lines) {
      const overlap = queryTokens.filter((token) => row.tokens.has(token)).length;
      if (overlap === 0) {
        continue;
      }
      hits.push({
        filePath: row.filePath,
        line: row.line,
        preview: row.text.trim().slice(0, 240),
        score: overlap / queryTokens.length
      });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit));
  }
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}
