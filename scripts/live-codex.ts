// Live check of the Codex App Server on this computer. It starts one real stdio child, completes the
// handshake, reads the model catalog, starts one ephemeral thread with the selected model and its
// Fast tier, probes the steering methods and closes the child. It never starts a turn, so no model
// inference runs. Prints a sanitized summary and exits non-zero when any check fails.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { InitializeParams, v2 } from '../src/generated/codex/index.js';

// The Codex CLI release src/generated/codex and src/generated/codex-json were generated from.
// Experimental App Server fields can change between releases, so any other release fails here.
const CODEX_CLI_VERSION = '0.166.0';

const ROOT = resolve(import.meta.dirname, '..');
const AGENT_CWD = resolve(ROOT, '.runtime/agent');
const STDERR_LOG = resolve(ROOT, '.runtime/logs/live-codex.stderr.log');

const SELECTED_MODEL = 'gpt-6.1-terra';
const ALTERNATIVE_MODEL = 'gpt-6.1-sol';
// Fast is a service tier, found by its catalog name; the wire ID always comes from the catalog.
const FAST_TIER_NAME = 'Fast';

const STARTUP_DEADLINE_MS = 10_000; // child start + initialize
const REQUEST_DEADLINE_MS = 15_000; // each preflight request
const EXIT_DEADLINE_MS = 5_000; // graceful exit after stdin closes, before SIGTERM
const KILL_DEADLINE_MS = 2_000; // after SIGTERM, before SIGKILL
const MAX_LINE_BYTES = 1024 * 1024; // larger lines mean broken framing, not a real message
const METHOD_NOT_FOUND = -32601;
// Never a real turn ID, so steer and interrupt must fail on state, not on an unknown method.
const PROBE_TURN_ID = 'llime-probe-no-active-turn';

// Only what the CLI needs to find itself, its native login and the network. Provider keys and the
// database password never reach the child.
const CHILD_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'CODEX_HOME',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
];
const FORBIDDEN_CHILD_ENV = ['OPENAI_API_KEY', 'NEO4J_PASSWORD'];

// Inherited capabilities that could run user hooks, plugins, apps or helper processes when a thread
// starts. A connection check needs none of them, and no shared daemon may be started.
const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'plugin_discovery_prefetch',
  'hooks', 'memories', 'goals', 'multi_agent', 'skill_search', 'computer_use', 'browser_use',
  'browser_use_external', 'in_app_browser', 'image_generation', 'view_image', 'daemon_auto_start',
];

