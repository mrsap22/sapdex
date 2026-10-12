import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// This site never speaks to a wallet: no page of it asks one to be found, to connect or to sign.
// Other tests hold that by looking for names in files. This one follows the site's own imports,
// file to file, from every page and from the site's first file, so that nothing a page reaches,
// however far, can be code that would.

const root = path.resolve("web", "src");
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(dir, entry.name)] : []));
const name = (file: string) => path.relative(root, file).split(path.sep).join("/");

/** Imports that lead to no file of the site, by any spelling. There must be none: one that is not followed is a way round the fence. */
const lost: string[] = [];

/** Where an import leads, however it is written: with its ending, without it, or as a folder with an index file. Stylesheets and the like are not code and are left out. */
function resolveImport(from: string, target: string): string | null {
  const base = path.resolve(path.dirname(from), target);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every file of the site that a file imports, whether at the top or as it goes (`import("...")`). Packages are left out. */
function importsOf(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)) {
    const target = match[1]!;
    if (!target.startsWith(".")) continue;
    const resolved = resolveImport(file, target);
    if (resolved === null) lost.push(`${name(file)} imports "${target}"`);
    else if (/\.tsx?$/.test(resolved) && resolved.startsWith(root + path.sep)) found.add(resolved);
  }
  return [...found];
}

const all = files(root);
const graph = new Map(all.map((file) => [file, importsOf(file)]));
const importersOf = (target: string) => all.filter((file) => (graph.get(file) ?? []).includes(target)).map(name).sort();
/** Everything a file reaches by following imports, itself included. */
function reach(start: string): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    for (const next of graph.get(queue.pop()!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}
const at = (relative: string) => path.join(root, ...relative.split("/"));

/** Whatever a file would need to find a wallet, to connect to one, or to ask one to sign or send anything. */
const ASKS_A_WALLET = /\bsignMessage\b|wallet-standard|standard:connect|solana:sign|window\.solana|window\.ethereum|\.request\(\{|personal_sign|eth_sign|eth_requestAccounts|signTransaction|signAndSendTransaction|signAllTransactions|sendTransaction|solana:signIn|eth_sendTransaction|signTypedData/;
const asksAWallet = (file: string) => ASKS_A_WALLET.test(fs.readFileSync(file, "utf8"));

describe("no wallet code is within anything's reach, by the site's own imports", () => {
  it("reads the imports it is meant to read", () => {
    // If the pattern stopped finding imports, everything below would pass for nothing.
    expect(all.length).toBeGreaterThan(40);
    expect(importersOf(at("stores/swap.ts")).length).toBeGreaterThan(2);
    expect(reach(at("App.tsx")).has(at("pages/OrderPage.tsx"))).toBe(true);
    expect(reach(at("App.tsx")).has(at("components/ReviewSheet.tsx"))).toBe(true);
    expect((graph.get(at("App.tsx")) ?? []).map(name)).toContain("pages/StatsPage.tsx");
    // From the site's first file every file of the site is reached but the type declarations nothing imports.
    const first = reach(at("main.tsx"));
    expect(all.filter((file) => !first.has(file)).map(name)).toEqual(["vite-env.d.ts"]);
  });

  it("every import of the site's own files is followed, however it is written", () => {
    expect(lost).toEqual([]);
    // With its ending, without it, and as a folder: each spelling leads to the same file.
    const here = at("stores/swap.ts");
    const there = at("lib/swap-logic.ts");
    expect(resolveImport(here, "../lib/swap-logic.ts")).toBe(there);
    expect(resolveImport(here, "../lib/swap-logic")).toBe(there);
    expect(resolveImport(here, "../lib/no-such-file")).toBeNull();
    expect(resolveImport(here, "../lib")).toBeNull();
  });

  it("there is no folder of wallet code, and no file that fetches any as it goes", () => {
    for (const folder of ["solana", "wallet", "wallets"]) expect(fs.existsSync(at(folder)), folder).toBe(false);
    const late = all.flatMap((file) => [...fs.readFileSync(file, "utf8").matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((match) => `${name(file)} -> ${match[1]}`));
    // What is fetched as it goes is pages and the review, and nothing else.
    expect(late.length).toBeGreaterThan(4);
    expect(late.filter((one) => !/-> \.\.?\/(?:pages|components)\/[A-Za-z]+\.tsx$/.test(one))).toEqual([]);
    expect(late.filter((one) => /wallet|solana|sign-in/i.test(one))).toEqual([]);
  });

  it.each(["main.tsx", "App.tsx", "pages/SwapPage.tsx", "pages/OrderPage.tsx", "pages/TrackPage.tsx", "pages/StatsPage.tsx", "pages/DocsPage.tsx", "pages/LegalPages.tsx", "components/SwapCard.tsx", "components/ReviewSheet.tsx", "components/CoinPicker.tsx", "components/Home.tsx", "components/Shell.tsx", "stores/swap.ts", "stores/ghost.ts", "stores/orders.ts", "stores/app.ts"])("nothing %s reaches, however far, asks a wallet for anything", (start) => {
    const reached = [...reach(at(start))];
    expect(reached.length).toBeGreaterThan(0);
    expect(reached.filter(asksAWallet).map(name)).toEqual([]);
  });

  it("no file of the site asks a wallet for anything: not to be found, not to connect, not to sign, not to send", () => {
    expect(all.filter(asksAWallet).map(name)).toEqual([]);
    // The check is one that can fail: each of the ways a page would ask is found.
    for (const sample of ['window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }))', 'wallet.features["standard:connect"].connect()', 'wallet.features["solana:signMessage"].signMessage({ account, message })', "await window.ethereum.request({ method })", 'provider.request({ method: "personal_sign" })', "await provider.signAndSendTransaction(tx)", "window.solana.connect()"]) expect(ASKS_A_WALLET.test(sample), sample).toBe(true);
    // And the site's own words about wallets are not taken for it.
    for (const plain of ["The site connects to no wallet.", "from any wallet", "isWalletChain(chain)", "A contract, not a wallet."]) expect(ASKS_A_WALLET.test(plain), plain).toBe(false);
  });

  it("no wallet-connect library is among the project's packages", () => {
    const packages = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const names = [...Object.keys(packages.dependencies), ...Object.keys(packages.devDependencies)];
    expect(names.filter((one) => /reown|walletconnect|wagmi|viem|web3modal|appkit|ethers|web3|solana\/wallet-adapter|wallet-standard/i.test(one))).toEqual([]);
  });
});
