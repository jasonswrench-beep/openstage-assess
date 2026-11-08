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
import { sampleById, samplePath } from "./samples.ts";
import { ScoringSessions } from "./scoring.ts";
import { Sessions } from "./sessions.ts";

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "ui");

/** Most a request may carry. A Word file or a bank can be large; everything else is small. */
const MAX_UPLOAD = 80 * 1024 * 1024;
const MAX_JSON = 4 * 1024 * 1024;
/** A picture chosen for a question: the engine keeps at most 25 MB of picture, and a little over is room for it to say so in words. */
const MAX_PICTURE_UPLOAD = 26 * 1024 * 1024;
/** A page of a scan, as the window sends it: grey pixels, one byte each. A scan at 300 dots to the inch is about 8.4 million. */
const MAX_PAGE = 17 * 1024 * 1024;

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

/**
 * How much a request may carry, by what it is for. A file to read (a Word file, a bank, a scan, a scores file) can be large, a page of
 * a scan as the window decodes it is a page's worth of pixels, and everything else is small.
 */
export function uploadLimit(segments: readonly string[]): number {
  const [a, b, c] = segments;
  if (a === "import" || (a === "banks" && b === "open")) return MAX_UPLOAD;
  if (a === "scoring" && (b === "open" || c === "files")) return MAX_UPLOAD;
  if (a === "scoring" && c === "pages") return MAX_PAGE;
  if (a === "sheets" && segments[4] === "printing-check") return MAX_UPLOAD;
  if ((a === "banks" || a === "sessions") && c === "questions" && segments[4] === "pictures") return MAX_PICTURE_UPLOAD;
  return MAX_JSON;
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

/** A size a person can read: 4.0 MB, 80 MB. */
const megabytes = (bytes: number): string => (bytes >= 10 * 1048576 ? `${Math.round(bytes / 1048576)} MB` : `${(bytes / 1048576).toFixed(1)} MB`);

/**
 * What is said when a request is bigger than its route takes. It used to be "That file is too large.", which says neither how large
 * nor what to do. A bank of questions is far smaller than the most a file may be, so the likelier mistake is the wrong file.
 */
function tooLarge(limit: number, size?: number): HttpError {
  const is = size === undefined ? "That is more than this takes" : `That is ${megabytes(size)}, and the most this takes at once is ${megabytes(limit)}`;
  const hint = limit === MAX_UPLOAD ? " A file of questions is far smaller than that, so check it is the one you meant; if it holds large pictures, save a copy with smaller ones." : limit === MAX_PICTURE_UPLOAD ? " Save the picture again at a smaller size." : "";
  return new HttpError(413, `${size === undefined ? `${is} (${megabytes(limit)}).` : `${is}.`}${hint}`);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) throw tooLarge(limit, declared);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw tooLarge(limit);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * The header that tells the window to keep a response as a file, and under what name. The name is in the form RFC 8187 gives
 * (`filename*=UTF-8''...`), which allows letters, digits and a few signs and nothing else: `encodeURIComponent` leaves `'`, `(`, `)`,
 * `*` and `!` as they are, and a title such as "Bob's quiz (v2)" has them, so they are written as codes too. A browser is lenient and a
 * proxy or another client may not be.
 */
export function attachmentHeader(name: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/**
 * What to run to show a file in its folder. Explorer wants the quotes inside its one argument, `/select,"C:\a b\c.csv"`. Node
 * puts quotes around a whole argument that holds a space, `"/select,C:\a b\c.csv"`, which Explorer cannot read, so it opens
 * the Documents folder instead and says nothing. A space is nearly always there ("Quiz - Brightspace.csv", a bank titled "PDF
 * TB 2", a Windows user name with a space in it), so Show in folder rarely showed the file. On Windows the argument is therefore passed as written, and checked first: a name
 * with a quote mark in it cannot be a Windows file name, and would end the argument early.
 */
export function revealCommand(path: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[]; verbatim: boolean } {
  if (platform === "win32") {
    if (path.includes('"')) throw new HttpError(400, "That file name cannot be shown.");
    return { command: "explorer.exe", args: [`/select,"${path}"`], verbatim: true };
  }
  if (platform === "darwin") return { command: "open", args: ["-R", path], verbatim: false };
  return { command: "xdg-open", args: [dirname(path)], verbatim: false };
}

function defaultReveal(path: string): void {
  const { command, args, verbatim } = revealCommand(path);
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsVerbatimArguments: verbatim });
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
    scoring: new ScoringSessions(),
    reveal: options.reveal ?? defaultReveal,
    ...(options.extra ? { extra: options.extra } : {}),
  };

  let port = 0;
  const origins = (): string[] => [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  // A cookie belongs to a host and not to a port, so two copies of OpenAssess on 127.0.0.1 share one cookie jar. With one name
  // for both, the second copy's key replaced the first's, and the first window's next request was turned away as having no key.
  // Each copy names its cookie by its port, and a request carries every cookie of the host, so each finds its own.
  const cookieName = (): string => `${COOKIE}_${port}`;

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
        ...(download ? { "content-disposition": attachmentHeader(download) } : {}),
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

  /**
   * A sample file, to keep. It is asked for by an id of the fixed list and never by a name, so there is no path in the request to
   * reach for, and nothing is written: the window is what asks where the copy goes, because this is a download like any other.
   */
  async function serveSample(res: ServerResponse, rawId: string): Promise<void> {
    let id: string;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      throw new HttpError(404, "There is no such sample.");
    }
    const sample = sampleById(id);
    if (!sample) throw new HttpError(404, "There is no such sample.");
    await sendFile(res, samplePath(sample), TYPES[extname(sample.file).toLowerCase()] ?? "application/octet-stream", sample.file);
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
      res.writeHead(200, headers({ "content-type": "text/html; charset=utf-8", "set-cookie": `${cookieName()}=${token}; Path=/; HttpOnly; SameSite=Strict` }));
      res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><link rel="icon" href="data:,"><title>OpenAssess</title></head><body><p>Opening OpenAssess…</p></body></html>');
      return;
    }

    if (!sameText(cookieOf(req, cookieName()) ?? "", token)) {
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
      const body = method === "GET" || method === "DELETE" ? Buffer.alloc(0) : await readBody(req, uploadLimit(segments));
      const request: ApiRequest = { method, segments, query: url.searchParams, body };
      const answer: ApiResponse = await handleApi(context, request);
      if (answer.file) await sendFile(res, answer.file.path, answer.file.type, answer.file.name);
      else if (answer.bytes) {
        res.writeHead(200, headers({ "content-type": answer.bytes.type, "content-length": String(answer.bytes.data.length) }));
        res.end(answer.bytes.data);
      }
      else sendJson(res, answer.status, answer.json ?? {});
      return;
    }

    if (method === "GET" && url.pathname.startsWith("/files/samples/")) {
      await serveSample(res, url.pathname.slice("/files/samples/".length));
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
