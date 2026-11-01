/**
 * The local server: the engine behind a web page, for this computer only.
 *
 * It listens on 127.0.0.1 and nowhere else, and it is built to be safe from other pages in the same browser, not only from
 * other computers. A web page open in another tab can send a request to 127.0.0.1 as easily as to anywhere, so a request is
 * answered only when all of these hold:
 *
 *  - it names this server in its Host header (which defeats a name that has been pointed at 127.0.0.1),
 *  - it carries the key that was handed to the window when it was opened, as a cookie that other sites are not sent
 *    (SameSite=Strict) and a script on another site cannot read (HttpOnly),
 *  - and, when it changes anything, it comes with a header that a page on another site cannot add without being asked
 *    first, and it does not come from another origin.
 *
 * Pages are sent with a policy that allows nothing but this server's own scripts and styles.
 */

import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { handleApi, type ApiRequest, type ApiResponse, type Context } from "./api.ts";
import { BankStore } from "./banks.ts";
import { HttpError } from "./errors.ts";
import { checkName, openLibrary } from "./library.ts";
import { Sessions } from "./sessions.ts";

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "ui");

/** Most a request may carry. A Word file or a bank can be large; everything else is small. */
const MAX_UPLOAD = 80 * 1024 * 1024;
const MAX_JSON = 4 * 1024 * 1024;

const COOKIE = "oa_key";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pdf": "application/pdf",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".gift": "text/plain; charset=utf-8",
  ".openassess": "application/octet-stream",
};

const POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export interface ServerOptions {
  home?: string;
  /** Told of every request once it has been answered, with no address or text from the request that could hold a key. */
  log?: (line: string) => void;
  /** 0 picks a free port. */
  port?: number;
  token?: string;
  reveal?: Context["reveal"];
  extra?: Context["extra"];
}

