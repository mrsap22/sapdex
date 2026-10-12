// Entry point. Validates configuration, builds the server and starts it.
// Any bad setting stops the process before it listens.

import { boot } from "./boot.ts";
import { ConfigError } from "./config.ts";
import { cannotStart, createLogger, errorKind } from "./log.ts";

const log = createLogger();

function main(): void {
  let app;
  try {
    app = boot({ log });
  } catch (err) {
    // The message names the setting and what is wrong with it, never its value.
    const problem = err instanceof ConfigError ? err.message : "DATA_DIR: cannot be created or written to";
    log.error("config_invalid", { problem });
    // And once in plain words, on the error stream, where a host's log viewer shows it whatever it makes of the line above.
    process.stderr.write(`${cannotStart(problem)}\n`);
    process.exit(1);
  }

  app.start();

  const shutdown = (signal: string) => {
    log.info("stopping", { signal });
    app.stop(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled_rejection", { kind: errorKind(reason) });
  });
}

main();
