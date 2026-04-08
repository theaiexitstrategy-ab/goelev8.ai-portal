#!/usr/bin/env node
// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Generate PWA icons from logo.png for all sizes required by
// manifest.json. Each icon is composited onto a #0a0a0a background so
// iOS / Android home-screen thumbnails match the dark portal theme.
//
// Run: npm run icons
//
// Output: icons/icon-{72,96,128,144,152,192,384,512}.png
//
// The 192 + 512 PNGs double as "maskable" icons, so the logo is inset
// from the edges to keep the safe zone inside Android's adaptive mask.

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const SIZES = [72, 96, 128, 144, 152, 192, 384, 512];
const SOURCE = 'logo.png';
const OUT_DIR = 'icons';
const BG = { r: 10, g: 10, b: 10, alpha: 1 }; // #0a0a0a

if (!fs.existsSync(SOURCE)) {
  console.error(`Missing ${SOURCE} in repo root`);
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

for (const size of SIZES) {
  // Inset the logo ~22% so it lives inside the Android maskable safe zone.
  const innerSize = Math.round(size * 0.62);
  const inner = await sharp(SOURCE)
    .resize(innerSize, innerSize, { fit: 'contain', background: BG })
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: BG
    }
  })
    .composite([{ input: inner, gravity: 'center' }])
    .png({ compressionLevel: 9 })
    .toFile(path.join(OUT_DIR, `icon-${size}x${size}.png`));

  console.log(`✓ icons/icon-${size}x${size}.png`);
}

console.log(`\nGenerated ${SIZES.length} icons.`);
