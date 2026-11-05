/**
 * Reading what the screen sent, field by field. Nothing is taken on trust: a field is the type it should be and inside the range it
 * should be in, or the request is refused with words a person can read.
 */

import type { ApiRequest } from "./api.ts";
import { badRequest } from "./errors.ts";

export function jsonObject(req: ApiRequest): Record<string, unknown> {
  if (req.body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString("utf8"));
  } catch {
    throw badRequest("The request was not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw badRequest("The request was not a JSON object.");
  return parsed as Record<string, unknown>;
}

/** Fields the request may carry. One it does not know is refused, so that nothing rides in on a field nobody reads. */
export function onlyFields(input: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw badRequest(`${what} has a field, ${key}, that is not part of it.`);
}

export function text(value: unknown, what: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw badRequest(`${what} is needed.`);
    return undefined;
  }
  if (typeof value !== "string" || value.length > max) throw badRequest(`${what} must be text of at most ${max} characters.`);
  return value;
}

export function flag(value: unknown, what: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw badRequest(`${what} must be true or false.`);
  return value;
}

export function whole(value: unknown, what: string, min: number, max: number, fallback?: number): number {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw badRequest(`${what} is needed.`);
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw badRequest(`${what} must be a whole number from ${min} to ${max}.`);
  return value;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string, fallback?: T): T {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw badRequest(`Say ${what}, from ${allowed.join(", ")}.`);
  }
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw badRequest(`Say ${what}, from ${allowed.join(", ")}.`);
  return value as T;
}

/** A whole number from the address (a query value), or the fallback when it is not there. */
export function queryWhole(query: URLSearchParams, name: string, min: number, max: number, fallback?: number): number {
  const raw = query.get(name);
  if (raw === null) {
    if (fallback !== undefined) return fallback;
    throw badRequest(`${name} is needed.`);
  }
  const n = Number(raw);
  if (!/^\d{1,9}$/.test(raw) || !Number.isInteger(n) || n < min || n > max) throw badRequest(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function dateOf(value: unknown): string {
  if (value === undefined || value === null || value === "") return today();
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) throw badRequest("The date must be written like 2026-11-04.");
  return value;
}
