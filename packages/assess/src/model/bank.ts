/**
 * Bank-level types: the manifest, the folder tree, saved filters and the
 * query shape that the browser, the read contract and the test builder all
 * share.
 *
 * A bank is one file per course or book. The container layout is in
 * container/layout.ts; this file is only the shapes that go inside it.
 */

import type { BloomLevel, Difficulty, QuestionType, Status } from "./question.ts";
import { stripInvalidCharacters } from "./richtext.ts";

export interface BankManifest {
  format: string;
  formatVersion: number;
  bankId: string;
  title: string;
  description?: string;
  created: string;
  modified: string;
  questionCount: number;
  generator: string;
  /** Free-form, for a course code or an ISBN. */
  subject?: string;
}

export interface FolderNode {
  id: string;
  name: string;
  /** Ordered. A question appears in at most one folder. */
  questionIds: string[];
  children: FolderNode[];
}

export interface SavedFilter {
  id: string;
  name: string;
  query: Query;
}

export interface FolderFile {
  root: FolderNode[];
  filters: SavedFilter[];
}

/**
 * One query shape for search, saved filters, pool rules and the read
 * contract's listQuestions. Everything is an AND; an array inside one field
 * is an OR.
 */
export interface Query {
  /** Free text over title, stem, options, tags and metadata values. */
  text?: string;
  types?: QuestionType[];
  statuses?: Status[];
  tags?: string[];
  bloom?: BloomLevel[];
  difficulty?: Difficulty[];
  chapter?: string[];
  objective?: string[];
  folderId?: string;
  /** Only questions that have at least one live finding of this severity. */
  hasFindings?: "error" | "warn" | "any";
  /** Only questions whose points fall in this range. */
  minPoints?: number;
  maxPoints?: number;
}

export function emptyFolderFile(): FolderFile {
  return { root: [], filters: [] };
}

export function* walkFolders(nodes: readonly FolderNode[]): Generator<FolderNode> {
  for (const node of nodes) {
    yield node;
    yield* walkFolders(node.children);
  }
}

export function findFolder(nodes: readonly FolderNode[], id: string): FolderNode | undefined {
  for (const node of walkFolders(nodes)) {
    if (node.id === id) return node;
  }
  return undefined;
}

/** questionId -> folderId, built once at open time. */
export function folderIndex(nodes: readonly FolderNode[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of walkFolders(nodes)) {
    for (const id of node.questionIds) map.set(id, node.id);
  }
  return map;
}

/** All question ids under a folder, including its descendants. */
export function questionsUnder(node: FolderNode): string[] {
  const out = [...node.questionIds];
  for (const child of node.children) out.push(...questionsUnder(child));
  return out;
}

/** The longest a folder's name may be: a name is read in a list, and a long one only pushes the count off the screen. */
export const FOLDER_NAME_MAX = 80;

/**
 * A folder's name as it will be kept: the characters a file format forbids taken out, runs of spaces made one, the ends trimmed. A
 * name with nothing in it, or too long, is refused with a sentence a person can act on.
 */
export function cleanFolderName(name: string): string {
  const clean = stripInvalidCharacters(String(name ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  if (clean === "") throw new Error("A folder needs a name.");
  if ([...clean].length > FOLDER_NAME_MAX) throw new Error(`A folder's name can be at most ${FOLDER_NAME_MAX} characters.`);
  return clean;
}

/** What makes two folder names the same one: the letters, not the case or the way an accent is written. */
export function folderNameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/** A folder as the list shows it. `own` is the questions in it alone, `total` those in it and in every folder inside it. */
export interface FolderListing {
  id: string;
  name: string;
  depth: number;
  parentId: string | undefined;
  own: number;
  total: number;
}
