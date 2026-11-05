#!/usr/bin/env node
/** Generate client MCP configuration; installation is explicit and only adds one server. */
import { constants, accessSync, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '../..');
const SCHEMA = 'workloom.edit-agent-setup/v1';
const MAX_CONFIG = 2 * 1024 * 1024;
export const FORWARDED_ENV_NAMES = Object.freeze([
  'WORKLOOM_ACCESS_TOKEN', 'WORKLOOM_DESKTOP_LOGIN_KEY',
  'WORKLOOM_BUDGET_GATEWAY_TOKEN', 'WORKLOOM_BUDGET_TASK_ID', 'WORKLOOM_BUDGET_APPROVED_MICRO_CNY',
  'LLM_BASE_URL', 'ARK_BASE_URL',
]);
const SECRET_NAMES = /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/iu;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inside = (root, file) => { const rel = relative(root, file); return rel === '' || rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
const hash = value => createHash('sha256').update(value).digest('hex');
export class SetupError extends Error { constructor(code) { super(code); this.code = code; } }
const check = (ok, code) => { if (!ok) throw new SetupError(code); };
function safeText(value) { return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value); }
function canonicalPath(value, code) {
  check(safeText(value) && isAbsolute(value), code);
  let actual; try { actual = realpathSync(value); } catch { throw new SetupError(code); }
  return actual;
}
function privateRoot(value, repo, code) {
  const actual = canonicalPath(value, code), stat = lstatSync(actual);
  check(stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700
    && !inside(repo, actual) && !inside(actual, repo), code);
  return actual;
}
function apiAddress(value) {
  let api; try { api = new URL(value); } catch { throw new SetupError('EDIT_SETUP_API_INVALID'); }
  check(api.protocol === 'http:' && api.hostname === '127.0.0.1' && api.port
    && (value === api.origin || value === api.origin + '/'), 'EDIT_SETUP_API_INVALID');
  return api.origin;
}
function ensureNoSecretValues(value, env) {
  const strings = [];
  const visit = item => {
    if (typeof item === 'string') strings.push(item);
    else if (item && typeof item === 'object') for (const child of Object.values(item)) visit(child);
  };
  visit(value);
  for (const [name, secret] of Object.entries(env)) {
    if (SECRET_NAMES.test(name) && typeof secret === 'string' && secret.length >= 8) {
      check(strings.every(text => !text.includes(secret)), 'EDIT_SETUP_CREDENTIAL_IN_CONFIGURATION');
    }
  }
}
export function createClientConfiguration(options, env = process.env) {
  check(object(options) && ['codex', 'qoder', 'stdio'].includes(options.client), 'EDIT_SETUP_CLIENT_REQUIRED');
  const repo = canonicalPath(options.repo ?? ROOT, 'EDIT_SETUP_REPOSITORY_INVALID');
  let product; try { product = JSON.parse(readFileSync(join(repo, 'product.manifest.json'), 'utf8')); } catch { throw new SetupError('EDIT_SETUP_REPOSITORY_INVALID'); }
  check(product.productId === 'workloom-ai-video-edit' && product.repository === 'workloom-ai/WorkLoom-video-edit'
    && existsSync(join(repo, 'scripts/edit-agent-mcp.mjs')), 'EDIT_SETUP_REPOSITORY_INVALID');
  const node = canonicalPath(options.node ?? process.execPath, 'EDIT_SETUP_NODE_INVALID');
  try { check(lstatSync(node).isFile(), 'EDIT_SETUP_NODE_INVALID'); accessSync(node, constants.X_OK); } catch { throw new SetupError('EDIT_SETUP_NODE_INVALID'); }
  const version = spawnSync(node, ['--version'], { env: {}, encoding: 'utf8', timeout: 5000, maxBuffer: 8192 });
  check(version.status === 0 && /^v(2[4-9]|[3-9]\d|[1-9]\d{2,})\.\d+\.\d+(?:[-+][^\r\n]+)?\s*$/u.test(version.stdout ?? ''), 'EDIT_SETUP_NODE_VERSION_REQUIRED');
  const name = options.serverName ?? 'workloom-video-edit';
  check(typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(name), 'EDIT_SETUP_SERVER_NAME_INVALID');
  const api = apiAddress(options.api ?? env.WORKLOOM_BASE_URL);
  const jobsRoot = privateRoot(options.jobsRoot ?? env.WORKLOOM_EDIT_JOBS_ROOT, repo, 'EDIT_SETUP_JOBS_ROOT_INVALID');
  const studioValue = options.studioRoot ?? env.WORKLOOM_EDIT_STUDIO_ROOT;
  const studioRoot = privateRoot(studioValue, repo, 'EDIT_SETUP_STUDIO_ROOT_INVALID');
  check(!inside(jobsRoot, studioRoot) && !inside(studioRoot, jobsRoot), 'EDIT_SETUP_ROOTS_OVERLAP');
  const launch = { command: node, args: [join(repo, 'scripts/edit-agent-mcp.mjs')], cwd: repo,
    env: { WORKLOOM_PRODUCT_ROOT: repo, WORKLOOM_BASE_URL: api, WORKLOOM_DEV_AUTO_LOGIN: '0',
      WORKLOOM_EDIT_JOBS_ROOT: jobsRoot, WORKLOOM_EDIT_STUDIO_ROOT: studioRoot } };
  let config, content;
  if (options.client === 'codex') {
    config = { ...launch, startup_timeout_sec: 60, env_vars: [...FORWARDED_ENV_NAMES] };
    const quote = value => JSON.stringify(value);
    content = `# BEGIN WORKLOOM EDIT MCP ${name}\n[mcp_servers.${name}]\ncommand = ${quote(node)}\nargs = ${JSON.stringify(launch.args)}\ncwd = ${quote(repo)}\nstartup_timeout_sec = 60\nenv_vars = ${JSON.stringify(FORWARDED_ENV_NAMES)}\n\n[mcp_servers.${name}.env]\n`
      + Object.entries(launch.env).map(([key, value]) => `${key} = ${quote(value)}\n`).join('')
      + `# END WORKLOOM EDIT MCP ${name}\n`;
  } else if (options.client === 'qoder') {
    config = { type: 'stdio', ...launch };
    content = JSON.stringify({ mcpServers: { [name]: config } }, null, 2) + '\n';
  } else {
    config = { transport: 'stdio', ...launch, forwardEnvironmentNames: [...FORWARDED_ENV_NAMES] };
    content = JSON.stringify(config, null, 2) + '\n';
  }
  ensureNoSecretValues({ config, content }, env);
  return { schemaVersion: SCHEMA, client: options.client, serverName: name, config, content,
    forwardEnvironmentNames: [...FORWARDED_ENV_NAMES],
    authentication: options.client === 'codex' ? 'forward-named-process-environment'
      : 'supply-named-variables-to-the-client-process-and-verify-with-edit.agent.doctor',
    installed: false, paidCalls: 0 };
}

