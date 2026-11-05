import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createClientConfiguration, FORWARDED_ENV_NAMES, installClientConfiguration, parseSetupArguments } from './edit-agent-setup.mjs';

const TOOL = resolve(import.meta.dirname, 'edit-agent-setup.mjs');
const secret = 'synthetic-auth-value-used-only-in-offline-fixtures';
function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'Edit 工作台 空格-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, '源 仓库'), jobsRoot = join(base, '私有 作业'), studioRoot = join(base, '前期 归档');
  for (const folder of [repo, jobsRoot, studioRoot, join(repo, 'scripts')]) mkdirSync(folder, { mode: 0o700 });
  writeFileSync(join(repo, 'product.manifest.json'), JSON.stringify({ productId: 'workloom-ai-video-edit', repository: 'workloom-ai/WorkLoom-video-edit' }));
  writeFileSync(join(repo, 'scripts/edit-agent-mcp.mjs'), 'process.exit(0);\n');
  const options = { client: 'codex', repo, jobsRoot, studioRoot, api: 'http://127.0.0.1:48787', node: process.execPath };
  return { base, repo, jobsRoot, studioRoot, options };
}
const code = expected => error => error.code === expected;
function backups(base) { return readdirSync(base).filter(name => name.includes('.backup-')); }

test('default generation uses absolute escaped paths and named secret forwarding without writes', t => {
  const { base, repo, options } = fixture(t), before = readdirSync(base);
  const generated = createClientConfiguration(options, { WORKLOOM_ACCESS_TOKEN: secret, DEEPSEEK_API_KEY: 'synthetic-provider-key' });
  assert.equal(generated.installed, false); assert.equal(generated.paidCalls, 0);
  assert.equal(generated.config.command, realpathSync(process.execPath));
  assert.deepEqual(generated.config.args, [join(repo, 'scripts/edit-agent-mcp.mjs')]);
  assert.equal(generated.config.cwd, repo);
  assert.deepEqual(generated.config.env_vars, [...FORWARDED_ENV_NAMES]);
  assert.ok(!generated.content.includes(secret)); assert.ok(!generated.content.includes('synthetic-provider-key'));
  assert.ok(!generated.content.includes('approval_policy')); assert.ok(!generated.content.includes('sandbox_mode'));
  assert.deepEqual(readdirSync(base), before);
});
test('Qoder generates official mcpServers shape; stdio recipe exposes forwarding names only', t => {
  const { options } = fixture(t);
  const qoder = createClientConfiguration({ ...options, client: 'qoder' }, { WORKLOOM_DESKTOP_LOGIN_KEY: secret });
  const server = JSON.parse(qoder.content).mcpServers['workloom-video-edit'];
  assert.equal(server.type, 'stdio'); assert.equal(server.cwd, options.repo);
  assert.equal(server.env.WORKLOOM_BASE_URL, options.api);
  assert.ok(!Object.hasOwn(server.env, 'WORKLOOM_DESKTOP_LOGIN_KEY'));
  assert.ok(!Object.hasOwn(server, 'trust')); assert.ok(!Object.hasOwn(server, 'alwaysAllow'));
  const recipe = JSON.parse(createClientConfiguration({ ...options, client: 'stdio' }, {}).content);
  assert.equal(recipe.transport, 'stdio'); assert.deepEqual(recipe.forwardEnvironmentNames, [...FORWARDED_ENV_NAMES]);
});
test('Codex installation preserves provider, permissions, sandbox and another MCP byte for byte, with original backup', t => {
  const { base, options } = fixture(t), config = join(base, 'config.toml');
  const before = '# user settings\nmodel_provider = "local"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n\n[model_providers.local]\nbase_url = "http://127.0.0.1:9000"\n\n[mcp_servers.other]\ncommand = "other-node"\n';
  writeFileSync(config, before);
  const generated = createClientConfiguration(options, {}), result = installClientConfiguration(generated, config, {});
  assert.equal(result.changed, true); assert.equal(result.installed, true);
  assert.equal(readFileSync(result.backupPath, 'utf8'), before);
  assert.equal(readFileSync(config, 'utf8'), before + '\n' + generated.content);
  assert.equal(lstatSync(config).mode & 0o777, 0o600);
  assert.equal(lstatSync(result.backupPath).mode & 0o777, 0o600);
  const second = installClientConfiguration(generated, config, {});
  assert.equal(second.changed, false); assert.equal(second.backupPath, null); assert.equal(backups(base).length, 1);
});
test('Qoder safe merge retains provider, global permissions and unrelated server settings', t => {
  const { base, options } = fixture(t), config = join(base, 'settings.local.json');
  const before = { model: { provider: 'existing' }, permissions: { deny: ['dangerous'] }, mcpServers: { other: { command: '/other', args: ['arg'] } } };
  writeFileSync(config, JSON.stringify(before));
  const generated = createClientConfiguration({ ...options, client: 'qoder' }, {});
  const result = installClientConfiguration(generated, config, {}), after = JSON.parse(readFileSync(config, 'utf8'));
  assert.deepEqual(after.model, before.model); assert.deepEqual(after.permissions, before.permissions);
  assert.deepEqual(after.mcpServers.other, before.mcpServers.other);
  assert.deepEqual(after.mcpServers['workloom-video-edit'], generated.config);
  assert.equal(readFileSync(result.backupPath, 'utf8'), JSON.stringify(before));
  assert.equal(installClientConfiguration(generated, config, {}).changed, false);
});
test('creating a new config is private and explicit; no existing file means no backup', t => {
  const { base, options } = fixture(t), config = join(base, 'config.toml');
  const result = installClientConfiguration(createClientConfiguration(options, {}), config, {});
  assert.equal(result.backupPath, null); assert.equal(lstatSync(config).mode & 0o777, 0o600);
  assert.equal(readdirSync(base).some(name => name.includes('.edit-setup-')), false);
});
test('different existing Codex server, changed managed server and quoted target refuse all writes', t => {
  const { base, options } = fixture(t), config = join(base, 'config.toml'), generated = createClientConfiguration(options, {});
  for (const before of ['[mcp_servers.workloom-video-edit]\ncommand="different"\n', '["mcp_servers"."workloom-video-edit"]\ncommand="different"\n', generated.content.replace('startup_timeout_sec = 60', 'startup_timeout_sec = 90')]) {
    writeFileSync(config, before);
    assert.throws(() => installClientConfiguration(generated, config, {}), code('EDIT_SETUP_CONFIG_CONFLICT'));
    assert.equal(readFileSync(config, 'utf8'), before);
  }
  assert.equal(backups(base).length, 0);
});
test('Qoder conflict, malformed JSON and wrong root shape retain original bytes', t => {
  const { base, options } = fixture(t), config = join(base, 'settings.json');
  const generated = createClientConfiguration({ ...options, client: 'qoder' }, {});
  for (const [before, expected] of [['{"mcpServers":{"workloom-video-edit":{"command":"other"}}}', 'EDIT_SETUP_CONFIG_CONFLICT'], ['{broken', 'EDIT_SETUP_JSON_INVALID'], ['[]', 'EDIT_SETUP_JSON_INVALID'], ['{"mcpServers":[]}', 'EDIT_SETUP_JSON_INVALID']]) {
    writeFileSync(config, before); assert.throws(() => installClientConfiguration(generated, config, {}), code(expected));
    assert.equal(readFileSync(config, 'utf8'), before);
  }
  assert.equal(backups(base).length, 0);
});
test('complex TOML forms are refused for manual merge and never rewritten', t => {
  const { base, options } = fixture(t), config = join(base, 'config.toml'), generated = createClientConfiguration(options, {});
  for (const before of ['mcp_servers = {other = {command="x"}}\n', '[mcp_servers]\nother = { command="x" }\n', 'mcp_servers.other.command = "x"\n', 'instructions = """\nmultiline\n"""\n', '["mcp\\u005fservers"."workloom-video-edit"]\ncommand="other"\n', '"mcp\\u005fservers" = {}\n', 'model = "unterminated\n']) {
    writeFileSync(config, before);
    assert.throws(() => installClientConfiguration(generated, config, {}), code('EDIT_SETUP_TOML_MANUAL_MERGE_REQUIRED'));
    assert.equal(readFileSync(config, 'utf8'), before);
  }
});
test('symlink, hardlink, parent symlink and held lock are refused without touching target', t => {
  const { base, options } = fixture(t), original = join(base, 'original.toml'), linked = join(base, 'config.toml');
  const generated = createClientConfiguration(options, {}); writeFileSync(original, 'model="existing"\n');
  symlinkSync(original, linked);
  assert.throws(() => installClientConfiguration(generated, linked, {}), code('EDIT_SETUP_CONFIG_UNSAFE'));
  rmSync(linked); linkSync(original, linked);
  assert.throws(() => installClientConfiguration(generated, linked, {}), code('EDIT_SETUP_CONFIG_UNSAFE')); rmSync(linked);
  const folder = join(base, 'actual'); mkdirSync(folder); symlinkSync(folder, join(base, 'alias'), 'dir');
  assert.throws(() => installClientConfiguration(generated, join(base, 'alias/config.toml'), {}), code('EDIT_SETUP_CONFIG_UNSAFE'));
  writeFileSync(linked + '.edit-setup.lock', 'held');
  assert.throws(() => installClientConfiguration(generated, linked, {}), code('EDIT_SETUP_CONFIG_BUSY'));
  assert.equal(readFileSync(original, 'utf8'), 'model="existing"\n');
});
test('empty setup environment needs named nonsecret setup and never reads credentials from disk', t => {
  const { options } = fixture(t);
  assert.throws(() => createClientConfiguration({ client: 'codex', repo: options.repo, node: options.node }, {}), code('EDIT_SETUP_API_INVALID'));
  assert.throws(() => createClientConfiguration({ ...options, jobsRoot: undefined }, {}), code('EDIT_SETUP_JOBS_ROOT_INVALID'));
  assert.throws(() => createClientConfiguration({ ...options, studioRoot: undefined }, {}), code('EDIT_SETUP_STUDIO_ROOT_INVALID'));
  const { api, jobsRoot, studioRoot, ...rest } = options;
  assert.equal(createClientConfiguration(rest, { WORKLOOM_BASE_URL: api, WORKLOOM_EDIT_JOBS_ROOT: jobsRoot, WORKLOOM_EDIT_STUDIO_ROOT: studioRoot }).config.env.WORKLOOM_EDIT_JOBS_ROOT, jobsRoot);
});
test('root and endpoint validation excludes public service, credentials, queries, source roots and open roots', t => {
  const { options, jobsRoot, repo } = fixture(t);
  for (const api of ['https://example.com', 'http://127.0.0.1:80?token=private', 'http://user:password@localhost:12', 'http://127.0.0.1:12/path', 'http://localhost:12', 'http://[::1]:12', 'http://127.0.0.1']) assert.throws(() => createClientConfiguration({ ...options, api }, {}), code('EDIT_SETUP_API_INVALID'));
  assert.throws(() => createClientConfiguration({ ...options, jobsRoot: repo }, {}), code('EDIT_SETUP_JOBS_ROOT_INVALID'));
  assert.throws(() => createClientConfiguration({ ...options, studioRoot: jobsRoot }, {}), code('EDIT_SETUP_ROOTS_OVERLAP'));
  for (const mode of [0o755, 0o500, 0o000]) {
    chmodSync(jobsRoot, mode);
    assert.throws(() => createClientConfiguration(options, {}), code('EDIT_SETUP_JOBS_ROOT_INVALID'));
  }
  chmodSync(jobsRoot, 0o700);
});
test('unexpected literal credentials in selected values fail closed without echoing them', t => {
  const { base, options } = fixture(t), secretRoot = join(base, secret); mkdirSync(secretRoot, { mode: 0o700 });
  assert.throws(() => createClientConfiguration({ ...options, jobsRoot: secretRoot }, { WORKLOOM_ACCESS_TOKEN: secret }), code('EDIT_SETUP_CREDENTIAL_IN_CONFIGURATION'));
});
test('argument parser rejects unknown/duplicate flags, secret inputs and implicit installation', () => {
  for (const args of [['--token', secret], ['--client', 'codex', '--client', 'qoder'], ['--api'], ['--config', '/tmp/config.toml'], ['--install', '--install']]) assert.throws(() => parseSetupArguments(args));
});
test('real CLI runs with empty environment, generation is stdout only and error contains code only', t => {
  const { base, options } = fixture(t), config = join(base, 'config.toml');
  const args = ['--client', 'codex', '--repo', options.repo, '--node', options.node, '--api', options.api, '--jobs-root', options.jobsRoot, '--studio-root', options.studioRoot];
  const generated = spawnSync(process.execPath, [TOOL, ...args], { env: {}, encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr); assert.match(generated.stdout, /\[mcp_servers\.workloom-video-edit\]/u); assert.equal(existsSync(config), false);
  const installed = spawnSync(process.execPath, [TOOL, ...args, '--install', '--config', config], { env: {}, encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stderr); assert.equal(JSON.parse(installed.stdout).installed, true);
  const failed = spawnSync(process.execPath, [TOOL, '--client', 'codex', '--token', secret], { env: {}, encoding: 'utf8' });
  assert.equal(failed.status, 2); assert.equal(failed.stdout, ''); assert.ok(!failed.stderr.includes(secret));
  assert.equal(JSON.parse(failed.stderr).error.code, 'EDIT_SETUP_ARGUMENT_INVALID');
});

test('Node executable version and repository identity are validated before generation', t => {
  const { base, options } = fixture(t), executable = join(base, 'old-node');
  writeFileSync(executable, '#!/bin/sh\nprintf "v20.0.0\\n"\n', { mode: 0o700 });
  assert.throws(() => createClientConfiguration({ ...options, node: executable }, {}), code('EDIT_SETUP_NODE_VERSION_REQUIRED'));
  writeFileSync(join(options.repo, 'product.manifest.json'), JSON.stringify({ productId: 'other', repository: 'other' }));
  assert.throws(() => createClientConfiguration(options, {}), code('EDIT_SETUP_REPOSITORY_INVALID'));
});
test('quoted paths are encoded as TOML and JSON strings rather than executable shell text', t => {
  const { base, options } = fixture(t), quotedRepo = join(base, '源 " 引号 仓库');
  renameSync(options.repo, quotedRepo);
  const generated = createClientConfiguration({ ...options, repo: quotedRepo }, {});
  assert.equal(generated.config.cwd, quotedRepo);
  assert.ok(generated.content.includes('cwd = ' + JSON.stringify(quotedRepo)));
  const qoder = createClientConfiguration({ ...options, repo: quotedRepo, client: 'qoder' }, {});
  assert.equal(JSON.parse(qoder.content).mcpServers['workloom-video-edit'].cwd, quotedRepo);
});
test('invalid UTF-8 and oversized existing config are not rewritten or backed up', t => {
  const { base, options } = fixture(t), target = join(base, 'config.toml'), generated = createClientConfiguration(options, {});
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61)]) {
    writeFileSync(target, bytes);
    assert.throws(() => installClientConfiguration(generated, target, {}), code('EDIT_SETUP_CONFIG_UNSAFE'));
    assert.ok(readFileSync(target).equals(bytes));
  }
  assert.equal(backups(base).length, 0);
});
test('group-writable config parent and missing explicit target are rejected', t => {
  const { base, options } = fixture(t), generated = createClientConfiguration(options, {});
  assert.throws(() => installClientConfiguration(generated, undefined, {}), code('EDIT_SETUP_CONFIG_PATH_REQUIRED'));
  chmodSync(base, 0o770);
  assert.throws(() => installClientConfiguration(generated, join(base, 'config.toml'), {}), code('EDIT_SETUP_CONFIG_UNSAFE'));
  chmodSync(base, 0o700);
});

test('known credentials containing quote characters are rejected in config values and target paths', t => {
  const { base, options } = fixture(t), value = 'synthetic-"-quoted-secret', folder = join(base, value);
  mkdirSync(folder, { mode: 0o700 });
  assert.throws(() => createClientConfiguration({ ...options, jobsRoot: folder }, { WORKLOOM_ACCESS_TOKEN: value }), code('EDIT_SETUP_CREDENTIAL_IN_CONFIGURATION'));
  const generated = createClientConfiguration(options, {});
  assert.throws(() => installClientConfiguration(generated, join(base, value + '.toml'), { WORKLOOM_ACCESS_TOKEN: value }), code('EDIT_SETUP_CREDENTIAL_IN_CONFIGURATION'));
});
