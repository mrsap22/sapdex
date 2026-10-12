// The emblem and the site's icons. The emblem is two leaves curving round each other, supplied as a
// photograph of it pressed into paper; a flat vector traced from that photograph is the one source
// every size is made from. It stands beside the name in the header and the footer in the text's
// own colour, and is the browser tab's and the home screen's picture in ink on paper.

import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { requestPath, securityHeaders } from "../server/http.ts";
import { loadStaticSite } from "../server/static.ts";
import { Mark, Wordmark } from "../web/src/components/Brand.tsx";

const PUBLIC = path.resolve("web", "public");
const SOURCES = path.resolve("web", "src", "assets", "brand");
const file = (name: string) => fs.readFileSync(path.join(PUBLIC, name));

/** The size of a PNG and whether any of it can be see-through, from its first chunk. */
function pngHead(png: Buffer): { width: number; height: number; alpha: boolean } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), alpha: png[25] === 4 || png[25] === 6 };
}

/** The pixels of a PNG with three bytes to a pixel, as this project writes its icons. */
function pngPixels(png: Buffer): { width: number; height: number; at(x: number, y: number): [number, number, number] } {
  const { width, height } = pngHead(png);
  expect([png[24], png[25]]).toEqual([8, 2]);
  const data: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const size = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT") data.push(png.subarray(at + 8, at + 8 + size));
    at += 12 + size;
  }
  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = width * 3;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const left = i >= 3 ? out[y * stride + i - 3]! : 0;
      const up = y > 0 ? out[(y - 1) * stride + i]! : 0;
      const upLeft = y > 0 && i >= 3 ? out[(y - 1) * stride + i - 3]! : 0;
      const p = left + up - upLeft;
      const paeth = Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - upLeft) ? left : Math.abs(p - up) <= Math.abs(p - upLeft) ? up : upLeft;
      const predicted = [0, left, up, (left + up) >> 1, paeth][filter]!;
      out[y * stride + i] = (raw[y * (stride + 1) + 1 + i]! + predicted) & 0xff;
    }
  }
  return { width, height, at: (x, y) => [out[y * stride + x * 3]!, out[y * stride + x * 3 + 1]!, out[y * stride + x * 3 + 2]!] };
}

