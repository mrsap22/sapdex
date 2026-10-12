// Makes the site's emblem and every icon from the one vector.
// Run it again when the vector changes; what it writes is committed.
//
//   npx tsx scripts/make-brand.ts
//
// The sources (web/src/assets/brand/) are the supplied artwork and are never changed:
//   emblem-photo.png   the emblem as it was supplied: a photograph of it pressed into paper
//   emblem.svg         the same emblem as a flat vector in one colour on no ground, traced from the photograph
//
// What is written (web/public/):
//   brand/emblem.svg   the vector as the page uses it, beside the name: it takes the colour of the text
//   favicon.ico        16, 32 and 48 px in one file
//   favicon-32.png, icon-192.png, icon-512.png, apple-touch-icon.png (180)
//   site.webmanifest   the name, the two large icons, and the page's colour from the design tokens
//
// Every icon is the emblem in the ink colour on a square of the paper colour, both read from the
// design tokens: a browser's tab can be light or dark, and the emblem alone would be lost on one
// of them. Nothing is redrawn or given an effect. The one thing done for size: at 16 px the thin
// arcs would be less than a pixel wide, so that one picture is drawn with a hair of outline in the
// same ink, which keeps them on show. Uses the Chrome already installed on this machine.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { chromium } from "playwright-core";

const SOURCES = path.resolve("web", "src", "assets", "brand");
const PUBLIC = path.resolve("web", "public");

/** How much of an icon's side is left as ground round the emblem, on each side. */
export const ICON_AIR = 0.14;
/** The same for a browser tab's pictures, where the emblem needs every pixel it can have. */
export const TAB_ICON_AIR = 0.04;
/** The outline that keeps the thin arcs on show at 16 px, as a share of the emblem's width. At no other size. */
export const SMALLEST_OUTLINE = 0.015;

interface Made {
  name: string;
  size: number;
  png: Buffer;
}

