import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Modules the browser imports through @core/*. They must run unchanged in Node and in the browser,
// so none of them (or anything they import) may reach a Node builtin, the database driver or I/O.
const src = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const REQUIRED_CORE = ['domain.ts', 'events.ts', 'routes.ts', 'copy.ts'];
// Pure rule modules that join the isomorphic core once their lanes add them.
const LATER_CORE = ['search.ts', 'assessment.ts', 'problems.ts'];

const specifierPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(specifierPattern)].map((m) => m[1] ?? '');
}

function isForbidden(specifier: string): boolean {
  const bare = specifier.split('/')[0] ?? specifier;
  return specifier.startsWith('node:') || builtinModules.includes(specifier) || builtinModules.includes(bare) || specifier === 'neo4j-driver' || specifier.startsWith('neo4j-driver/');
}

// Follows relative imports so a core module cannot reach a forbidden import indirectly.
function forbiddenImports(entry: string, seen = new Set<string>()): string[] {
  if (seen.has(entry)) return [];
  seen.add(entry);
  const found: string[] = [];
  for (const specifier of importSpecifiers(readFileSync(entry, 'utf8'))) {
    if (specifier.startsWith('.')) {
      const target = join(dirname(entry), specifier.replace(/\.js$/, '.ts'));
      found.push(...forbiddenImports(target, seen));
    } else if (isForbidden(specifier)) {
      found.push(`${entry}: ${specifier}`);
    }
  }
  return found;
}

test('the shared core modules exist', () => {
  for (const file of REQUIRED_CORE) assert.ok(existsSync(join(src, file)), `missing src/${file}`);
});

test('the isomorphic core imports no Node builtin and no database driver', () => {
  const core = [...REQUIRED_CORE, ...LATER_CORE.filter((file) => existsSync(join(src, file)))];
  assert.deepEqual(core.flatMap((file) => forbiddenImports(join(src, file))), []);
});

test('the import scan catches every forbidden import form', () => {
  const sample = [
    "import { readFile } from 'node:fs/promises';",
    "import crypto from 'crypto';",
    "import neo4j from 'neo4j-driver';",
    "const fs = await import('fs');",
    "const path = require('path');",
    "export { join } from 'node:path';",
    "import 'node:process';",
    "import { z } from 'zod';",
  ].join('\n');
  const flagged = importSpecifiers(sample).filter(isForbidden);
  assert.deepEqual(flagged, ['node:fs/promises', 'crypto', 'neo4j-driver', 'fs', 'path', 'node:path', 'node:process']);
});