describe("the supplied artwork", () => {
  it("is kept in the project: the photograph as it was supplied, and the one vector traced from it", () => {
    const print = (name: string) => createHash("sha256").update(fs.readFileSync(path.join(SOURCES, name))).digest("hex");
    expect(fs.readdirSync(SOURCES).sort()).toEqual(["emblem-photo.png", "emblem.svg"]);
    expect(print("emblem-photo.png")).toBe("608c2ebe146a71826061c9ed30763950a17cfecc31ad74c3c3e52e38d3de12ab");
    expect(print("emblem.svg")).toBe("0f911b9a3584e750c3f2656b423865ee1a5250820729cd3b9d314a72ac37adb2");
    expect(pngHead(fs.readFileSync(path.join(SOURCES, "emblem-photo.png")))).toMatchObject({ width: 500, height: 500 });
  });

  it("the vector is one flat shape in one colour on no ground: no gradient, no outline, no second colour, nothing but the path", () => {
    const svg = fs.readFileSync(path.join(SOURCES, "emblem.svg"), "utf8");
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 100 100"><path fill="currentColor" d="[MCZ0-9 .-]+"\/><\/svg>\n$/);
    // Two pieces, and the second is the first turned half round about the middle, to the hundredth: the two leaves are one leaf twice.
    const pieces = /d="([^"]+)"/.exec(svg)![1]!.split("Z").filter((piece) => piece !== "");
    expect(pieces).toHaveLength(2);
    const numbers = (piece: string) => (piece.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    const [first, second] = [numbers(pieces[0]!), numbers(pieces[1]!)];
    expect(first.length).toBeGreaterThan(200);
    expect(second).toHaveLength(first.length);
    first.forEach((value, index) => expect(Math.abs(value + second[index]! - 100), String(index)).toBeLessThan(0.011));
    // It fills its square and stays inside it.
    expect(Math.min(...first, ...second)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...first, ...second)).toBeLessThanOrEqual(100);
    expect(Math.max(...first, ...second) - Math.min(...first, ...second)).toBeGreaterThan(95);
  });

  it("is only drawn at each size by the script that makes the icons, in the ink and paper of the design tokens: no effect, no other colour", () => {
    const script = fs.readFileSync(path.resolve("scripts", "make-brand.ts"), "utf8");
    for (const never of [/\.filter\s*=/, /globalCompositeOperation/, /shadowBlur|shadowColor/, /fillText/, /putImageData/, /hue-rotate|invert\(|brightness\(|contrast\(|saturate\(/, /gradient/i, /#[0-9a-fA-F]{6}\b(?!\})/]) expect(script, String(never)).not.toMatch(never);
    expect(script).toContain("--bg:");
    expect(script).toContain("--text:");
    // The one thing done for size: a hair of outline in the same ink, for the 16 px picture alone.
    expect(script.match(/SMALLEST_OUTLINE\)/g)).toHaveLength(1);
    expect(script).toContain('await icon(16, "16", TAB_ICON_AIR, SMALLEST_OUTLINE)');
  });
});

describe("the emblem on the site", () => {
  it("the site serves its own copy of the vector, the same file as the source", () => {
    expect(fs.readdirSync(path.join(PUBLIC, "brand"))).toEqual(["emblem.svg"]);
    expect(file("brand/emblem.svg").equals(fs.readFileSync(path.join(SOURCES, "emblem.svg")))).toBe(true);
    expect(file("brand/emblem.svg").length).toBeLessThan(16 * 1024);
  });

  it("stands to the left of the name, in the text's own colour, and the name stays one word in one colour, linking home", () => {
    const drawn = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element).replace(/<link rel="preload"[^>]*>/g, "");
    expect(drawn(createElement(Wordmark))).toBe('<a class="wordmark" href="/" aria-label="SaplingDex, home"><span class="mark" aria-hidden="true"></span><span class="wordmark-text">SaplingDex</span></a>');
    expect(drawn(createElement(Mark))).toBe('<span class="mark" aria-hidden="true"></span>');
    // In the site's own sans at its firmest weight, upright: never the italic serif of the headlines.
    const css = fs.readFileSync(path.resolve("web", "src", "styles", "shell.css"), "utf8");
    const rule = /\n\.wordmark \{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(rule).toMatch(/font-weight: var\(--weight-600\);/);
    expect(rule).toMatch(/color: var\(--text\);/);
    expect(rule).not.toMatch(/font-family|font-style/);
    // The name is always shown.
    expect(css).not.toMatch(/\.wordmark-text \{[^}]*display: none/);
    // The emblem is the site's own file, filled with whatever colour the text beside it has: right in both themes, with no second picture.
    const mark = /\n\.mark \{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(mark).toMatch(/background: currentColor;/);
    expect(mark).toContain('\n  mask: url("/brand/emblem.svg") center / contain no-repeat;');
    expect(mark).toMatch(/width: var\(--height-24\);\s*height: var\(--height-24\);/);
    expect(css.match(/emblem\.svg/g)).toHaveLength(2);
  });

  it("is the one mark in the header and the footer of every page", () => {
    const shell = fs.readFileSync(path.resolve("web", "src", "components", "Shell.tsx"), "utf8");
    expect(shell.match(/<Wordmark \/>/g)).toHaveLength(2);
    // One header and one footer for every page: the Docs, the Terms and the Privacy Policy have no other.
    const app = fs.readFileSync(path.resolve("web", "src", "App.tsx"), "utf8");
    expect(app).toMatch(/<Header \/>/);
    expect(app.match(/<Footer \/>/g)?.length).toBeGreaterThanOrEqual(1);
    const everything = ["web/src", "web/index.html", "web/public", "server", "shared", "scripts"].flatMap((root) => {
      const full = path.resolve(root);
      return fs.statSync(full).isDirectory() ? (fs.readdirSync(full, { recursive: true }) as string[]).map((name) => path.join(full, name)).filter((name) => fs.statSync(name).isFile()) : [full];
    });
    expect(everything.length).toBeGreaterThan(150);
    for (const name of everything) {
      expect(path.basename(name), name).not.toMatch(/^favicon-(dark|light)\.svg$|^make-icons\.ts$/);
      if (!/\.(tsx?|css|html|json|webmanifest|svg|mjs)$/.test(name)) continue;
      const text = fs.readFileSync(name, "utf8");
      // One favicon for both themes: none made for one of them.
      expect(text, name).not.toMatch(/favicon-dark|favicon-light/);
    }
  });
});

describe("the favicon, the home-screen icons and the manifest", () => {
  it("favicon.ico holds 16, 32 and 48 px, and the PNG icons are 32, 180, 192 and 512 px", () => {
    const ico = file("favicon.ico");
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 3]);
    const inside = [0, 1, 2].map((index) => {
      const at = 6 + 16 * index;
      const picture = ico.subarray(ico.readUInt32LE(at + 12), ico.readUInt32LE(at + 12) + ico.readUInt32LE(at + 8));
      expect(pngHead(picture)).toEqual({ width: ico[at]!, height: ico[at + 1]!, alpha: false });
      return ico[at];
    });
    expect(inside).toEqual([16, 32, 48]);
    for (const [name, size] of [["favicon-32.png", 32], ["apple-touch-icon.png", 180], ["icon-192.png", 192], ["icon-512.png", 512]] as const) expect(pngHead(file(name)), name).toEqual({ width: size, height: size, alpha: false });
  });

  it("the emblem is ink on paper, fills the small square and is not cut: the paper runs round every edge, and the emblem spans most of the width", () => {
    const hex = ([r, g, b]: [number, number, number]) => `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    for (const name of ["favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png"]) {
      const { width, height, at } = pngPixels(file(name));
      // The ground is the paper of the design tokens, and the darkest pixel is their ink: no third colour is brought in.
      expect(hex(at(0, 0)), name).toBe("#eef0f7");
      const inked = (x: number, y: number) => Math.max(...at(x, y)) <= Math.max(...at(0, 0)) - 60;
      for (let i = 0; i < width; i++) for (const [x, y] of [[i, 0], [i, height - 1], [0, i], [width - 1, i]] as const) expect(inked(x, y), `${name} ${x},${y}`).toBe(false);
      const columns = [...Array(width).keys()].filter((x) => [...Array(height).keys()].some((y) => inked(x, y)));
      expect((columns.at(-1)! - columns[0]! + 1) / width, name).toBeGreaterThan(0.68);
      const seen = new Set<string>();
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) seen.add(hex(at(x, y)));
      expect(seen.has("#141a55"), name).toBe(true);
      // Turned half round it is the same picture (to a soft edge): two leaves, one the other's turn.
      let differ = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (inked(x, y) !== inked(width - 1 - x, height - 1 - y)) differ += 1;
      expect(differ / (width * height), name).toBeLessThan(0.02);
    }
  });

  it("the manifest names the site, its two large icons, and the page's own colour from the design tokens", () => {
    const tokens = fs.readFileSync(path.resolve("web", "src", "styles", "tokens.css"), "utf8");
    // The icons' own ground: the paper.
    const page = /\n:root,\n:root\[data-theme="light"\] \{[\s\S]*?--bg: (#[0-9a-f]{6});/.exec(tokens)?.[1];
    expect(page).toBe("#eef0f7");
    expect(JSON.parse(file("site.webmanifest").toString("utf8"))).toEqual({
      name: "SaplingDex",
      short_name: "SaplingDex",
      start_url: "/",
      display: "browser",
      theme_color: page,
      background_color: page,
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    });
  });

  it("the page's head names them, one favicon for both themes, and nothing at another address", () => {
    const html = fs.readFileSync(path.resolve("web", "index.html"), "utf8");
    const links = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon|manifest)"[^>]*>/g)].map((match) => match[0]);
    expect(links).toEqual([
      '<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />',
      '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />',
      '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />',
      '<link rel="manifest" href="/site.webmanifest" />',
    ]);
    expect(html).not.toMatch(/prefers-color-scheme[^>]*favicon|image\/svg\+xml/);
    for (const address of html.matchAll(/(?:href|src|content)="([a-z]+:)?\/\/[^"]*"/g)) expect(address[0]).toBe("");
  });

  it("the site itself serves every one of them, each as what it is, and its content-security policy lets pictures come from this site only", async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "saplingdex-brand-"));
    fs.cpSync(PUBLIC, dist, { recursive: true });
    fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>");
    const site = loadStaticSite(dist)!;
    const server = http.createServer((req, res) => void site.handle(req, res, requestPath(req) ?? "/"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const wanted: [string, string][] = [
        ["/favicon.ico", "image/x-icon"],
        ["/favicon-32.png", "image/png"],
        ["/apple-touch-icon.png", "image/png"],
        ["/icon-192.png", "image/png"],
        ["/icon-512.png", "image/png"],
        ["/site.webmanifest", "application/manifest+json; charset=utf-8"],
        ["/brand/emblem.svg", "image/svg+xml"],
      ];
      for (const [address, type] of wanted) {
        const reply = await fetch(base + address);
        expect(reply.status, address).toBe(200);
        expect(reply.headers.get("content-type"), address).toBe(type);
        expect(Buffer.from(await reply.arrayBuffer()).equals(file(address)), address).toBe(true);
        // Pictures are kept for a day; the manifest is asked for afresh.
        expect(reply.headers.get("cache-control"), address).toBe(address.endsWith(".webmanifest") ? "no-cache" : "public, max-age=86400");
      }
    } finally {
      server.close();
      fs.rmSync(dist, { recursive: true, force: true });
    }
    // Pictures and the manifest come from this site only: the policy that says so was not touched for the logo.
    const policy = securityHeaders({ scriptHashes: [] })["Content-Security-Policy"] ?? "";
    expect(policy).toContain("img-src 'self' data:;");
    expect(policy).toContain("manifest-src 'self'");
    expect(policy).not.toMatch(/https?:\/\/[^ ;]*(image|cdn)/i);
  });
});
