// @ts-check
/**
 * Getting a scan to the server. The window already knows how to open a JPEG, a phone's photo (with the camera's own turn applied),
 * a WebP, a GIF or a BMP, so it decodes those into grey pixels and sends the pixels; a PNG or a PDF is sent as it is and opened by
 * the engine, and a JPEG page inside a scanned PDF is handed back here to be decoded the same way. Anything the window cannot open is
 * sent as a page that was not read, with the reason, so that nothing is lost without a word.
 *
 * The picture is made grey and no larger than a page needs (3300 pixels on its long side, which is a Letter page at 300 dots to the
 * inch), because the reader works from grey and colour only costs time.
 */

import { ApiError, api, getBytes, post } from "./api.js";

/** The longest side a picture is sent at, in pixels. */
const LONG_SIDE = 3300;
/** The most pixels a page may have, as the server allows. */
const MOST_PIXELS = 16_000_000;

/** Kinds of picture the window can decode, by their first bytes. */
const DECODABLE = { jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp" };

/**
 * What a file is, from its first bytes (the name is not trusted: a scanner's file names say little and a phone's say less).
 * @param {Uint8Array} b
 * @returns {"jpeg" | "webp" | "gif" | "bmp" | "other"}
 */
export function sniff(b) {
  const text = (/** @type {number} */ from, /** @type {number} */ to) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "webp";
  if (b.length >= 6 && (text(0, 6) === "GIF87a" || text(0, 6) === "GIF89a")) return "gif";
  if (b.length >= 2 && text(0, 2) === "BM") return "bmp";
  return "other";
}

/**
 * A picture as grey pixels, one byte each, 0 black to 255 white, the right way up as the camera meant it.
 * @param {Blob} blob
 * @returns {Promise<{ width: number, height: number, data: Uint8Array }>}
 */
export async function greyOf(blob) {
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, LONG_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(16, Math.round(bitmap.width * scale));
    const height = Math.max(16, Math.round(bitmap.height * scale));
    if (width * height > MOST_PIXELS) throw new Error("This picture is too large to read. Scan at 150 to 300 dots to the inch.");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("This window cannot open pictures.");
    // A picture with see-through parts is laid on white, as paper is.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    const rgba = context.getImageData(0, 0, width, height).data;
    const data = new Uint8Array(width * height);
    for (let i = 0, j = 0; i < data.length; i++, j += 4) data[i] = ((rgba[j] ?? 0) * 77 + (rgba[j + 1] ?? 0) * 150 + (rgba[j + 2] ?? 0) * 29) >> 8;
    return { width, height, data };
  } finally {
    bitmap.close();
  }
}

/**
 * @param {string} sid
 * @param {{ width: number, height: number, data: Uint8Array }} grey
 * @param {string} file
 * @param {number} page
 * @param {number} [replace]  the place of a page that was held waiting
 */
async function sendPixels(sid, grey, file, page, replace) {
  const query = `file=${encodeURIComponent(file)}&page=${page}&width=${grey.width}&height=${grey.height}${replace === undefined ? "" : `&replace=${replace}`}`;
  return api("POST", `scoring/${sid}/pages?${query}`, grey.data);
}

/** @param {unknown} error */
const reasonOf = (error) => (error instanceof ApiError ? error.message : error instanceof Error && error.message ? error.message : "This picture could not be opened.");

/**
 * Sends one file. Returns how many pages it added.
 * @param {string} sid
 * @param {File} file
 */
export async function sendScan(sid, file) {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const kind = sniff(head);
  if (kind !== "other") {
    try {
      await sendPixels(sid, await greyOf(file), file.name, 1);
    } catch (error) {
      await post(`scoring/${sid}/refused`, { file: file.name, page: 1, reason: `${reasonOf(error)} Save the scan as a PNG or a PDF, or photograph the sheet again.` });
    }
    return 1;
  }
  const sent = await api("POST", `scoring/${sid}/files?name=${encodeURIComponent(file.name)}`, file);
  for (const waiting of sent.waiting ?? []) {
    try {
      const bytes = await getBytes(`scoring/${sid}/waiting/${waiting.entry}`);
      const type = /** @type {Record<string, string>} */ (DECODABLE)[waiting.format] ?? "image/jpeg";
      await sendPixels(sid, await greyOf(new Blob([/** @type {BlobPart} */ (bytes)], { type })), file.name, waiting.page, waiting.entry);
    } catch (error) {
      await post(`scoring/${sid}/refused`, { file: file.name, page: waiting.page, replace: waiting.entry, reason: `${reasonOf(error)} Save the scan as a PNG, or set the scanner to save JPG or PDF pages.` });
    }
  }
  return sent.added;
}

/**
 * Sends the files in the order given, which is the order the sheets are put into, and tells the caller as each begins.
 * @param {string} sid
 * @param {File[]} files
 * @param {(done: number, total: number, name: string) => void} progress
 */
export async function sendScans(sid, files, progress) {
  let pages = 0;
  for (const [index, file] of files.entries()) {
    progress(index, files.length, file.name);
    pages += await sendScan(sid, file);
  }
  progress(files.length, files.length, "");
  return pages;
}

/**
 * A picture checked as a blank printed copy: sent as pixels if the window opens it, as the file if the engine does.
 * @param {string} url  the check's address, without a query
 * @param {File} file
 */
export async function sendForCheck(url, file) {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (sniff(head) !== "other") {
    const grey = await greyOf(file);
    return api("POST", `${url}?width=${grey.width}&height=${grey.height}`, grey.data);
  }
  return api("POST", url, file);
}
