// A setting that stops the start says so where nobody can miss it: one plain line on the error
// stream, in words, with the setting's name and what is wrong with it, and never its value. And
// every line of the log carries its event's name as its message, which is the field a host's log
// viewer shows and searches.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cannotStart, createLogger } from "../server/log.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saplingdex-start-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

// Made up for this test: a key of the right shape, and values that are wrong in ways a person might get them wrong.
const KEY = ["practicekey", "practicekey", "practicekey"].join(".");
const BASE = { NODE_ENV: "production", DATA_DIR: dir, TRUST_PROXY_HOPS: "1", PORT: "24681", ONECLICK_API_KEY: KEY };

/** The server, started as the host starts it, with these settings and no others. It is expected to stop by itself. */
function start(env: Record<string, string>): { status: number | null; out: string; err: string } {
  const run = spawnSync(process.execPath, ["--import", "tsx", path.join("server", "index.ts")], { cwd: path.resolve("."), env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 30_000 });
  return { status: run.status, out: run.stdout, err: run.stderr };
}

describe("a setting that stops the start", () => {
  it("is said in one plain line on the error stream: swaps switched on with nobody to write to", () => {
    const run = start({ ...BASE, SWAPS_PAUSED: "false" });
    expect(run.status).toBe(1);
    expect(run.err.trim().split("\n")).toEqual(["SaplingDex cannot start. SUPPORT_CONTACT: is required before swaps are switched on (SWAPS_PAUSED=false): people need someone to write to when a swap fails"]);
    // The log's own line is there too, on the other stream, and a search for its event finds it by its message.
    const line = JSON.parse(run.out.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
    expect(line).toMatchObject({ level: "error", event: "config_invalid", message: "config_invalid", problem: "SUPPORT_CONTACT: is required before swaps are switched on (SWAPS_PAUSED=false): people need someone to write to when a swap fails" });
  });

  it("names the setting and never carries its value, whatever the value is", () => {
    const wrong: [string, string][] = [
      ["ONECLICK_API_KEY", "not-a-key-but-a-secret-all-the-same"],
      ["BASE_RPC_URL", "http://node.example.org/a-secret-path"],
      ["TOKEN_ADDRESS", "0x52908400098527886E0F7030069857D2E4169EE7"],
      ["SITE_URL", "https://example.org/some/path?with=things"],
      ["SUPPORT_CONTACT", "somebody who is not an address"],
      ["ZEC_SHIELDED", "certainly"],
    ];
    for (const [name, value] of wrong) {
      const run = start({ ...BASE, [name]: value });
      expect(run.status, name).toBe(1);
      const said = run.err.trim();
      expect(said.split("\n"), name).toHaveLength(1);
      expect(said.startsWith(`SaplingDex cannot start. ${name}: `), `${name}: ${said}`).toBe(true);
      for (const stream of [run.err, run.out]) expect(stream.includes(value), name).toBe(false);
      // Nor the key, which was set rightly beside it.
      if (name !== "ONECLICK_API_KEY") for (const stream of [run.err, run.out]) expect(stream.includes(KEY), name).toBe(false);
    }
  }, 120_000);

  it("is one line whatever the reason looks like", () => {
    expect(cannotStart("SUPPORT_CONTACT: is required")).toBe("SaplingDex cannot start. SUPPORT_CONTACT: is required");
    expect(cannotStart("DATA_DIR:\n  cannot be created\n")).toBe("SaplingDex cannot start. DATA_DIR: cannot be created");
  });
});

describe("every line of the log", () => {
  it("carries its event's name as its message, and no field can put anything else there", () => {
    const lines: string[] = [];
    const log = createLogger((line) => lines.push(line));
    log.info("listening", { port: 1 });
    log.warn("alert", { kind: "disk" });
    log.error("config_invalid", { problem: "X: is wrong", message: "something a field tried to say" });
    const read = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(read.map((line) => [line.level, line.event, line.message])).toEqual([
      ["info", "listening", "listening"],
      ["warn", "alert", "alert"],
      ["error", "config_invalid", "config_invalid"],
    ]);
    // Nothing else about a line changed: what was logged is still there, each line is one line of JSON.
    expect(read[0]).toMatchObject({ port: 1 });
    expect(read[2]).toMatchObject({ problem: "X: is wrong" });
    for (const line of lines) expect(line).not.toContain("\n");
  });
});
