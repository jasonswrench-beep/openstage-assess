/**
 * Bank-level types: the manifest, the folder tree, saved filters and the
 * query shape that the browser, the read contract and the test builder all
 * share.
 *
 * A bank is one file per course or book. The container layout is in
 * container/layout.ts; this file is only the shapes that go inside it.
 */

import type { BloomLevel, Difficulty, QuestionType, Status } from "./question.ts";

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