type Check = { name: string; ok: boolean; detail: string };
type Exit = { code: number | null; signal: NodeJS.Signals | null };

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what} is not a string`);
  return value;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not an array`);
  return value;
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function readCliVersion(env: NodeJS.ProcessEnv): string {
  const out = execFileSync('codex', ['--version'], { env, encoding: 'utf8', timeout: STARTUP_DEADLINE_MS });
  const match = /^codex-cli (\S+)$/m.exec(out);
  if (!match?.[1]) throw new Error('codex --version printed an unexpected format');
  return match[1];
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((done) => (timer = setTimeout(() => done(null), ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function directChildren(pid: number): { pid: number; command: string }[] {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' });
  return out.split('\n').flatMap((line) => {
    const [childPid, parentPid, ...command] = line.trim().split(/\s+/);
    if (Number(parentPid) !== pid) return [];
    // Basename only: full executable paths can include the home directory.
    return [{ pid: Number(childPid), command: command.join(' ').split('/').pop() ?? '' }];
  });
}

const withoutHome = (message: string) => (process.env.HOME ? message.replaceAll(process.env.HOME, '~') : message);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Newline-delimited JSON-RPC without the "jsonrpc" field. Both peers may send requests.
function connect(child: ChildProcessWithoutNullStreams) {
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const notifications = new Map<string, number>();
  const warnings: string[] = [];
  const unexpectedServerRequests: string[] = [];
  let nextId = 1;
  let broken: Error | null = null;

  const failAll = (error: Error) => {
    broken ??= error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return failAll(new Error('App Server sent an oversized line'));
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return failAll(new Error('App Server sent malformed JSON'));
    }
    const id = field(message, 'id');
    const method = field(message, 'method');
    if (typeof method === 'string' && id !== undefined) {
      // This check registers a tool but never starts a turn, so any server request is unexpected.
      unexpectedServerRequests.push(method);
      send({ id, error: { code: METHOD_NOT_FOUND, message: 'Unsupported llime server request' } });
      return;
    }
    if (typeof method === 'string') {
      notifications.set(method, (notifications.get(method) ?? 0) + 1);
      const params = field(message, 'params');
      const warning = method === 'warning' ? field(params, 'message') : method === 'configWarning' ? field(params, 'summary') : undefined;
      if (typeof warning === 'string') warnings.push(`${method}: ${withoutHome(warning)}`);
      return;
    }
    if (typeof id !== 'number') return failAll(new Error('App Server sent a response with an unknown ID'));
    const waiter = pending.get(id);
    if (!waiter) return failAll(new Error(`App Server answered request ${id}, which is not pending`));
    pending.delete(id);
    const error = field(message, 'error');
    if (error === undefined) return waiter.resolve(field(message, 'result'));
    const code = field(error, 'code');
    waiter.reject(new RpcError(typeof code === 'number' ? code : 0, String(field(error, 'message'))));
  });
  child.on('exit', (code, signal) => failAll(new Error(`App Server exited early (code ${code}, signal ${signal})`)));
  child.on('error', (error) => failAll(new Error(`App Server process error: ${error.message}`)));

  async function request(method: string, params: object, deadlineMs = REQUEST_DEADLINE_MS): Promise<unknown> {
    if (broken) throw broken;
    const id = nextId++;
    const reply = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
    send({ id, method, params });
    const timer = setTimeout(() => {
      pending.get(id)?.reject(new Error(`${method} timed out after ${deadlineMs} ms`));
      pending.delete(id);
    }, deadlineMs);
    return reply.finally(() => clearTimeout(timer));
  }

  return { request, notify: (method: string) => send({ method, params: {} }), notifications, warnings, unexpectedServerRequests };
}

async function readCatalog(request: (m: string, p: object) => Promise<unknown>): Promise<unknown[]> {
  const models: unknown[] = [];
  let cursor: string | null = null;
  do {
    const params: v2.ModelListParams = { limit: 20, includeHidden: false, cursor };
    const page = await request('model/list', params);
    models.push(...list(field(page, 'data'), 'model/list data'));
    const next = field(page, 'nextCursor');
    cursor = typeof next === 'string' ? next : null;
  } while (cursor);
  return models;
}

function describeModel(models: unknown[], id: string) {
  const entry = models.find((model) => field(model, 'id') === id);
  if (!entry) return null;
  const tiers = list(field(entry, 'serviceTiers'), `${id} serviceTiers`).map((tier) => ({
    id: text(field(tier, 'id'), 'service tier id'),
    name: text(field(tier, 'name'), 'service tier name'),
  }));
  const efforts = list(field(entry, 'supportedReasoningEfforts'), `${id} efforts`).map((option) =>
    text(field(option, 'reasoningEffort'), 'reasoning effort'),
  );
  return {
    id,
    displayName: field(entry, 'displayName'),
    hidden: field(entry, 'hidden'),
    isDefault: field(entry, 'isDefault'),
    serviceTiers: tiers,
    defaultServiceTier: field(entry, 'defaultServiceTier'),
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: field(entry, 'defaultReasoningEffort'),
    fastTierId: tiers.find((tier) => tier.name === FAST_TIER_NAME)?.id ?? null,
  };
}

// A method exists when the server rejects the call for its state, not for an unknown method.
async function probeMethod(request: (m: string, p: object) => Promise<unknown>, method: string, params: object) {
  try {
    await request(method, params);
    return { available: true, response: 'accepted' };
  } catch (error) {
    if (!(error instanceof RpcError)) throw error;
    const unknown = error.code === METHOD_NOT_FOUND || /unknown variant|method not found/i.test(error.message);
    return { available: !unknown, response: `error ${error.code}: ${error.message.slice(0, 160)}` };
  }
}

async function close(child: ChildProcessWithoutNullStreams, exited: Promise<Exit>) {
  child.stdin.end();
  const graceful = await within(exited, EXIT_DEADLINE_MS);
  if (graceful) return { ...graceful, escalation: 'none' };
  child.kill('SIGTERM');
  const terminated = await within(exited, KILL_DEADLINE_MS);
  if (terminated) return { ...terminated, escalation: 'SIGTERM' };
  child.kill('SIGKILL');
  return { ...((await within(exited, KILL_DEADLINE_MS)) ?? { code: null, signal: null }), escalation: 'SIGKILL' };
}

async function main(): Promise<number> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const summary: Record<string, unknown> = { pinnedCliVersion: CODEX_CLI_VERSION, selectedModel: SELECTED_MODEL };

  const env = childEnv();
  summary.childEnvKeys = Object.keys(env).sort();
  check('child environment excludes credentials', FORBIDDEN_CHILD_ENV.every((key) => !(key in env)), FORBIDDEN_CHILD_ENV.join(', '));

  const cliVersion = readCliVersion(env);
  summary.cliVersion = cliVersion;
  check('installed CLI matches the pin', cliVersion === CODEX_CLI_VERSION, `${cliVersion} vs ${CODEX_CLI_VERSION}`);
  if (cliVersion !== CODEX_CLI_VERSION) return report(summary, checks);

  mkdirSync(AGENT_CWD, { recursive: true });
  mkdirSync(resolve(STDERR_LOG, '..'), { recursive: true });
  const args = ['app-server', '--listen', 'stdio://', '-c', 'web_search="disabled"', ...DISABLED_FEATURES.flatMap((name) => ['--disable', name])];
  const child = spawn('codex', args, { cwd: AGENT_CWD, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise<Exit>((done) => child.once('exit', (code, signal) => done({ code, signal })));
  child.stderr.pipe(createWriteStream(STDERR_LOG));
  summary.childPid = child.pid;
  const rpc = connect(child);
  let descendants: { pid: number; command: string }[] = [];

  try {
    const initialize: InitializeParams = {
      clientInfo: { name: 'llime', title: 'llime', version: '0.1.0' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: ['item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta'],
      },
    };
    const init = await rpc.request('initialize', initialize, STARTUP_DEADLINE_MS);
    rpc.notify('initialized');
    // userAgent names the server build; codexHome and other paths are deliberately not printed.
    const [serverBuild = ''] = text(field(init, 'userAgent'), 'initialize userAgent').split(' ');
    summary.serverBuild = serverBuild;
    check('server build matches the pin', serverBuild.endsWith(`/${CODEX_CLI_VERSION}`), serverBuild);

    const accountParams: v2.GetAccountParams = { refreshToken: false };
    const account = await rpc.request('account/read', accountParams);
    const accountType = field(field(account, 'account'), 'type');
    summary.auth = { accountType: accountType ?? null, requiresOpenaiAuth: field(account, 'requiresOpenaiAuth') };
    check('native login present', typeof accountType === 'string', `account type ${String(accountType ?? 'none')}`);

    const configParams: v2.ConfigReadParams = { includeLayers: false, cwd: AGENT_CWD };
    const config = await rpc.request('config/read', configParams);
    const mcpServers = field(field(config, 'config'), 'mcp_servers');
    const mcpNames = typeof mcpServers === 'object' && mcpServers !== null ? Object.keys(mcpServers) : [];
    summary.inheritedMcpServers = mcpNames.length;

    const models = await readCatalog(rpc.request);
    const selected = describeModel(models, SELECTED_MODEL);
    const alternative = describeModel(models, ALTERNATIVE_MODEL);
    summary.catalog = { modelIds: models.map((model) => field(model, 'id')), selected, alternative };
    check(`${SELECTED_MODEL} offers ${FAST_TIER_NAME}`, Boolean(selected?.fastTierId), JSON.stringify(selected?.serviceTiers ?? 'missing'));
    check(`${ALTERNATIVE_MODEL} offers ${FAST_TIER_NAME}`, Boolean(alternative?.fastTierId), JSON.stringify(alternative?.serviceTiers ?? 'missing'));
    // No fallback to another model or tier: the run would no longer be the one that was chosen.
    if (!selected?.fastTierId) throw new Error(`${SELECTED_MODEL} with ${FAST_TIER_NAME} is unavailable; no thread started`);

    const threadParams: v2.ThreadStartParams = {
      model: SELECTED_MODEL,
      serviceTier: selected.fastTierId,
      modelProvider: 'openai',
      allowProviderModelFallback: false,
      cwd: AGENT_CWD,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      environments: [],
      config: Object.fromEntries(mcpNames.map((name) => [`mcp_servers.${name}.enabled`, false])),
      dynamicTools: [
        {
          type: 'function',
          name: 'connection_probe',
          description: 'Registered only to confirm that dynamic tools are accepted. Never call it.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          deferLoading: false,
        },
      ],
    };
    const started = await rpc.request('thread/start', threadParams);
    const threadId = text(field(field(started, 'thread'), 'id'), 'thread id');
    summary.thread = {
      threadId,
      sessionId: field(field(started, 'thread'), 'sessionId'),
      ephemeral: field(field(started, 'thread'), 'ephemeral'),
      model: field(started, 'model'),
      serviceTier: field(started, 'serviceTier'),
      sandbox: field(field(started, 'sandbox'), 'type'),
      approvalPolicy: field(started, 'approvalPolicy'),
    };
    check('thread/start accepted dynamicTools', true, `thread ${threadId}`);
    check('thread runs the selected model', field(started, 'model') === SELECTED_MODEL, String(field(started, 'model')));
    check('thread runs the Fast tier', field(started, 'serviceTier') === selected.fastTierId, String(field(started, 'serviceTier')));
    check('thread is ephemeral', field(field(started, 'thread'), 'ephemeral') === true, String(field(field(started, 'thread'), 'ephemeral')));

    const steer: v2.TurnSteerParams = {
      threadId,
      input: [{ type: 'text', text: 'connection check', text_elements: [] }],
      expectedTurnId: PROBE_TURN_ID,
    };
    const interrupt: v2.TurnInterruptParams = { threadId, turnId: PROBE_TURN_ID };
    const steerProbe = await probeMethod(rpc.request, 'turn/steer', steer);
    const interruptProbe = await probeMethod(rpc.request, 'turn/interrupt', interrupt);
    summary.methods = { 'turn/steer': steerProbe, 'turn/interrupt': interruptProbe };
    check('turn/steer is available', steerProbe.available, steerProbe.response);
    check('turn/interrupt is available', interruptProbe.available, interruptProbe.response);

    descendants = directChildren(child.pid ?? -1);
    summary.childProcesses = descendants.map((process) => process.command);
  } catch (error) {
    check('protocol exchange', false, error instanceof Error ? error.message : String(error));
  } finally {
    const exit = await close(child, exited);
    summary.exit = exit;
    summary.notifications = Object.fromEntries(rpc.notifications);
    summary.warnings = rpc.warnings;
    check('no unexpected server requests', rpc.unexpectedServerRequests.length === 0, rpc.unexpectedServerRequests.join(', ') || 'none');
    check('child exited cleanly on stdin close', exit.code === 0 && exit.escalation === 'none', JSON.stringify(exit));
    const survivors = [child.pid ?? -1, ...descendants.map((process) => process.pid)].filter(isAlive);
    check('no child process survives', survivors.length === 0, survivors.length ? `alive: ${survivors.join(', ')}` : 'none');
  }
  return report(summary, checks);
}

function report(summary: Record<string, unknown>, checks: Check[]): number {
  const passed = checks.every((item) => item.ok);
  console.log(JSON.stringify({ ...summary, checks, result: passed ? 'PASS' : 'FAIL' }, null, 2));
  if (!passed) console.error(`Codex live check failed; App Server stderr is in ${STDERR_LOG}`);
  return passed ? 0 : 1;
}

process.exitCode = await main();
