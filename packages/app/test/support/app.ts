/**
 * A real server in a temporary folder, and a client that talks to it as the screen does: the key handed over once in the
 * address, then a cookie, and the header that marks a request as the app's own.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer, type RunningServer, type ServerOptions } from "../../src/server.ts";

export interface Reply<T = Record<string, unknown>> {
  status: number;
  json: T;
  text: string;
  headers: Headers;
  bytes: Buffer;
}

export class Client {
  readonly server: RunningServer;
  cookie = "";

  constructor(server: RunningServer) {
    this.server = server;
  }

  /** Opens the app the way a window does: at the address with the key, taking the cookie it hands back. */
  async signIn(): Promise<void> {
    const reply = await fetch(this.server.entry, { redirect: "manual" });
    const set = reply.headers.getSetCookie()[0] ?? "";
    this.cookie = set.split(";")[0] ?? "";
  }

  async send<T = Record<string, unknown>>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply<T>> {
    const raw = body === undefined ? undefined : body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
    const reply = await fetch(new URL(path, this.server.url), {
      method,
      redirect: "manual",
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(method !== "GET" ? { "x-openassess": "1" } : {}),
        ...(body !== undefined && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {}),
        ...extra,
      },
      ...(raw ? { body: raw } : {}),
    });
    const bytes = Buffer.from(await reply.arrayBuffer());
    const text = bytes.toString("utf8");
    let json: unknown = {};
    try {
      json = JSON.parse(text);
    } catch {
      json = {};
    }
    return { status: reply.status, json: json as T, text, headers: reply.headers, bytes };
  }

  get<T = Record<string, unknown>>(path: string): Promise<Reply<T>> {
    return this.send<T>("GET", path);
  }
  post<T = Record<string, unknown>>(path: string, body?: unknown): Promise<Reply<T>> {
    return this.send<T>("POST", path, body ?? {});
  }
  put<T = Record<string, unknown>>(path: string, body: unknown): Promise<Reply<T>> {
    return this.send<T>("PUT", path, body);
  }
  del<T = Record<string, unknown>>(path: string): Promise<Reply<T>> {
    return this.send<T>("DELETE", path);
  }
}

/** A raw request, for the tests that need a header a browser would not let a page set. */
export function rawRequest(port: number, path: string, headers: Record<string, string>, method = "GET"): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * A POST whose size is not told in advance (chunked), so that only counting what arrives can stop it. Resolves with the
 * status the server gave, whether or not it had read it all.
 */
export function chunkedPost(port: number, path: string, headers: Record<string, string>, megabytes: number): Promise<number> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers: { ...headers, "transfer-encoding": "chunked" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", () => resolve(0));
    const chunk = Buffer.alloc(1024 * 1024, 120);
    for (let i = 0; i < megabytes; i++) req.write(chunk);
    req.end();
  });
}

/** A POST that says it is enormous and sends nothing. The answer has to come without waiting for the body. */
export function liarPost(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(-1), 3000);
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers: { ...headers, "content-length": "999999999" } }, (res) => {
      clearTimeout(timer);
      res.resume();
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    req.on("error", () => undefined);
    req.write("{");
  });
}

export async function withApp(fn: (client: Client, home: string, revealed: string[]) => Promise<void>, options: ServerOptions = {}): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "openassess-app-"));
  const revealed: string[] = [];
  const server = await startServer({ home, reveal: (path) => void revealed.push(path), ...options });
  const client = new Client(server);
  try {
    await client.signIn();
    await fn(client, home, revealed);
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
}
