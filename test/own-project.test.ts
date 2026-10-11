import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// This project started from the code of another site. Nothing of that site is left in it by name:
// not its name, its domain, its accounts, its repository, or the addresses it used as examples.
//
// Each thing looked for is put together from parts, so that this file does not hold what it
// looks for.

const join = (...parts: string[]) => parts.join("");

/** What is never written, each with a few words for the message when it is found. Letters are matched in either case. */
const NEVER: readonly (readonly [string, RegExp])[] = [
  ["the other site's name", new RegExp(join("intent", "swap"), "i")],
  ["the other site's account on X", new RegExp(join("x\\.com/", "intent"), "i")],
  ["the other site's ticker", new RegExp(join("\\$", "INT", "\\b"))],
  ["the pair the other site's token traded in", new RegExp(join("ae001c67", "dbdc649e76bd8f41a75d", "1d154423d8ad"), "i")],
  ["a wallet the other site used as its example", new RegExp(join("b5590d9f", "e0d0902ebe80d5191dce", "a6fc4d35ec83"), "i")],
];

/** One line of each kind, in the order of the list above. */
const CAUGHT = [
  join("Sign in to Intent", "Swap at example.org."),
  join("https://x.c", "om/int", "entswap_"),
  join("Shows the $", "INT section when set"),
  join("0xAE001C67", "DbdC649e76BD8f41A75D", "1D154423D8aD"),
  join("0xb5590d9F", "E0D0902ebe80D5191DCe", "A6Fc4D35eC83"),
];

/** Lines of this project's own, and words that only look alike. */
const PLAIN = ["Sign in to SaplingDex at example.org.", "Powered by NEAR Intents", "an intent to swap", "$INTEREST", "parseInt(value, 10)", "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB"];

/** Every file of this project that git keeps or would keep (nothing it is told to ignore), by its path from the top. */
const tracked = () => execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: path.resolve("."), encoding: "utf8" }).split("\0").filter((name) => name !== "");
const TEXT = /\.(?:ts|tsx|mts|mjs|js|css|html|md|json|ya?ml|txt|svg|webmanifest|example)$|^\.(?:gitignore|npmrc)$/;
const found = (text: string) => NEVER.flatMap(([what, pattern]) => (pattern.test(text) ? [what] : []));

describe("this is its own project: nothing of the site its code started from is left in it", () => {
  it("is a check that can fail: each pattern finds a line of its kind, and leaves this project's own lines alone", () => {
    expect(CAUGHT).toHaveLength(NEVER.length);
    NEVER.forEach(([what], index) => expect(found(CAUGHT[index]!), what).toContain(what));
    for (const line of PLAIN) expect(found(line), line).toEqual([]);
  });

  it("holds in every file the repository keeps, and in every file's name", () => {
    const files = tracked();
    // The list reaches what it should: the code, the pages, the tests (this one among them), the scripts and the settings' notes.
    for (const expected of ["README.md", ".env.example", "package.json", "package-lock.json", "web/index.html", "web/public/site.webmanifest", "server/config.ts", "shared/rewards.ts", "scripts/mutation-check.ts", "test/own-project.test.ts", ".github/workflows/ci.yml"]) {
      expect(files, expected).toContain(expected);
    }
    expect(files.length).toBeGreaterThan(300);
    const hits: string[] = [];
    for (const file of files) {
      for (const what of found(file)) hits.push(`${file}: ${what}, in its name`);
      if (!TEXT.test(file) || !fs.existsSync(file)) continue;
      for (const what of found(fs.readFileSync(file, "utf8"))) hits.push(`${file}: ${what}`);
    }
    expect(hits).toEqual([]);
  });

  it("names itself, and no address is written in for it: where the site is reached is a setting", () => {
    expect(JSON.parse(fs.readFileSync("package.json", "utf8")).name).toBe("saplingdex");
    expect(JSON.parse(fs.readFileSync(path.join("web", "public", "site.webmanifest"), "utf8"))).toMatchObject({ name: "SaplingDex", short_name: "SaplingDex" });
    // The only addresses with this project's name in them are made-up ones on the reserved "example" domain, in tests and scripts.
    for (const file of tracked()) {
      if (!TEXT.test(file) || !fs.existsSync(file)) continue;
      for (const match of fs.readFileSync(file, "utf8").matchAll(/saplingdex\.([a-z]{2,})\b/g)) expect(["example", "near"], `${file}: ${match[0]}`).toContain(match[1]);
    }
  });
});