function mergeCodex(previous, generated) {
  const name = generated.serverName, begin = `# BEGIN WORKLOOM EDIT MCP ${name}`, end = `# END WORKLOOM EDIT MCP ${name}`;
  const starts = previous.split(begin).length - 1, ends = previous.split(end).length - 1;
  if (starts || ends) {
    check(starts === 1 && ends === 1, 'EDIT_SETUP_CONFIG_CONFLICT');
    const start = previous.indexOf(begin), stop = previous.indexOf(end) + end.length;
    check(stop > start, 'EDIT_SETUP_CONFIG_CONFLICT');
    check(previous.slice(start, stop).replace(/\r\n/gu, '\n') === generated.content.trimEnd(), 'EDIT_SETUP_CONFIG_CONFLICT');
    // A second unmanaged definition outside our block is a conflict too.
    check(!hasCodexTarget(previous.slice(0, start) + previous.slice(stop), name), 'EDIT_SETUP_CONFIG_CONFLICT');
    return previous;
  }
  check(!hasCodexTarget(previous, name), 'EDIT_SETUP_CONFIG_CONFLICT');
  return previous + (previous && !previous.endsWith('\n') ? '\n' : '') + (previous ? '\n' : '') + generated.content;
}
function hasCodexTarget(text, name) {
  // Append only to the ordinary table form. Complex TOML stays untouched for manual review.
  check(!text.includes('"""') && !text.includes("'''"), 'EDIT_SETUP_TOML_MANUAL_MERGE_REQUIRED');
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let quote = null;
    for (let index = 0; index < line.length; index++) {
      const character = line[index];
      if (!quote && character === '#') break;
      if (quote === '"' && character === '\\') { index++; continue; }
      if (quote && character === quote) quote = null;
      else if (!quote && (character === '"' || character === "'")) quote = character;
    }
    check(quote === null, 'EDIT_SETUP_TOML_MANUAL_MERGE_REQUIRED');
    check(!/^["'][^=]*\\[^=]*["']\s*(?:\.|=)/u.test(line), 'EDIT_SETUP_TOML_MANUAL_MERGE_REQUIRED');
    check(!/^(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*=/u.test(line), 'EDIT_SETUP_TOML_MANUAL_MERGE_REQUIRED');
    if (!line.startsWith('[')) continue;
    check(!line.slice(0, line.indexOf(']') + 1).includes('\\'), 'EDIT_SETUP_TOML_MANUAL_MERGE_REQUIRED');
    const header = line.match(/^\[([^\]]+)\]\s*(?:#.*)?$/u);
    if (!header) {
      check(!line.includes('mcp_servers'), 'EDIT_SETUP_TOML_MANUAL_MERGE_REQUIRED');
      continue;
    }
    const segments = header[1].split('.').map(part => part.trim().replace(/^(?:"([^"\\]+)"|'([^']+)'|([A-Za-z0-9_-]+))$/u, (_, a, b, c) => a ?? b ?? c));
    if (segments[0] !== 'mcp_servers') continue;
    check(segments.length > 1, 'EDIT_SETUP_TOML_MANUAL_MERGE_REQUIRED');
    check(segments.every(part => /^[A-Za-z0-9_-]+$/u.test(part)), 'EDIT_SETUP_TOML_MANUAL_MERGE_REQUIRED');
    if (segments[1] === name) return true;
  }
  // A dotted assignment can define the same server without a table header.
  check(!/^\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\./mu.test(text), 'EDIT_SETUP_TOML_MANUAL_MERGE_REQUIRED');
  return false;
}
function mergeQoder(previous, generated) {
  let config; try { config = previous.trim() ? JSON.parse(previous) : {}; } catch { throw new SetupError('EDIT_SETUP_JSON_INVALID'); }
  check(object(config) && (!Object.hasOwn(config, 'mcpServers') || object(config.mcpServers)), 'EDIT_SETUP_JSON_INVALID');
  const servers = config.mcpServers ?? {};
  if (Object.hasOwn(servers, generated.serverName)) {
    const stable = value => JSON.stringify(value, (_, item) => object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
    check(stable(servers[generated.serverName]) === stable(generated.config), 'EDIT_SETUP_CONFIG_CONFLICT');
    return previous;
  }
  return JSON.stringify({ ...config, mcpServers: { ...servers, [generated.serverName]: generated.config } }, null, 2) + '\n';
}
function readTarget(target) {
  let fd;
  try {
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    check(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && stat.size <= MAX_CONFIG, 'EDIT_SETUP_CONFIG_UNSAFE');
    const bytes = readFileSync(fd); check(bytes.length <= MAX_CONFIG, 'EDIT_SETUP_CONFIG_UNSAFE');
    return { bytes, stat, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error instanceof SetupError ? error : new SetupError('EDIT_SETUP_CONFIG_UNSAFE');
  } finally { if (fd !== undefined) closeSync(fd); }
}
function writePrivate(file, bytes) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
export function installClientConfiguration(generated, target, env = process.env) {
  check(generated.client === 'codex' || generated.client === 'qoder', 'EDIT_SETUP_STDIO_INSTALL_UNSUPPORTED');
  ensureNoSecretValues({ generated, target }, env);
  check(safeText(target) && isAbsolute(target) && resolve(target) === target, 'EDIT_SETUP_CONFIG_PATH_REQUIRED');
  let parent; try { parent = realpathSync(dirname(target)); } catch { throw new SetupError('EDIT_SETUP_CONFIG_PARENT_REQUIRED'); }
  const parentStat = lstatSync(parent);
  check(parent === dirname(target) && parentStat.uid === process.getuid?.() && (parentStat.mode & 0o022) === 0, 'EDIT_SETUP_CONFIG_UNSAFE');
  const lock = target + '.edit-setup.lock', temporary = target + '.edit-setup-' + randomUUID();
  let locked = false, temporaryCreated = false;
  try {
    try { writePrivate(lock, 'workloom.edit-agent-setup/v1\n'); locked = true; } catch { throw new SetupError('EDIT_SETUP_CONFIG_BUSY'); }
    const prior = readTarget(target), before = prior?.text ?? '';
    const after = generated.client === 'codex' ? mergeCodex(before, generated) : mergeQoder(before, generated);
    ensureNoSecretValues(generated, env); // Existing user values are preserved without being returned or logged.
    if (after === before) return { schemaVersion: SCHEMA, installed: true, changed: false, client: generated.client, serverName: generated.serverName, configPath: target, backupPath: null, paidCalls: 0 };
    writePrivate(temporary, after); temporaryCreated = true;
    const latest = readTarget(target);
    check(Boolean(latest) === Boolean(prior) && (!prior || latest.stat.ino === prior.stat.ino && hash(latest.bytes) === hash(prior.bytes)), 'EDIT_SETUP_CONFIG_CHANGED');
    let backupPath = null;
    if (prior) {
      backupPath = target + '.backup-' + new Date().toISOString().replace(/[:.]/gu, '-') + '-' + randomUUID();
      writePrivate(backupPath, prior.bytes);
      renameSync(temporary, target); temporaryCreated = false;
    } else {
      linkSync(temporary, target); unlinkSync(temporary); temporaryCreated = false;
    }
    const directory = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    return { schemaVersion: SCHEMA, installed: true, changed: true, client: generated.client, serverName: generated.serverName,
      configPath: target, backupPath, sha256: hash(Buffer.from(after)), paidCalls: 0 };
  } catch (error) { throw error instanceof SetupError ? error : new SetupError('EDIT_SETUP_INSTALL_FAILED'); }
  finally { if (temporaryCreated) unlinkSync(temporary); if (locked) unlinkSync(lock); }
}

export function parseSetupArguments(args) {
  const options = {}, values = new Map([['--client', 'client'], ['--repo', 'repo'], ['--node', 'node'], ['--api', 'api'], ['--jobs-root', 'jobsRoot'], ['--studio-root', 'studioRoot'], ['--server-name', 'serverName'], ['--config', 'config']]);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help') { check(!options.help, 'EDIT_SETUP_ARGUMENT_INVALID'); options.help = true; }
    else if (flag === '--install') { check(!options.install, 'EDIT_SETUP_ARGUMENT_INVALID'); options.install = true; }
    else {
      const key = values.get(flag), value = args[++index];
      check(key && !Object.hasOwn(options, key) && safeText(value) && !value.startsWith('--'), 'EDIT_SETUP_ARGUMENT_INVALID');
      options[key] = value;
    }
  }
  check(!options.config || options.install, 'EDIT_SETUP_INSTALL_FLAG_REQUIRED');
  return options;
}
export function main(args = process.argv.slice(2), env = process.env) {
  try {
    const options = parseSetupArguments(args);
    if (options.help) {
      process.stdout.write('Generate (default): node scripts/tools/edit-agent-setup.mjs --client codex|qoder|stdio --repo ABS --node ABS --api http://127.0.0.1:PORT --jobs-root ABS --studio-root ABS [--server-name NAME]\nInstall: add --install --config ABS_EXISTING_PARENT/config.toml|settings.json\nAuth is forwarded by environment variable name only. No provider keys, global permissions or sandbox settings are written. Qoder IDE: use Settings > MCP > My Servers > Add and merge generated mcpServers JSON; use its selected path for explicit installation.\n');
      return 0;
    }
    const generated = createClientConfiguration(options, env);
    if (options.install) process.stdout.write(JSON.stringify(installClientConfiguration(generated, options.config, env)) + '\n');
    else process.stdout.write(generated.content);
    return 0;
  } catch (error) {
    const code = error instanceof SetupError ? error.code : 'EDIT_SETUP_FAILED';
    process.stderr.write(JSON.stringify({ error: { code, message: code }, installed: false, paidCalls: 0 }) + '\n');
    return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main();
