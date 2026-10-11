import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The one time this site speaks to a wallet is the sign-in of the Rewards page: one plain message,
// signed by a Solana wallet. The code that does it must never be within reach of the swap flow, or
// of any page but the Rewards page. Other tests hold that by looking for names in files. This one
// follows the site's own imports, file to file, so that a new file placed between the two cannot hide it.

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

describe("the sign-in's wallet code is out of the swap flow's reach, by the site's own imports", () => {
  const signIn = at("solana/sign-in.ts");
  const steps = at("lib/sign-in-logic.ts");

  it("reads the imports it is meant to read", () => {
    // If the pattern stopped finding imports, everything below would pass for nothing.
    expect(all.length).toBeGreaterThan(40);
    expect(importersOf(at("stores/swap.ts")).length).toBeGreaterThan(2);
    expect(reach(at("App.tsx")).has(signIn)).toBe(true);
    expect((graph.get(at("App.tsx")) ?? []).map(name)).toContain("pages/RewardsPage.tsx");
  });

  it("every import of the site's own files is followed, however it is written", () => {
    expect(lost).toEqual([]);
    // With its ending, without it, and as a folder: each spelling leads to the same file.
    const here = at("stores/rewards.ts");
    expect(resolveImport(here, "../solana/sign-in.ts")).toBe(signIn);
    expect(resolveImport(here, "../solana/sign-in")).toBe(signIn);
    expect(resolveImport(here, "../solana/no-such-file")).toBeNull();
    expect(resolveImport(here, "../lib")).toBeNull();
  });

  it("the code that listens for wallets is imported by the Rewards page's own store, and by nothing else; and only as it goes, when sign-in is pressed", () => {
    expect(importersOf(signIn)).toEqual(["stores/rewards.ts"]);
    const store = fs.readFileSync(at("stores/rewards.ts"), "utf8");
    // Fetched when asked for, inside the sign-in, and never named at the top of the file.
    expect(store).toMatch(/await import\("\.\.\/solana\/sign-in\.ts"\)/);
    expect(store).not.toMatch(/^import [^\n]*solana\/sign-in/m);
    // It is the one folder of wallet code there is, and it holds that one file.
    expect(fs.readdirSync(at("solana"))).toEqual(["sign-in.ts"]);
    expect(fs.existsSync(at("wallet"))).toBe(false);
  });

  it("the steps of the sign-in are used by that store and by the code that listens for wallets, and by nothing else", () => {
    expect(importersOf(steps)).toEqual(["solana/sign-in.ts", "stores/rewards.ts"]);
  });

  it("that store is imported by the Rewards page, and by nothing else", () => {
    expect(importersOf(at("stores/rewards.ts"))).toEqual(["pages/RewardsPage.tsx"]);
  });

  it("the Rewards page is imported by the app's own frame, and by nothing else", () => {
    expect(importersOf(at("pages/RewardsPage.tsx"))).toEqual(["App.tsx"]);
  });

  it.each(["pages/SwapPage.tsx", "pages/OrderPage.tsx", "pages/TrackPage.tsx", "pages/StatsPage.tsx", "pages/DocsPage.tsx", "pages/LegalPages.tsx", "components/SwapCard.tsx", "components/ReviewSheet.tsx", "components/CoinPicker.tsx", "components/Home.tsx", "components/Shell.tsx", "stores/swap.ts", "stores/ghost.ts", "stores/orders.ts", "stores/app.ts"])("nothing %s reaches, however far, is the wallet code, the steps of the sign-in, its store or the Rewards page", (start) => {
    const reached = reach(at(start));
    for (const fenced of [signIn, steps, at("stores/rewards.ts"), at("pages/RewardsPage.tsx")]) expect(reached.has(fenced), `${start} reaches ${name(fenced)}`).toBe(false);
  });

  it("no other file of the site asks a wallet for anything: not to connect, not to sign", () => {
    const askers = all.filter((file) => /\bsignMessage\b|wallet-standard|standard:connect|window\.solana|window\.ethereum|\.request\(\{|personal_sign|eth_sign|eth_requestAccounts/.test(fs.readFileSync(file, "utf8"))).map(name).sort();
    expect(askers).toEqual(["lib/sign-in-logic.ts", "solana/sign-in.ts"]);
  });

  it("nothing anywhere in the site asks a wallet to sign or send a transaction, or names a feature that would", () => {
    const never = /signTransaction|signAndSendTransaction|signAllTransactions|sendTransaction|solana:signIn|eth_sendTransaction|signTypedData/;
    expect(all.filter((file) => never.test(fs.readFileSync(file, "utf8"))).map(name)).toEqual([]);
    // The two things a wallet is asked, by the names the standard gives them, and no third.
    const logic = fs.readFileSync(steps, "utf8");
    expect([...new Set([...logic.matchAll(/"((?:standard|solana):[A-Za-z]+)"/g)].map((match) => match[1]))].sort()).toEqual(["solana:mainnet", "solana:signMessage", "standard:connect"]);
  });

  it("the wallet code loads no library and asks no address for anything", () => {
    for (const file of [signIn, steps]) {
      const text = fs.readFileSync(file, "utf8");
      // Its only imports are the site's own files and the small base58 library the address check already uses.
      const imports = [...text.matchAll(/\bfrom\s*"([^"]+)"/g)].map((match) => match[1]!);
      for (const target of imports) expect(target.startsWith(".") || target === "@scure/base", `${name(file)} imports ${target}`).toBe(true);
      expect(text, name(file)).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|https?:\/\//);
      expect(text, name(file)).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    }
  });

  it("no wallet-connect library is among the project's packages", () => {
    const packages = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const names = [...Object.keys(packages.dependencies), ...Object.keys(packages.devDependencies)];
    expect(names.filter((one) => /reown|walletconnect|wagmi|viem|web3modal|appkit|ethers|web3|solana\/wallet-adapter|wallet-standard/i.test(one))).toEqual([]);
  });
});
