import { ChatErrorType } from '@lobechat/types';

// Same ceiling nginx enforces on the raw body (`client_max_body_size 25m`), so
// a compressed body can't expand past what an uncompressed one may send.
export const MAX_DECODED_BODY_BYTES = 25 * 1024 * 1024;

const badRequest = (message: string) =>
  Object.assign(new Error(message), { errorType: ChatErrorType.BadRequest });

/**
 * Parse a JSON request body that the browser may have gzipped
 * (`Content-Encoding: gzip`). Chat payloads carry the whole history and tool
 * set, so they are compressed before upload; plain JSON stays accepted for
 * older tabs and other callers. The decoded size is capped while streaming.
 */
export const readJsonRequestBody = async <T>(
  req: Request,
  maxBytes: number = MAX_DECODED_BODY_BYTES,
): Promise<T> => {
  const encoding = req.headers.get('content-encoding')?.trim().toLowerCase();
  if (!encoding || encoding === 'identity') return (await req.json()) as T;
  if (encoding !== 'gzip') throw badRequest(`Unsupported request Content-Encoding: ${encoding}`);
  if (!req.body) throw badRequest('Empty gzip request body');

  const reader = req.body.pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw badRequest(`Decoded request body exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if ((error as { errorType?: string }).errorType) throw error;
    throw badRequest('Invalid gzip request body');
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
};
