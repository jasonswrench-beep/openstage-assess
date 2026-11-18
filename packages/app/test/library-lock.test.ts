/**
 * One copy at a time on a library (`src/library-lock.ts`). Two copies open on one library each save the banks they hold in
 * memory, so the second save wrote over the first without a word; the author's decision is that the second copy refuses and
 * says why, and that a lock left by a copy that crashed is taken over.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { claimLibrary, LOCK_FILE, LOCK_HEADER, lockPath, probePort } from "../src/library-lock.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { Client } from "./support/app.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "openassess-lock-"));
}

const readLock = (home: string): { id: string; port: number; pid: number } => JSON.parse(readFileSync(lockPath(home), "utf8"));

async function signedIn(server: RunningServer): Promise<Client> {
  const client = new Client(server);
  await client.signIn();
  return client;
}

/** A port that nothing listens on: opened, read and closed again. */
async function deadPort(): Promise<number> {
  const s = createNetServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

async function listening<T extends NetServer>(server: T): Promise<{ server: T; port: number }> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { server, port: (server.address() as { port: number }).port };
}

test("a second copy on one library refuses it, says so, and opens it once the first is closed", async () => {
  const home = tempHome();
  const first = await startServer({ home });
  let second: RunningServer | undefined;
  try {
    assert.equal(first.inUse(), undefined, "the first copy holds the library");
    const lock = readLock(home);
    assert.equal(lock.port, first.port, "the lock names the port the first copy answers on");
    assert.equal(lock.pid, process.pid);

    // Every answer of the holder carries its id, even one that turns the request away, so another copy can tell it is there.
    const probe = await fetch(first.url);
    assert.equal(probe.status, 401);
    assert.equal(probe.headers.get(LOCK_HEADER), lock.id);

    second = await startServer({ home });
    const holder = second.inUse();
    assert.ok(holder, "the second copy finds the library in use");
    assert.equal(holder.port, first.port);
    assert.equal(readLock(home).id, lock.id, "the second copy did not touch the first one's lock");

    const client = await signedIn(second);
    const page = await client.get("/");
    assert.equal(page.status, 200);
    assert.match(page.text, /This library is already open/, "the window shows why, at the address it is sent to");
    assert.match(page.text, /in-use\.js/);
    assert.equal(page.headers.get(LOCK_HEADER), null, "a copy that holds nothing claims nothing");

    const banks = await client.get("/api/state");
    assert.equal(banks.status, 423, "the refused copy lists no bank");
    assert.match(String(banks.json["error"]), /open in another copy of OpenAssess/);
    assert.equal((await client.post("/api/banks", { title: "Made in the second copy" })).status, 423, "and makes none");
    assert.equal((await client.get("/files/anything.csv")).status, 423, "and serves no file of the library");

    const said = await client.get<{ inUse: { home: string; since: string; port: number } }>("/api/library/in-use");
    assert.equal(said.json.inUse.home, first.context.library.home);
    assert.ok(!Number.isNaN(Date.parse(said.json.inUse.since)), "it says since when");

    const still = await client.post<{ inUse: unknown }>("/api/library/try-again");
    assert.notEqual(still.json.inUse, null, "Try again while the first copy is open still finds it in use");

    await first.close();
    assert.equal(existsSync(lockPath(home)), false, "closing gives the library up");

    const again = await client.post<{ inUse: unknown }>("/api/library/try-again");
    assert.equal(again.json.inUse, null, "Try again after the first copy closed opens the library");
    assert.equal(second.inUse(), undefined);
    assert.equal((await client.get("/api/state")).status, 200, "and the app works as usual");
    assert.equal(readLock(home).port, second.port, "the lock is now the second copy's");
    assert.match((await client.get("/")).text, /app\.js/, "the address shows the app again");
  } finally {
    await first.close();
    await second?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("Try again needs the app's own header, like any change", async () => {
  const home = tempHome();
  const first = await startServer({ home });
  const second = await startServer({ home });
  try {
    const client = await signedIn(second);
    const reply = await client.send("POST", "/api/library/try-again", undefined, { "x-openassess": "0" });
    assert.equal(reply.status, 403);
  } finally {
    await first.close();
    await second.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a lock left by a copy that is not running is taken over, and the log says so", async () => {
  const home = tempHome();
  const port = await deadPort();
  writeFileSync(lockPath(home), JSON.stringify({ id: "left-behind", pid: 999999, port, computer: "here", since: "2026-11-01T10:00:00.000Z" }));
  const lines: string[] = [];
  const server = await startServer({ home, log: (line) => lines.push(line) });
  try {
    assert.equal(server.inUse(), undefined, "nothing answers on the old port, so the copy is gone");
    assert.notEqual(readLock(home).id, "left-behind");
    assert.equal(readLock(home).port, server.port);
    assert.ok(lines.some((l) => l.startsWith("LOCK taken over") && l.includes(`port ${port}`)), "the takeover is said, never silent");
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a lock file that is not one of ours is taken over", async () => {
  for (const text of ["", "not a lock", "{}", '{"id":"x","port":0}', '{"id":"x","port":70000}', "[1,2]"]) {
    const home = tempHome();
    writeFileSync(lockPath(home), text);
    const server = await startServer({ home });
    try {
      assert.equal(server.inUse(), undefined, `the file ${JSON.stringify(text)} holds nothing`);
      assert.equal(readLock(home).port, server.port);
    } finally {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("a lock whose port another program now answers on is taken over", async () => {
  const home = tempHome();
  const { server: other, port } = await listening(createHttpServer((_req, res) => res.end("someone else")));
  writeFileSync(lockPath(home), JSON.stringify({ id: "old", pid: process.pid, port, computer: "here", since: "" }));
  const server = await startServer({ home });
  try {
    assert.equal(server.inUse(), undefined, "an answer without the id is not the copy that wrote the lock");
  } finally {
    await server.close();
    await new Promise<void>((resolve) => other.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});

test("a copy too busy to answer is still counted as having the library", async () => {
  // A copy in the middle of a large import holds its one thread for seconds. The system still accepts the connection, and that
  // is what tells it from a copy that crashed, whose port refuses at once.
  const sockets: import("node:net").Socket[] = [];
  const { server: silent, port } = await listening(createNetServer((socket) => void sockets.push(socket)));
  try {
    assert.equal(await probePort(port, "any", 300), "busy");
    assert.equal(await probePort(await deadPort(), "any", 300), "nothing");

    const home = tempHome();
    writeFileSync(lockPath(home), JSON.stringify({ id: "busy-one", pid: process.pid, port, computer: "here", since: "2026-11-17T09:00:00.000Z" }));
    const server = await startServer({ home, probe: (p, id) => probePort(p, id, 300) });
    try {
      assert.ok(server.inUse(), "a busy copy is never mistaken for a dead one");
      assert.equal(readLock(home).id, "busy-one", "and its lock is left alone");
    } finally {
      await server.close();
      assert.equal(readLock(home).id, "busy-one", "closing a copy that holds nothing removes nobody's lock");
      rmSync(home, { recursive: true, force: true });
    }
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
});

test("a copy gives up only its own lock", async () => {
  const home = tempHome();
  const server = await startServer({ home });
  try {
    // Another copy took the lock over while this one was hung, say: closing this one must not undo that.
    writeFileSync(lockPath(home), JSON.stringify({ id: "someone-else", pid: 1, port: 1, computer: "here", since: "" }));
  } finally {
    await server.close();
  }
  assert.equal(readLock(home).id, "someone-else");
  rmSync(home, { recursive: true, force: true });
});

test("copies started together: exactly one holds the library", async () => {
  const home = tempHome();
  const servers = await Promise.all([0, 1, 2, 3].map(() => startServer({ home })));
  try {
    const holders = servers.filter((s) => s.inUse() === undefined);
    assert.equal(holders.length, 1, "one copy holds it and the others are refused");
    assert.equal(readLock(home).port, holders[0]?.port);
  } finally {
    for (const s of servers) await s.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("claimLibrary refuses after three tries when the file keeps changing, rather than take a lock someone has", async () => {
  const home = tempHome();
  let n = 0;
  // Each look finds a new stale lock in place: the file never stays the one that was judged stale.
  writeFileSync(lockPath(home), JSON.stringify({ id: "a0", pid: 1, port: 1, computer: "here", since: "" }));
  const result = await claimLibrary(home, 5555, async () => {
    n++;
    writeFileSync(lockPath(home), JSON.stringify({ id: `a${n}`, pid: 1, port: 1, computer: "here", since: "" }));
    return "nothing";
  });
  assert.equal(result.held, false);
  assert.equal(n, 3);
  rmSync(home, { recursive: true, force: true });
});

/** Starts the app as the window does, and waits for the line that says it is listening. */
function startChild(home: string): Promise<{ child: import("node:child_process").ChildProcess; done: Promise<number | null> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", MAIN, "--home", home, "--exit-when-stdin-closes", "--no-update-check"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const done = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.includes("OPENASSESS_READY ")) resolve({ child, done });
    });
    child.on("error", reject);
    setTimeout(() => reject(new Error(`the app did not start: ${out}`)), 30_000).unref();
  });
}

test("the window's copy gives the library up when the window closes, and a copy that was killed leaves a lock the next one takes over", async () => {
  const home = tempHome();
  try {
    const { child, done } = await startChild(home);
    assert.equal(existsSync(lockPath(home)), true);
    child.stdin?.end(); // the window closing
    await done;
    assert.equal(existsSync(lockPath(home)), false, "an orderly exit removes the lock");

    const killed = await startChild(home);
    const left = readLock(home);
    killed.child.kill("SIGKILL"); // a crash: nothing of the process runs on the way out
    await killed.done;
    assert.equal(readLock(home).id, left.id, "a crash leaves the lock behind");

    const next = await startServer({ home });
    try {
      assert.equal(next.inUse(), undefined, "and the next copy takes it over");
      assert.equal(readLock(home).port, next.port);
    } finally {
      await next.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the lock's file is named for a person who finds it in the folder", () => {
  assert.match(LOCK_FILE, /OpenAssess/);
  assert.match(LOCK_FILE, /\.lock$/);
});