const emblem = fs.readFileSync(path.join(SOURCES, "emblem.svg"), "utf8");
const shape = /<path fill="currentColor" d="([^"]+)"\/>/.exec(emblem)?.[1];
if (shape === undefined || !emblem.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">')) throw new Error("make-brand: emblem.svg is not one path in one colour in a square of 100");

// The paper and the ink, from the design tokens (the light theme's, which is the one the site opens in).
const tokens = fs.readFileSync(path.resolve("web", "src", "styles", "tokens.css"), "utf8");
const light = /\n:root,\n:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/.exec(tokens)?.[1] ?? "";
const paper = /--bg:\s*(#[0-9a-fA-F]{6});/.exec(light)?.[1];
const ink = /--text:\s*(#[0-9a-fA-F]{6});/.exec(light)?.[1];
if (paper === undefined || ink === undefined) throw new Error("make-brand: the paper and ink colours (--bg, --text) are not in the design tokens");

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext()).newPage();
await page.setContent("<!doctype html><title>brand</title>");

/** The emblem in ink on a square of paper, at a size, as its plain pixels. */
async function icon(size: number, name: string, air: number, outline = 0): Promise<Made> {
  const base64 = await page.evaluate(
    async ([d, side, margin, ground, colour, stroke]) => {
      const inner = 100 / (1 - 2 * (margin as number));
      const start = (inner - 100) / 2;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="${-start} ${-start} ${inner} ${inner}"><rect x="${-start}" y="${-start}" width="${inner}" height="${inner}" fill="${ground}"/><path fill="${colour}" stroke="${colour}" stroke-width="${(stroke as number) * 100}" stroke-linejoin="round" d="${d}"/></svg>`;
      const picture = new Image();
      picture.src = `data:image/svg+xml;base64,${btoa(svg)}`;
      await picture.decode();
      const canvas = new OffscreenCanvas(side as number, side as number);
      const context = canvas.getContext("2d")!;
      context.drawImage(picture, 0, 0);
      const bytes = new Uint8Array(context.getImageData(0, 0, side as number, side as number).data.buffer);
      let text = "";
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(text);
    },
    [shape, size, air, paper, ink, outline] as const,
  );
  return { name, size, png: pngOf(Buffer.from(base64, "base64"), size, size) };
}

/**
 * A PNG of plain pixels, written small: three bytes to a pixel where nothing is see-through (four
 * where something is), each row stored in whichever of the format's five ways comes out smallest,
 * and packed as tightly as the packer goes. Not one pixel is changed by any of it.
 */
function pngOf(rgba: Buffer, width: number, height: number): Buffer {
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) opaque = false;
  const bpp = opaque ? 3 : 4;
  const stride = width * bpp;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) rgba.copy(row, x * bpp, (y * width + x) * 4, (y * width + x) * 4 + bpp);
    rows.push(row);
  }
  const none = Buffer.alloc(stride);
  const packed: Buffer[] = [];
  rows.forEach((row, y) => {
    const above = y === 0 ? none : rows[y - 1]!;
    let best: Buffer | null = null;
    let bestCost = Infinity;
    for (let filter = 0; filter < 5; filter++) {
      const line = Buffer.alloc(stride + 1);
      line[0] = filter;
      let cost = 0;
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? row[i - bpp]! : 0;
        const up = above[i]!;
        const upLeft = i >= bpp ? above[i - bpp]! : 0;
        let predicted = 0;
        if (filter === 1) predicted = left;
        else if (filter === 2) predicted = up;
        else if (filter === 3) predicted = (left + up) >> 1;
        else if (filter === 4) {
          const p = left + up - upLeft;
          const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
          predicted = a <= b && a <= c ? left : b <= c ? up : upLeft;
        }
        const value = (row[i]! - predicted) & 0xff;
        line[i + 1] = value;
        cost += value < 128 ? value : 256 - value;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = line;
      }
    }
    packed.push(best!);
  });
  const chunk = (kind: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(kind, "latin1"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body) >>> 0, 8 + data.length);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.writeUInt8(8, 8);
  head.writeUInt8(opaque ? 2 : 6, 9);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", zlib.deflateSync(Buffer.concat(packed), { level: 9, memLevel: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const icons = [await icon(32, "favicon-32.png", TAB_ICON_AIR), await icon(180, "apple-touch-icon.png", ICON_AIR), await icon(192, "icon-192.png", ICON_AIR), await icon(512, "icon-512.png", ICON_AIR)];
const inIco = [await icon(16, "16", TAB_ICON_AIR, SMALLEST_OUTLINE), await icon(32, "32", TAB_ICON_AIR), await icon(48, "48", TAB_ICON_AIR)];
await browser.close();

fs.mkdirSync(path.join(PUBLIC, "brand"), { recursive: true });
fs.writeFileSync(path.join(PUBLIC, "brand", "emblem.svg"), emblem);
for (const made of icons) fs.writeFileSync(path.join(PUBLIC, made.name), made.png);

// favicon.ico: a small header, one line of 16 bytes for each picture, then the pictures themselves, each a PNG.
const pictures = inIco.map((made) => made.png);
const header = Buffer.alloc(6 + 16 * pictures.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pictures.length, 4);
let offset = header.length;
inIco.forEach((made, index) => {
  const at = 6 + 16 * index;
  header.writeUInt8(made.size, at);
  header.writeUInt8(made.size, at + 1);
  header.writeUInt8(0, at + 2);
  header.writeUInt8(0, at + 3);
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(pictures[index]!.length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += pictures[index]!.length;
});
fs.writeFileSync(path.join(PUBLIC, "favicon.ico"), Buffer.concat([header, ...pictures]));

// The manifest: the paper's colour, which is the icons' own ground.
const manifest = {
  name: "SaplingDex",
  short_name: "SaplingDex",
  start_url: "/",
  display: "browser",
  theme_color: paper,
  background_color: paper,
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
  ],
};
fs.writeFileSync(path.join(PUBLIC, "site.webmanifest"), `${JSON.stringify(manifest, null, 2)}\n`);

const kb = (file: string) => `${(fs.statSync(path.join(PUBLIC, file)).size / 1024).toFixed(1)} KB`;
console.log(`make-brand: the emblem in ${ink} on ${paper}`);
console.log(`  brand/emblem.svg  ${kb(path.join("brand", "emblem.svg"))}`);
for (const made of icons) console.log(`  ${made.name}  ${made.size} x ${made.size}  ${kb(made.name)}`);
console.log(`  favicon.ico  ${inIco.map((made) => made.size).join(", ")}  ${kb("favicon.ico")}`);
console.log(`  site.webmanifest  ${paper}`);
