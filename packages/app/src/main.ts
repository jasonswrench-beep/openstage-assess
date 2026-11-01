#!/usr/bin/env node
/**
 * Starts the OpenAssess app: the server, and, when asked, a browser window pointed at it.
 *
 *   --open                      open the app in the default browser
 *   --home <folder>             where banks and exports live (default: Documents/OpenAssess)
 *   --port <n>                  a fixed port (default: any free one)
 *   --exit-when-stdin-closes    stop when whatever started this stops, which is how the desktop window keeps the server
 *                               from outliving it
 *   --log-requests              print a line for each request, for finding out why a start went wrong
 *
 * The line "OPENASSESS_READY <address>" is printed once the server is listening. The desktop window reads it to know where
 * to point itself.
 */

import { spawn } from "node:child_process";

import { PRODUCT_NAME } from "./engine.ts";
import { startServer } from "./server.ts";

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};

function openInBrowser(address: string): void {
  const [command, list] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", address]]
      : process.platform === "darwin"
        ? ["open", [address]]
        : ["xdg-open", [address]];
  const child = spawn(command as string, list as string[], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

const home = value("home");
const port = value("port");
const server = await startServer({
  ...(home ? { home } : {}),
  ...(port ? { port: Number(port) } : {}),
  // For finding out why a start went wrong: one line for each request, with no address in it that could hold the key.
  ...(flag("log-requests") ? { log: (line: string) => console.log(`OPENASSESS_REQUEST ${line}`) } : {}),
});

console.log(`OPENASSESS_READY ${server.entry}`);
console.log(`${PRODUCT_NAME} is running at ${server.url}`);
console.log(`Your banks and exports are in ${server.context.library.home}`);
console.log("Close this window to stop it.");

if (flag("open")) openInBrowser(server.entry);

if (flag("exit-when-stdin-closes")) {
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
}

const stop = (): void => {
  void server.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
