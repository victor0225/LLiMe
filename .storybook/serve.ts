// Starts Storybook on the configured loopback port, read the same way as the app's ports, with no
// credentials in its environment because stories never need them.
import { spawn } from 'node:child_process';
import { HOST, loadConfig } from '../src/config.ts';

const { storybookPort } = loadConfig();
const env = { ...process.env };
delete env.OPENAI_API_KEY;
delete env.NEO4J_PASSWORD;

const storybook = spawn('storybook', ['dev', '--host', HOST, '--port', String(storybookPort), '--no-open', '--disable-telemetry'], { stdio: 'inherit', env });
storybook.on('exit', (code) => process.exit(code ?? 1));
