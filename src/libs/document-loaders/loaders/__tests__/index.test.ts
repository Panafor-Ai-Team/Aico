import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ChunkingLoader } from '../index';

const fixture = (filename: string) =>
  new Uint8Array(fs.readFileSync(path.join(__dirname, `./fixtures/${filename}`)));

describe('ChunkingLoader Word documents', () => {
  it('chunks a legacy .doc file (regression: must not use the docx/mammoth loader)', async () => {
    const chunks = await new ChunkingLoader().partitionContent('test.doc', fixture('test.doc'));

    expect(chunks).not.toHaveLength(0);
    // word-extractor output asserts the legacy OLE binary was parsed
    expect(chunks.some((c) => c.pageContent.length > 0)).toBe(true);
  });

  it('chunks a .docx file via the docx loader', async () => {
    const chunks = await new ChunkingLoader().partitionContent('test.docx', fixture('test.docx'));

    expect(chunks).not.toHaveLength(0);
    expect(chunks.some((c) => c.pageContent.length > 0)).toBe(true);
  });
});
