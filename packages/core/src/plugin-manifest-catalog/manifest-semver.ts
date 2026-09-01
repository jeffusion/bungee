import { semver } from 'bun';
import { PluginManifestCatalogError } from './parse-utils';

const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const RANGE_VERSION = /^(?:v)?(?:0|[1-9]\d*|[xX*])(?:\.(?:0|[1-9]\d*|[xX*])){0,2}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ATTACHED_COMPARATOR = /^(?:\^|~|>=|<=|>|<|=)(.+)$/;
const COMPARATORS = new Set(['^', '~', '>=', '<=', '>', '<', '=']);

export function parseExactSemver(value: string, path: string): string {
  const match = EXACT_SEMVER.exec(value);
  if (!match) throw new PluginManifestCatalogError(path, 'expected an exact semantic version');
  const prerelease = match[4];
  if (prerelease?.split('.').some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    throw new PluginManifestCatalogError(path, 'invalid semantic version prerelease');
  }
  return value;
}

function validRangeVersion(value: string): boolean {
  if (!RANGE_VERSION.test(value)) return false;
  const normalized = value.replace(/^v/, '');
  const [withoutBuild] = normalized.split('+', 1);
  const [core, prerelease] = (withoutBuild ?? '').split('-', 2);
  const parts = (core ?? '').split('.');
  if (parts.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return false;
  if (prerelease !== undefined) {
    if (parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part))) return false;
    if (prerelease.split('.').some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return false;
  }
  return true;
}

function validClause(clause: string): boolean {
  const hyphen = clause.split(/\s+-\s+/);
  if (hyphen.length === 2) return hyphen.every(validRangeVersion);
  if (hyphen.length !== 1) return false;
  const tokens = clause.trim().split(/\s+/);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (COMPARATORS.has(token)) {
      index += 1;
      if (!validRangeVersion(tokens[index] ?? '')) return false;
      continue;
    }
    const attached = ATTACHED_COMPARATOR.exec(token);
    if (!validRangeVersion(attached?.[1] ?? token)) return false;
  }
  return tokens.length > 0;
}

function validRangeSyntax(value: string): boolean {
  const clauses = value.split('||').map((clause) => clause.trim());
  return clauses.length > 0 && clauses.every((clause) => clause.length > 0 && validClause(clause));
}

export function validateEngineRange(
  value: string,
  path: string,
  actualVersion: string,
): string {
  if (!validRangeSyntax(value) || !semver.satisfies(actualVersion, value)) {
    throw new PluginManifestCatalogError(path, `engine mismatch or invalid range with ${actualVersion}`);
  }
  return value;
}
