/**
 * Migrations.
 *
 * The mechanism exists from the first release even though there is nothing to
 * migrate yet, because retrofitting one into a shipped file format is the kind
 * of work worth never doing. Two rules:
 *
 *  - A bank from an older format version is migrated forward, step by step,
 *    with every step recorded.
 *  - A bank from a NEWER format version is refused with a clear message, not
 *    opened optimistically. Opening a future file and silently dropping the
 *    fields this build does not understand is how a shared bank gets
 *    corrupted by the one person who has not updated.
 */

import { BANK_FORMAT_VERSION } from "../naming.ts";

export interface MigrationContext {
  /** Collects a human-readable line per step, for the open report. */
  notes: string[];
}

export interface Migration {
  /** The version this migration reads. It produces `from + 1`. */
  from: number;
  description: string;
  migrateManifest?(manifest: Record<string, unknown>, ctx: MigrationContext): Record<string, unknown>;
  migrateQuestion?(question: Record<string, unknown>, ctx: MigrationContext): Record<string, unknown>;
}

/**
 * Registered oldest first. Version 1 is the first published format, so the
 * list is empty; the first entry will have `from: 1`.
 */
export const MIGRATIONS: readonly Migration[] = [];

export class FutureFormatError extends Error {
  readonly fileVersion: number;
  readonly supportedVersion: number;
  constructor(fileVersion: number) {
    super(
      `This bank was written in format version ${fileVersion}, and this build understands version ${BANK_FORMAT_VERSION}. ` +
        `Update OpenAssess before opening it. Opening it here would drop the parts this build does not understand.`,
    );
    this.name = "FutureFormatError";
    this.fileVersion = fileVersion;
    this.supportedVersion = BANK_FORMAT_VERSION;
  }
}

export interface MigrationResult<T> {
  value: T;
  fromVersion: number;
  toVersion: number;
  notes: string[];
}

function migrationsFrom(version: number): Migration[] {
  return MIGRATIONS.filter((m) => m.from >= version).sort((a, b) => a.from - b.from);
}

export function migrateManifest(
  manifest: Record<string, unknown>,
): MigrationResult<Record<string, unknown>> {
  const fileVersion = Number(manifest["formatVersion"] ?? 0);
  if (!Number.isFinite(fileVersion) || fileVersion < 1) {
    throw new Error("This file does not carry a format version, so it is not a bank this build can open.");
  }
  if (fileVersion > BANK_FORMAT_VERSION) throw new FutureFormatError(fileVersion);

  const ctx: MigrationContext = { notes: [] };
  let value = manifest;
  for (const migration of migrationsFrom(fileVersion)) {
    if (migration.migrateManifest) value = migration.migrateManifest(value, ctx);
    ctx.notes.push(`manifest: ${migration.description}`);
  }
  value = { ...value, formatVersion: BANK_FORMAT_VERSION };
  return { value, fromVersion: fileVersion, toVersion: BANK_FORMAT_VERSION, notes: ctx.notes };
}

export function migrateQuestion(
  question: Record<string, unknown>,
  fileVersion: number,
): MigrationResult<Record<string, unknown>> {
  if (fileVersion > BANK_FORMAT_VERSION) throw new FutureFormatError(fileVersion);
  const ctx: MigrationContext = { notes: [] };
  let value = question;
  for (const migration of migrationsFrom(fileVersion)) {
    if (migration.migrateQuestion) value = migration.migrateQuestion(value, ctx);
  }
  return { value, fromVersion: fileVersion, toVersion: BANK_FORMAT_VERSION, notes: ctx.notes };
}

export function needsMigration(fileVersion: number): boolean {
  return fileVersion < BANK_FORMAT_VERSION;
}
