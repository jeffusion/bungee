#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'bun';

const publicDir = join(import.meta.dir, '..', 'packages', 'ui', 'public');
const faviconSvgPath = join(publicDir, 'favicon.svg');

const pngSizes = [16, 32, 48, 180, 192, 512] as const;
const icoSizes = [16, 32, 48] as const;

function ensurePublicDir(): void {
  if (!existsSync(publicDir)) {
    mkdirSync(publicDir, { recursive: true });
  }
}

function runRsvgConvert(size: number): void {
  const outputPath = join(publicDir, `favicon-${size}x${size}.png`);
  const result = spawnSync({
    cmd: ['rsvg-convert', '--width', String(size), '--height', String(size), '--output', outputPath, faviconSvgPath],
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`rsvg-convert failed for ${size}x${size}: ${stderr}`);
  }
}

function writeUInt16LE(buffer: Buffer, value: number, offset: number): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >> 8) & 0xff;
}

function writeUInt32LE(buffer: Buffer, value: number, offset: number): void {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >> 8) & 0xff;
  buffer[offset + 2] = (value >> 16) & 0xff;
  buffer[offset + 3] = (value >> 24) & 0xff;
}

function createIco(): void {
  const images = icoSizes.map((size) => ({
    size,
    data: readFileSync(join(publicDir, `favicon-${size}x${size}.png`)),
  }));

  const headerSize = 6;
  const directoryEntrySize = 16;
  const directorySize = images.length * directoryEntrySize;
  const totalSize = headerSize + directorySize + images.reduce((sum, image) => sum + image.data.length, 0);
  const ico = Buffer.alloc(totalSize);

  writeUInt16LE(ico, 0, 0);
  writeUInt16LE(ico, 1, 2);
  writeUInt16LE(ico, images.length, 4);

  let imageOffset = headerSize + directorySize;

  for (const [index, image] of images.entries()) {
    const entryOffset = headerSize + index * directoryEntrySize;
    ico[entryOffset] = image.size;
    ico[entryOffset + 1] = image.size;
    ico[entryOffset + 2] = 0;
    ico[entryOffset + 3] = 0;
    writeUInt16LE(ico, 1, entryOffset + 4);
    writeUInt16LE(ico, 32, entryOffset + 6);
    writeUInt32LE(ico, image.data.length, entryOffset + 8);
    writeUInt32LE(ico, imageOffset, entryOffset + 12);
    image.data.copy(ico, imageOffset);
    imageOffset += image.data.length;
  }

  writeFileSync(join(publicDir, 'favicon.ico'), ico);
}

function createManifest(): void {
  const manifest = {
    name: 'Bungee Dashboard',
    short_name: 'Bungee',
    icons: [
      { src: '/__ui/favicon-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/__ui/favicon-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    theme_color: '#4F46E5',
    background_color: '#FFFFFF',
    display: 'standalone',
  };

  writeFileSync(join(publicDir, 'site.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);
}

ensurePublicDir();

if (!existsSync(faviconSvgPath)) {
  throw new Error(`Missing source SVG: ${faviconSvgPath}`);
}

for (const size of pngSizes) {
  runRsvgConvert(size);
}

writeFileSync(join(publicDir, 'apple-touch-icon.png'), readFileSync(join(publicDir, 'favicon-180x180.png')));
createIco();
createManifest();

console.log(`Generated favicon assets in ${publicDir}`);
