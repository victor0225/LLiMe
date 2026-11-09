import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { repoRoot } from '../src/config.js';

test('doctor reports a failed database check without printing any secret value', () => {
  const password = 'doctor-test-password-sentinel';
  const key = 'doctor-test-key-sentinel';
  // Shell values win over .env; port 1 refuses at once, so no login attempt reaches the real database.
  const env = { ...process.env, NEO4J_PASSWORD: password, OPENAI_API_KEY: key, NEO4J_URI: 'bolt://127.0.0.1:1' };
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/doctor.ts'], { cwd: repoRoot, env, encoding: 'utf8', timeout: 60_000 });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.match(output, /^FAIL\s+db query\s+bolt:\/\/127\.0\.0\.1:1 refused/m);
  assert.match(output, /^PASS\s+provider key\s+OPENAI_API_KEY is set/m);
  assert.ok(!output.includes(password) && !output.includes(key), 'a secret value appeared in the doctor output');
});
