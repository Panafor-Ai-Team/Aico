declare module 'word-extractor' {
  export default class WordExtractor {
    extract(filePath: string | Buffer): Promise<{
      getBody: () => string;
      text?: string;
    }>;
  }
}
