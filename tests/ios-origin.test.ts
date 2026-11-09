import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseConfig } from '../src/config.js';

test('the iPad shell bundles the server default origin', () => {
  const plist = readFileSync(new URL('../ios/Config/Info.plist', import.meta.url), 'utf8');
  const bundled = /<key>LLIME_ORIGIN<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  assert.equal(bundled, parseConfig({}).appOrigin);
});
