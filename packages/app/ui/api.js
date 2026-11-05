// @ts-check
/**
 * Talking to the server. Every change carries the header that marks it as this app's own, and every failure comes back as an
 * error with words in it that can be shown as they are.
 */

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]  an object is sent as JSON; a File, Blob or typed array is sent as it is
 * @returns {Promise<any>}
 */
export async function api(method, path, body) {
  /** @type {Record<string, string>} */
  const headers = {};
  /** @type {BodyInit | undefined} */
  let payload;
  if (method !== "GET") headers["x-openassess"] = "1";
  if (body instanceof Blob || body instanceof Uint8Array || body instanceof ArrayBuffer) {
    payload = /** @type {any} */ (body);
    headers["content-type"] = "application/octet-stream";
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  let reply;
  try {
    reply = await fetch(`/api/${path}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) });
  } catch {
    throw new ApiError("OpenAssess could not be reached. Close it and open it again.", 0);
  }
  /** @type {any} */
  let json = {};
  try {
    json = await reply.json();
  } catch {
    json = {};
  }
  if (!reply.ok) throw new ApiError(json.error || `Something went wrong (${reply.status}).`, reply.status);
  return json;
}

export const get = (/** @type {string} */ path) => api("GET", path);
export const post = (/** @type {string} */ path, /** @type {unknown} */ body = {}) => api("POST", path, body);
export const put = (/** @type {string} */ path, /** @type {unknown} */ body) => api("PUT", path, body);
export const del = (/** @type {string} */ path) => api("DELETE", path);

/**
 * The bytes of something the server holds for the window to open (a picture it could not decode itself).
 * @param {string} path
 * @returns {Promise<Uint8Array>}
 */
export async function getBytes(path) {
  let reply;
  try {
    reply = await fetch(`/api/${path}`);
  } catch {
    throw new ApiError("OpenAssess could not be reached. Close it and open it again.", 0);
  }
  if (!reply.ok) throw new ApiError(`Something went wrong (${reply.status}).`, reply.status);
  return new Uint8Array(await reply.arrayBuffer());
}
