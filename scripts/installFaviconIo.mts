import sharp from 'sharp';
import toIco from 'to-ico';
import { copyFile, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '../..');
const SRC = join(ROOT, 'favicon_io');
const PUBLIC = join(ROOT, 'public');
const ICONS = join(PUBLIC, 'icons');

await mkdir(ICONS, { recursive: true });

await copyFile(join(SRC, 'favicon.ico'), join(PUBLIC, 'favicon.ico'));
await copyFile(join(SRC, 'apple-touch-icon.png'), join(PUBLIC, 'apple-touch-icon.png'));
await copyFile(join(SRC, 'android-chrome-192x192.png'), join(ICONS, 'icon-192x192.png'));
await copyFile(join(SRC, 'android-chrome-512x512.png'), join(ICONS, 'icon-512x512.png'));

const png16 = await readFile(join(SRC, 'favicon-16x16.png'));
const png32 = await readFile(join(SRC, 'favicon-32x32.png'));
const png192 = await readFile(join(SRC, 'android-chrome-192x192.png'));
const png512 = await readFile(join(SRC, 'android-chrome-512x512.png'));

await writeFile(join(ICONS, 'icon-192x192.maskable.png'), png192);
await writeFile(join(ICONS, 'icon-512x512.maskable.png'), png512);

const addBadge = async (base: Buffer, color: string, size: number) => {
  const badgeSize = Math.max(6, Math.round(size * 0.22));
  const margin = Math.round(size * 0.06);
  const stroke = Math.max(1, Math.round(size * 0.03));
  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${size - margin - badgeSize / 2}" cy="${size - margin - badgeSize / 2}" r="${badgeSize / 2}" fill="${color}" stroke="#fff" stroke-width="${stroke}" />
  </svg>`;

  return sharp(base)
    .resize(size, size)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
};

const writeIco = async (path: string, buffers: Buffer[]) => {
  await writeFile(path, await toIco(buffers));
};

await writeIco(join(PUBLIC, 'favicon-32x32.ico'), [png32]);
await writeIco(join(PUBLIC, 'favicon-dev.ico'), [png16, png32]);
await writeIco(join(PUBLIC, 'favicon-32x32-dev.ico'), [png32]);

const done32 = await addBadge(png32, '#52c41a', 32);
const error32 = await addBadge(png32, '#ff4d4f', 32);
const progress32 = await addBadge(png32, '#1677ff', 32);
const done16 = await sharp(done32).resize(16, 16).png().toBuffer();
const error16 = await sharp(error32).resize(16, 16).png().toBuffer();
const progress16 = await sharp(progress32).resize(16, 16).png().toBuffer();

await writeIco(join(PUBLIC, 'favicon-done.ico'), [done16, done32]);
await writeIco(join(PUBLIC, 'favicon-32x32-done.ico'), [done32]);
await writeIco(join(PUBLIC, 'favicon-done-dev.ico'), [done16, done32]);
await writeIco(join(PUBLIC, 'favicon-32x32-done-dev.ico'), [done32]);

await writeIco(join(PUBLIC, 'favicon-error.ico'), [error16, error32]);
await writeIco(join(PUBLIC, 'favicon-32x32-error.ico'), [error32]);
await writeIco(join(PUBLIC, 'favicon-32x-32-error.ico'), [error32]);
await writeIco(join(PUBLIC, 'favicon-error-dev.ico'), [error16, error32]);
await writeIco(join(PUBLIC, 'favicon-32x32-error-dev.ico'), [error32]);

await writeIco(join(PUBLIC, 'favicon-progress.ico'), [progress16, progress32]);
await writeIco(join(PUBLIC, 'favicon-32x32-progress.ico'), [progress32]);
await writeIco(join(PUBLIC, 'favicon-progress-dev.ico'), [progress16, progress32]);
await writeIco(join(PUBLIC, 'favicon-32x32-progress-dev.ico'), [progress32]);

console.log('Installed favicon_io assets into public/');
