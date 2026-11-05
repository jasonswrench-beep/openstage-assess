/**
 * The layout inside a .openassess file.
 *
 *   manifest.json        format, version, bank id, title, counts
 *   questions/q_*.json   one file per question
 *   folders.json         the folder tree and saved filters
 *   tests/*.json         assembled tests, blueprints and version seeds
 *   media/*              images and attachments
 *   profiles/*.json      import profiles saved into this bank
 *   history.jsonl        append-only change log, one JSON object per line
 *
 * One file per question rather than one large document, because that makes the
 * format diffable in a shared folder, survivable when a single question is
 * damaged, and cheap to write on auto-save.
 */

export const MANIFEST_PATH = "manifest.json";
export const FOLDERS_PATH = "folders.json";
export const HISTORY_PATH = "history.jsonl";
export const QUESTIONS_DIR = "questions/";
export const MEDIA_DIR = "media/";
export const TESTS_DIR = "tests/";
export const PROFILES_DIR = "profiles/";

export function questionPath(id: string): string {
  return `${QUESTIONS_DIR}${id}.json`;
}

export function mediaPath(id: string, extension: string): string {
  const ext = extension.startsWith(".") ? extension : `.${extension}`;
  return `${MEDIA_DIR}${id}${ext}`;
}

export function testPath(id: string): string {
  return `${TESTS_DIR}${id}.json`;
}

export function isTestPath(name: string): boolean {
  return name.startsWith(TESTS_DIR) && name.endsWith(".json");
}

export function testIdFromPath(name: string): string {
  return name.slice(TESTS_DIR.length, name.length - ".json".length);
}

export function isQuestionPath(name: string): boolean {
  return name.startsWith(QUESTIONS_DIR) && name.endsWith(".json");
}

export function isMediaPath(name: string): boolean {
  return name.startsWith(MEDIA_DIR) && !name.endsWith("/");
}

export function questionIdFromPath(name: string): string {
  return name.slice(QUESTIONS_DIR.length, name.length - ".json".length);
}

/** Media is already compressed; storing it keeps saves fast. */
const STORED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp3", ".mp4", ".zip", ".pdf"]);

export function shouldStore(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot !== -1 && STORED_EXTENSIONS.has(name.slice(dot).toLowerCase());
}
