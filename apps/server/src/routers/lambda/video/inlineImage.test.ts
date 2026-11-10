import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { acceptsInlineVideoImages, type InlineImageContext, inlineOwnedImage } from './inlineImage';

const findById = vi.fn();

vi.mock('@/database/models/file', () => ({
  FileModel: vi.fn().mockImplementation(() => ({ findById })),
}));

vi.mock('@/server/services/aico/managedPolicy', () => ({
  AicoManagedPolicy: {
    resolveRuntimeProvider: (provider: string) =>
      provider === 'aico' ? 'cheapvibecode' : provider,
  },
}));

// 1×1 PNG
const PNG_BYTES = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  ),
);

const decodeDataUrl = (dataUrl: string) => Buffer.from(dataUrl.split(',')[1], 'base64');

const createContext = () => {
  const findFirst = vi.fn();
  const context: InlineImageContext = {
    db: { query: { files: { findFirst } } } as any,
    fileService: {
      getFileByteArray: vi.fn().mockResolvedValue(PNG_BYTES),
      getKeyFromFullUrl: vi.fn().mockResolvedValue('files/user-1/cat.png'),
    },
    userId: 'user-1',
  };
  return { context, findFirst };
};

describe('inlineOwnedImage', () => {
  beforeEach(() => {
    findById.mockReset();
  });

  it('inlines an uploaded image behind the file proxy as a data URL', async () => {
    const { context } = createContext();
    findById.mockResolvedValue({ url: 'files/user-1/cat.png' });

    const dataUrl = await inlineOwnedImage('https://chat.example.com/f/file-1', context);

    expect(findById).toHaveBeenCalledWith('file-1');
    expect(context.fileService.getFileByteArray).toHaveBeenCalledWith('files/user-1/cat.png');
    expect(dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    const frame = await sharp(decodeDataUrl(dataUrl!)).metadata();
    expect(frame).toMatchObject({ format: 'jpeg', height: 1, width: 1 });
  });

  it('re-encodes large transparent uploads as a bounded, upright JPEG', async () => {
    const { context } = createContext();
    findById.mockResolvedValue({ url: 'files/user-1/poster.png' });
    const largePng = await sharp({
      create: {
        background: { alpha: 0, b: 0, g: 0, r: 0 },
        channels: 4,
        height: 3000,
        width: 4000,
      },
    })
      .png()
      .toBuffer();
    vi.mocked(context.fileService.getFileByteArray).mockResolvedValueOnce(
      Uint8Array.from(largePng),
    );

    const dataUrl = await inlineOwnedImage('https://chat.example.com/f/poster', context);

    const frame = await sharp(decodeDataUrl(dataUrl!)).metadata();
    expect(frame).toMatchObject({ format: 'jpeg', hasAlpha: false, height: 1440, width: 1920 });
  });

  it('applies EXIF orientation so portrait phone photos stay portrait', async () => {
    const { context } = createContext();
    findById.mockResolvedValue({ url: 'files/user-1/phone.jpg' });
    // Stored landscape with orientation 6 (rotate 90° clockwise to display).
    const phoneJpeg = await sharp({
      create: { background: '#336699', channels: 3, height: 300, width: 400 },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    vi.mocked(context.fileService.getFileByteArray).mockResolvedValueOnce(
      Uint8Array.from(phoneJpeg),
    );

    const dataUrl = await inlineOwnedImage('https://chat.example.com/f/phone', context);

    const frame = await sharp(decodeDataUrl(dataUrl!)).metadata();
    expect(frame).toMatchObject({ height: 400, width: 300 });
    expect(frame.orientation ?? 1).toBe(1);
  });

  it('inlines a storage URL only when the caller owns the file', async () => {
    const { context, findFirst } = createContext();
    findFirst.mockResolvedValue({ url: 'files/user-1/cat.png' });

    expect(
      await inlineOwnedImage('https://s3.example.com/bucket/files/user-1/cat.png', context),
    ).toMatch(/^data:image\/jpeg;base64,/);

    findFirst.mockResolvedValue(undefined);
    expect(
      await inlineOwnedImage('https://s3.example.com/bucket/files/user-2/cat.png', context),
    ).toBeUndefined();
  });

  it('keeps the URL for files the caller does not own', async () => {
    const { context } = createContext();
    findById.mockResolvedValue(undefined);

    expect(await inlineOwnedImage('https://chat.example.com/f/other', context)).toBeUndefined();
    expect(context.fileService.getFileByteArray).not.toHaveBeenCalled();
  });

  it('keeps the URL when the stored file is not an image or cannot be read', async () => {
    const { context } = createContext();
    findById.mockResolvedValue({ url: 'files/user-1/notes.txt' });
    vi.mocked(context.fileService.getFileByteArray).mockResolvedValueOnce(
      new TextEncoder().encode('plain text'),
    );
    expect(await inlineOwnedImage('https://chat.example.com/f/notes', context)).toBeUndefined();

    vi.mocked(context.fileService.getFileByteArray).mockRejectedValueOnce(new Error('NoSuchKey'));
    expect(await inlineOwnedImage('https://chat.example.com/f/gone', context)).toBeUndefined();
  });
});

describe('acceptsInlineVideoImages', () => {
  it('is on for runtimes that take data URLs, including the managed provider', () => {
    expect(acceptsInlineVideoImages('aico')).toBe(true);
    expect(acceptsInlineVideoImages('cheapvibecode')).toBe(true);
    expect(acceptsInlineVideoImages('openrouter')).toBe(true);
    expect(acceptsInlineVideoImages('volcengine')).toBe(false);
  });
});
