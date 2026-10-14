import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export type StreamGrepMode = 'content' | 'count' | 'files_with_matches';

export interface StreamGrepOptions {
  after?: number;
  before?: number;
  lineNumbers?: boolean;
  stopOnFirstMatch?: boolean;
}

export interface StreamGrepResult {
  lines: string[];
  totalMatches: number;
}

/**
 * Line-by-line grep for files too large to buffer into memory.
 * Constant memory: one line at a time, never the whole file.
 *
 * Output matches the buffered implementation (`grepWithNodejs`), except
 * overlapping -A/-B/-C windows emit each line once (like rg) instead of
 * duplicating it.
 */
export async function streamGrepFile(
  filePath: string,
  pattern: string,
  flags: string,
  mode: StreamGrepMode,
  options: StreamGrepOptions = {},
): Promise<StreamGrepResult> {
  const { after = 0, before = 0, lineNumbers = false, stopOnFirstMatch = false } = options;
  const regex = new RegExp(pattern, flags);
  const countRegex =
    mode === 'count' ? new RegExp(pattern, flags.includes('g') ? flags : `g${flags}`) : null;

  const lines: string[] = [];
  let totalMatches = 0;
  let lineNumber = 0;
  let lastEmitted = 0;
  let afterRemaining = 0;
  // Trailing window of seen-but-unemitted lines for -B context.
  const pending: Array<{ n: number; text: string }> = [];

  const push = (n: number, text: string) => {
    lines.push(`${filePath}:${lineNumbers ? `${n}:` : ''}${text}`);
    lastEmitted = n;
  };

  const rl = createInterface({ crlfDelay: Infinity, input: createReadStream(filePath) });
  try {
    for await (const line of rl) {
      lineNumber++;
      if (countRegex) {
        totalMatches += (line.match(countRegex) || []).length;
        continue;
      }
      if (regex.test(line)) {
        totalMatches++;
        if (mode === 'content') {
          for (const t of pending) {
            if (t.n > lastEmitted) push(t.n, t.text);
          }
          pending.length = 0;
          push(lineNumber, line);
          afterRemaining = after;
        }
        if (stopOnFirstMatch) break;
      } else if (mode === 'content' && afterRemaining > 0) {
        push(lineNumber, line);
        afterRemaining--;
      } else if (mode === 'content') {
        pending.push({ n: lineNumber, text: line });
        if (pending.length > before) pending.shift();
      }
    }
  } finally {
    rl.close();
  }

  if (countRegex && totalMatches > 0) {
    lines.push(`${filePath}:${totalMatches}`);
  }
  return { lines, totalMatches };
}
