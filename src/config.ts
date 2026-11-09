// Validated process configuration. Values come from the worktree .env and the shell; a variable set
// in the shell wins, so a Task can assign its ports inline without editing files.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { z } from 'zod';

// Everything listens on loopback only: the student UI, the lesson inbox and the agent stay on this Mac.
export const HOST = '127.0.0.1';
const LOOPBACK_HOSTS = new Set([HOST, 'localhost']);

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// An empty value (as in .env.example) means unset, never an empty password or port.
const unsetIfEmpty = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === '' ? undefined : value), schema);
const port = (fallback: number) => unsetIfEmpty(z.coerce.number().int().min(1024).max(65535).default(fallback));

// Codex models a run may use; the choice is frozen per run and never silently swapped.
export const ModelSchema = z.enum(['gpt-6.1-terra', 'gpt-6.1-sol']);

const EnvSchema = z
  .object({
    PORT: port(4317),
    VITE_PORT: port(5173),
    STORYBOOK_PORT: port(6006),
    NEO4J_URI: unsetIfEmpty(
      z
        .string()
        .default('bolt://127.0.0.1:17687')
        .refine((uri) => URL.canParse(uri) && LOOPBACK_HOSTS.has(new URL(uri).hostname), 'NEO4J_URI must point at the local loopback database'),
    ),
    NEO4J_USER: unsetIfEmpty(z.string().default('neo4j')),
    NEO4J_PASSWORD: unsetIfEmpty(z.string().optional()),
    LLIME_MODEL: unsetIfEmpty(ModelSchema.default('gpt-6.1-terra')),
    LLIME_SERVICE_TIER: unsetIfEmpty(z.string().optional()),
    OPENAI_API_KEY: unsetIfEmpty(z.string().optional()),
    // The iPad Simulator that receives this Task's notifications; the notifier validates its format.
    SIMULATOR_UDID: unsetIfEmpty(z.string().optional()),
  })
  .refine((env) => new Set([env.PORT, env.VITE_PORT, env.STORYBOOK_PORT]).size === 3, 'PORT, VITE_PORT and STORYBOOK_PORT must differ');

export type Config = {
  port: number;
  vitePort: number;
  storybookPort: number;
  // The one origin the browser, the iPad shell, Playwright and the Storybook /api proxy use.
  appOrigin: string;
  // Where Storybook serves stories; its /api proxy forwards to appOrigin.
  storybookOrigin: string;
  neo4j: { uri: string; user: string; password: string | undefined };
  model: z.infer<typeof ModelSchema>;
  serviceTier: string | undefined;
  openaiApiKey: string | undefined;
  simulatorUdid: string | undefined;
};

export function parseConfig(vars: Record<string, string | undefined>): Config {
  const result = EnvSchema.safeParse(vars);
  // Report which variables are wrong without echoing their values, which may be secrets.
  if (!result.success) throw new Error(`Invalid configuration: ${result.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`).join('; ')}`);
  const env = result.data;
  return {
    port: env.PORT,
    vitePort: env.VITE_PORT,
    storybookPort: env.STORYBOOK_PORT,
    appOrigin: `http://${HOST}:${env.PORT}`,
    storybookOrigin: `http://${HOST}:${env.STORYBOOK_PORT}`,
    neo4j: { uri: env.NEO4J_URI, user: env.NEO4J_USER, password: env.NEO4J_PASSWORD },
    model: env.LLIME_MODEL,
    serviceTier: env.LLIME_SERVICE_TIER,
    openaiApiKey: env.OPENAI_API_KEY,
    simulatorUdid: env.SIMULATOR_UDID,
  };
}

// Reads <repo>/.env without copying it into process.env, so child processes never inherit its secrets.
export function loadConfig(shell: NodeJS.ProcessEnv = process.env): Config {
  const file = join(repoRoot, '.env');
  const fromFile = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  return parseConfig({ ...fromFile, ...shell });
}
