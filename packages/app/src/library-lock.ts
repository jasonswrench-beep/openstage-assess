/**
 * One copy of OpenAssess at a time on a library.
 *
 * Two copies open on one library each keep their own picture of the banks in memory and save it whole, so the second save
 * wrote over the first without a word. The author's decision (17 November 2026) is that the second copy refuses: it says the
 * library is open elsewhere and does not open it until the first is closed, and it takes over a lock that a copy which crashed
 * left behind.
 *
 * The lock is a file in the library's folder, claimed by creating it (`wx` fails if it is there), as the app claims every name
 * it makes, and never looked for and then written, because two copies started together would both find nothing. It is written
 * once the server is listening, and holds that server's port and a random id. A copy that finds a lock asks the port: if a
 * server there answers with the same id in its `x-openassess-lock` header, the library is in use. A copy that crashed answers
 * nothing, and the connection is refused at once, so the lock is stale and is taken over. A copy that is busy (a large import
 * holds its one thread for seconds) still has its connection accepted by the system, and is counted as in use while the
 * question waits, so a busy copy is never mistaken for a dead one. A port that answers without the id is some other program that
 * was given the port later. The process id is kept only to be shown, since Windows gives a dead process's id to the next one.
 *
 * What this cannot see: a copy on another computer that shares the folder through a synced drive. Its port is not on this
 * computer, so its lock reads as stale and is taken over (`docs/review-findings.md`).
 */

import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";

/** The file's name. A person who finds it in the folder can tell from the name what it is. */
export const LOCK_FILE = "OpenAssess is open here.lock";

/** The header every response of a server that holds a lock carries, so that another copy can tell it from any other program. */
export const LOCK_HEADER = "x-openassess-lock";

/** How long to wait for a busy copy to answer before counting it as in use anyway. A dead copy is refused at once. */
export const PROBE_TIMEOUT_MS = 5000;

export interface LockRecord {
  id: string;
  pid: number;
  port: number;
  computer: string;
  /** When the holder opened the library, as an ISO date. */
  since: string;
}

/** What a copy that finds the library in use is told about the one that has it. */
export interface Holder {
  since: string;
  pid: number;
  port: number;
}

/** What asking a port found: the same copy, some other program, or nothing at all (a copy that crashed). */
export type ProbeAnswer = "holder" | "other" | "nothing" | "busy";

export type Probe = (port: number, id: string) => Promise<ProbeAnswer>;

export interface Claim {
  held: true;
  record: LockRecord;
  path: string;
  /** The stale lock this claim replaced, if there was one: said in the log, never silently. */
  replaced?: LockRecord | "unreadable";
}

export interface Refusal {
  held: false;
  holder: Holder;
  path: string;
}

export const lockPath = (home: string): string => join(home, LOCK_FILE);

/** Asks a port who is there. A refused connection is "nothing"; a connection that is accepted and not answered is "busy". */
export function probePort(port: number, id: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeAnswer> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (answer: ProbeAnswer): void => {
      if (settled) return;
      settled = true;
      resolve(answer);
    };
    const req = request({ host: "127.0.0.1", port, path: "/", method: "GET", headers: { host: `127.0.0.1:${port}` }, timeout: timeoutMs }, (res) => {
      const said = res.headers[LOCK_HEADER];
      res.resume();
      done(said === id ? "holder" : "other");
    });
    req.on("timeout", () => {
      req.destroy();
      done("busy");
    });
    req.on("error", (error: NodeJS.ErrnoException) => done(error.code === "ECONNREFUSED" ? "nothing" : "other"));
    req.end();
  });
}

function parse(text: string): LockRecord | undefined {
  try {
    const json = JSON.parse(text) as Partial<LockRecord>;
    if (typeof json.id !== "string" || !Number.isInteger(json.port) || (json.port as number) <= 0 || (json.port as number) > 65535) return undefined;
    return {
      id: json.id,
      port: json.port as number,
      pid: Number.isInteger(json.pid) ? (json.pid as number) : 0,
      computer: typeof json.computer === "string" ? json.computer : "",
      since: typeof json.since === "string" ? json.since : "",
    };
  } catch {
    return undefined;
  }
}

/**
 * Claims the library for the server listening on `port`, or says who has it. A stale lock is taken over: it is read again just
 * before it is removed, and removed only if it is still the stale one, so that a copy which took it over a moment earlier keeps
 * its claim. Three tries at most; a fourth would mean the file keeps changing under us, which is two copies starting together,
 * and the one that loses is refused.
 */
export async function claimLibrary(home: string, port: number, probe: Probe = probePort, now: () => Date = () => new Date()): Promise<Claim | Refusal> {
  const path = lockPath(home);
  const record: LockRecord = { id: randomBytes(16).toString("hex"), pid: process.pid, port, computer: hostname(), since: now().toISOString() };
  let replaced: LockRecord | "unreadable" | undefined;
  let last: LockRecord | undefined;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
      return { held: true, record, path, ...(replaced ? { replaced } : {}) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue; // gone between the two calls: try to create it again
    }
    const found = parse(text);
    if (found) {
      last = found;
      const answer = await probe(found.port, found.id);
      if (answer === "holder" || answer === "busy") return { held: false, holder: { since: found.since, pid: found.pid, port: found.port }, path };
    }
    // Stale: a copy that crashed, a port some other program has now, or a file that is not a lock we wrote.
    try {
      if ((await readFile(path, "utf8")) !== text) continue;
      await unlink(path);
      replaced = found ?? "unreadable";
    } catch {
      // Removed by someone else already: the next try creates it, or finds theirs.
    }
  }
  return { held: false, holder: last ? { since: last.since, pid: last.pid, port: last.port } : { since: "", pid: 0, port: 0 }, path };
}

/** Gives the library up, only if the lock is still this copy's own: a copy that took over a stale lock is never undone. */
export async function releaseLibrary(claim: Claim): Promise<void> {
  try {
    if (parse(await readFile(claim.path, "utf8"))?.id === claim.record.id) await unlink(claim.path);
  } catch {
    // Already gone.
  }
}

/** The same, for the moment the process is ending, when only synchronous calls still run. */
export function releaseLibrarySync(claim: Claim): void {
  try {
    if (parse(readFileSync(claim.path, "utf8"))?.id === claim.record.id) unlinkSync(claim.path);
  } catch {
    // Already gone.
  }
}
