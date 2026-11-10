import { splitText } from '../../splitter';
import { type DocumentChunk } from '../../types';
import { loaderConfig } from '../config';

export const DocLoader = async (content: Uint8Array): Promise<DocumentChunk[]> => {
  const WordExtractor = (await import('word-extractor')).default;

  const extractor = new WordExtractor();
  const doc = await extractor.extract(Buffer.from(content));

  return splitText(doc.getBody(), loaderConfig);
};
