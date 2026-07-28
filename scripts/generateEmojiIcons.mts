import sharp from 'sharp';
import toIco from 'to-ico';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const SOURCE = join(ROOT, '.tmp-icon-gen/generated-512.png');

const isBackgroundPixel = (r: number, g: number, b: number) => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const spread = max - min;

  // Near-white canvas / checkerboard highlights
  if (min >= 235) return true;

  // Neutral checkerboard grays
  if (spread <= 8 && min >= 190 && max <= 230) return true;

  return false;
};

const removeBackground = async (input: Buffer) => {
  const image = sharp(input).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });

  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;

    if (isBackgroundPixel(r, g, b)) {
      data[i + 3] = 0;
    }
  }

  return sharp(data, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
};

const trimTransparentPadding = async (input: Buffer, paddingRatio = 0.08) => {
  const trimmed = await sharp(input).trim().png().toBuffer();
  const meta = await sharp(trimmed).metadata();
  const size = Math.max(meta.width ?? 512, meta.height ?? 512);
  const pad = Math.round(size * paddingRatio);
  const canvas = size + pad * 2;

  return sharp(trimmed)
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .extend({
      top: pad,
      bottom: pad,
      left: pad,
      right: pad,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .resize(canvas, canvas)
    .png()
    .toBuffer();
};

const addBadge = async (base: Buffer, color: string, size: number) => {
  const badgeSize = Math.max(8, Math.round(size * 0.2));
  const margin = Math.round(size * 0.07);
  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${size - margin - badgeSize / 2}" cy="${size - margin - badgeSize / 2}" r="${badgeSize / 2}" fill="${color}" />
  </svg>`;

  return sharp(base)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
};

const writePng = async (path: string, buffer: Buffer) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
};

const writeIco = async (path: string, pngBuffers: Buffer[]) => {
  const ico = await toIco(pngBuffers);
  await writeFile(path, ico);
};

const main = async () => {
  console.log('Removing background…');
  const cutout = await removeBackground(await sharp(SOURCE).png().toBuffer());
  const base512 = await trimTransparentPadding(cutout, 0.1);
  const maskable512 = await trimTransparentPadding(cutout, 0.18);

  const base256 = await sharp(base512).resize(256, 256).png().toBuffer();
  const base192 = await sharp(base512).resize(192, 192).png().toBuffer();
  const base180 = await sharp(base512).resize(180, 180).png().toBuffer();
  const base32 = await sharp(base512).resize(32, 32).png().toBuffer();
  const base16 = await sharp(base512).resize(16, 16).png().toBuffer();
  const maskable192 = await sharp(maskable512).resize(192, 192).png().toBuffer();

  const done512 = await addBadge(base512, '#52c41a', 512);
  const error512 = await addBadge(base512, '#ff4d4f', 512);
  const progress512 = await addBadge(base512, '#1677ff', 512);
  const done32 = await sharp(done512).resize(32, 32).png().toBuffer();
  const error32 = await sharp(error512).resize(32, 32).png().toBuffer();
  const progress32 = await sharp(progress512).resize(32, 32).png().toBuffer();

  console.log('Writing PNG icons…');
  await writePng(join(PUBLIC, 'icons/icon-512x512.png'), base512);
  await writePng(join(PUBLIC, 'icons/icon-512x512.maskable.png'), maskable512);
  await writePng(join(PUBLIC, 'icons/icon-192x192.png'), base192);
  await writePng(join(PUBLIC, 'icons/icon-192x192.maskable.png'), maskable192);
  await writePng(join(PUBLIC, 'apple-touch-icon.png'), base180);
  await writePng(join(ROOT, '.tmp-icon-gen/preview-transparent-512.png'), base512);

  console.log('Writing ICO favicons…');
  await writeIco(join(PUBLIC, 'favicon.ico'), [base16, base32, base256]);
  await writeIco(join(PUBLIC, 'favicon-32x32.ico'), [base32]);
  await writeIco(join(PUBLIC, 'favicon-dev.ico'), [base16, base32]);
  await writeIco(join(PUBLIC, 'favicon-32x32-dev.ico'), [base32]);
  await writeIco(join(PUBLIC, 'favicon-done.ico'), [base16, base32, base256]);
  await writeIco(join(PUBLIC, 'favicon-32x32-done.ico'), [done32]);
  await writeIco(join(PUBLIC, 'favicon-done-dev.ico'), [base16, base32]);
  await writeIco(join(PUBLIC, 'favicon-32x32-done-dev.ico'), [done32]);
  await writeIco(join(PUBLIC, 'favicon-error.ico'), [base16, base32, base256]);
  await writeIco(join(PUBLIC, 'favicon-32x32-error.ico'), [error32]);
  await writeIco(join(PUBLIC, 'favicon-32x-32-error.ico'), [error32]);
  await writeIco(join(PUBLIC, 'favicon-error-dev.ico'), [base16, base32]);
  await writeIco(join(PUBLIC, 'favicon-32x32-error-dev.ico'), [error32]);
  await writeIco(join(PUBLIC, 'favicon-progress.ico'), [base16, base32, base256]);
  await writeIco(join(PUBLIC, 'favicon-32x32-progress.ico'), [progress32]);
  await writeIco(join(PUBLIC, 'favicon-progress-dev.ico'), [base16, base32]);
  await writeIco(join(PUBLIC, 'favicon-32x32-progress-dev.ico'), [progress32]);

  const meta = await sharp(base512).metadata();
  console.log(`Done. ${meta.width}x${meta.height} transparent PNG written to public/.`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