export interface RunningServer {
  /** The address, with no key in it. */
  url: string;
  /** The address to open: it carries the key once, and the server moves it into a cookie and takes it out of the address. */
  entry: string;
  port: number;
  token: string;
  context: Context;
  close(): Promise<void>;
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieOf(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) throw new HttpError(413, "That file is too large.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "That file is too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function defaultReveal(path: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["explorer.exe", [`/select,${path}`]]
      : process.platform === "darwin"
        ? ["open", ["-R", path]]
        : ["xdg-open", [dirname(path)]];
  const child = spawn(command as string, args as string[], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const library = await openLibrary(options.home);
  const token = options.token ?? randomBytes(24).toString("base64url");
  const context: Context = {
    library,
    banks: new BankStore(library),
    sessions: new Sessions(),
    reveal: options.reveal ?? defaultReveal,
    ...(options.extra ? { extra: options.extra } : {}),
  };

  let port = 0;
  const origins = (): string[] => [`http://127.0.0.1:${port}`, `http://localhost:${port}`];

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "content-security-policy": POLICY,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      ...extra,
    };
  }

  function sendJson(res: ServerResponse, status: number, json: unknown): void {
    res.writeHead(status, headers({ "content-type": "application/json; charset=utf-8" }));
    res.end(JSON.stringify(json));
  }

  function sendText(res: ServerResponse, status: number, text: string): void {
    res.writeHead(status, headers({ "content-type": "text/plain; charset=utf-8" }));
    res.end(text);
  }

  async function sendFile(res: ServerResponse, path: string, type: string, download?: string): Promise<void> {
    const body = await readFile(path);
    res.writeHead(
      200,
      headers({
        "content-type": type,
        "content-length": String(body.length),
        ...(download ? { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(download)}` } : {}),
      }),
    );
    res.end(body);
  }

  async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    const name = pathname === "/" ? "/index.html" : pathname;
    // Only plain names, one folder deep: nothing here can name a path outside the ui folder.
    if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?\.(?:js|css|html|svg|png|ico|json)$/.test(name)) throw new HttpError(404, "There is no such page.");
    const path = join(UI_DIR, ...name.split("/").filter(Boolean));
    try {
      await sendFile(res, path, TYPES[extname(path)] ?? "application/octet-stream");
    } catch {
      throw new HttpError(404, "There is no such page.");
    }
  }

  async function serveExport(res: ServerResponse, rawName: string): Promise<void> {
    const name = checkName(decodeURIComponent(rawName));
    const path = join(library.exports, name);
    try {
      if (!(await stat(path)).isFile()) throw new Error("not a file");
    } catch {
      throw new HttpError(404, "There is no such file.");
    }
    await sendFile(res, path, TYPES[extname(name).toLowerCase()] ?? "application/octet-stream", name);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(421, "This server answers only to its own address.");
    const url = new URL(req.url ?? "/", `http://${host}`);
    const method = req.method ?? "GET";

    // The key arrives once, in the address the window is opened at, and is turned into a cookie and taken out of the address.
    // It is answered with a page that moves on by itself, not with a redirect. The window's first load starts on another site
    // (the page it shows while it starts), and a browser will not send a SameSite=Strict cookie on any hop of a navigation
    // that began on another site, redirects included: the redirect would arrive with no cookie and be turned away. The page's
    // own move to "/" begins here, on this site, so the cookie goes with it, and the cookie can stay Strict.
    if (method === "GET" && url.pathname === "/" && url.searchParams.has("k")) {
      if (!sameText(url.searchParams.get("k") ?? "", token)) throw new HttpError(403, "That key is not right. Open OpenAssess again.");
      res.writeHead(200, headers({ "content-type": "text/html; charset=utf-8", "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict` }));
      res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><link rel="icon" href="data:,"><title>OpenAssess</title></head><body><p>Opening OpenAssess…</p></body></html>');
      return;
    }

    if (!sameText(cookieOf(req, COOKIE) ?? "", token)) {
      throw new HttpError(401, "Open OpenAssess from its own window or from the shortcut. This address only works there.");
    }

    if (url.pathname.startsWith("/api/")) {
      if (method !== "GET") {
        if (req.headers["x-openassess"] !== "1") throw new HttpError(403, "That request did not come from OpenAssess.");
        const origin = req.headers.origin;
        if (origin !== undefined && !origins().includes(origin)) throw new HttpError(403, "That request came from another page.");
      }
      const segments = url.pathname
        .slice("/api/".length)
        .split("/")
        .filter((s) => s !== "")
        .map((s) => {
          try {
            return decodeURIComponent(s);
          } catch {
            throw new HttpError(400, "That address is not valid.");
          }
        });
      const big = segments[0] === "import" || (segments[0] === "banks" && segments[1] === "open");
      const body = method === "GET" || method === "DELETE" ? Buffer.alloc(0) : await readBody(req, big ? MAX_UPLOAD : MAX_JSON);
      const request: ApiRequest = { method, segments, query: url.searchParams, body };
      const answer: ApiResponse = await handleApi(context, request);
      if (answer.file) await sendFile(res, answer.file.path, answer.file.type, answer.file.name);
      else sendJson(res, answer.status, answer.json ?? {});
      return;
    }

    if (method === "GET" && url.pathname.startsWith("/files/")) {
      await serveExport(res, url.pathname.slice("/files/".length));
      return;
    }

    if (method !== "GET") throw new HttpError(405, "That is not allowed.");
    await serveStatic(res, url.pathname);
  }

  const server: Server = createServer((req, res) => {
    // What was asked and what was answered, without the query, which is where the key is.
    if (options.log) res.on("finish", () => options.log?.(`${req.method ?? "?"} ${(req.url ?? "").split("?")[0]} ${res.statusCode}`));
    handle(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const message = error instanceof HttpError ? error.message : "Something went wrong inside OpenAssess. Nothing was changed.";
      const wantsJson = (req.url ?? "").startsWith("/api/");
      if (wantsJson) sendJson(res, status, { error: message });
      else sendText(res, status, message);
    });
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 20_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/`,
    entry: `http://127.0.0.1:${port}/?k=${token}`,
    port,
    token,
    context,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
