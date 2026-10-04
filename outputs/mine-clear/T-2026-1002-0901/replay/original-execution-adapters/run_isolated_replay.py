"""Run existing product probes in a new directory, preserving earlier results.

This is an execution adapter, not an implementation of the product under test.
The probes import the explicit clean checkout and use its isolated test .env.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
portable = root / 'work/portable-growth-stage'
node = root / 'work/downloads/node-v24.19.0-darwin-arm64/bin/node'
parser = argparse.ArgumentParser()
parser.add_argument('--repo', type=Path, required=True)
parser.add_argument('--source', required=True)
parser.add_argument('--group', choices=['runtime', 'auth', 'film'], required=True)
parser.add_argument('--case')
args = parser.parse_args()
repo = args.repo.resolve()
if repo != (root / 'work/growth-audit').resolve():
    raise SystemExit('This adapter only accepts the owned Growth repair checkout')


def revision():
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
    dirty = subprocess.check_output(['git', 'status', '--porcelain'], cwd=repo, text=True).strip()
    if sha != args.source or dirty:
        raise RuntimeError('Require the exact clean source before and after execution')
    return sha


revision()
sandbox_root = root / 'work/mcd-replay-attempts'
sandbox_root.mkdir(exist_ok=True)
attempt = Path(tempfile.mkdtemp(prefix=args.group + '-', dir=sandbox_root))
copies = []
for name in ['runtime-repro.mts', 'local-counter.mjs', 'auth-fixture.mts',
             'auth-production-probe.mjs', 'film-public-probe.mts']:
    original = portable / name
    destination = attempt / name
    shutil.copyfile(original, destination)
    copies.append({'file': name, 'sha256': hashlib.sha256(destination.read_bytes()).hexdigest()})

env = os.environ.copy()
env['PATH'] = str(node.parent) + os.pathsep + env.get('PATH', '')
for key in list(env):
    if any(word in key.upper() for word in ('CNB_TOKEN', 'API_KEY', 'SIGNING_SECRET', 'PRIVATE_KEY')):
        env[key] = ''
env.update(LLM_PROVIDER='mock', LLM_API_KEY='', LLM_BASE_URL='', SCHEDULER_ENABLED='0',
           HR_PORTRAIT_ENABLED='0', HR_PORTRAIT_AUTO_ENABLED='0', PORTRAIT_AGENT_ENABLED='0')
commands = []


def execute(name, extra=None):
    argv = [str(node), '--env-file=.env', '--import', 'tsx', str(attempt / name), '--repo', str(repo)]
    argv.extend(extra or [])
    result = subprocess.run(argv, cwd=repo, env=env, capture_output=True, text=True,
                            timeout=180, check=False)
    stdout = result.stdout
    stderr = result.stderr
    for key, value in os.environ.items():
        if any(word in key.upper() for word in ('TOKEN', 'SECRET', 'PASSWORD', 'API_KEY')) and len(value) >= 4:
            stdout = stdout.replace(value, '[REDACTED]')
            stderr = stderr.replace(value, '[REDACTED]')
    (attempt / (name + '.stdout')).write_text(stdout)
    (attempt / (name + '.stderr')).write_text(stderr)
    commands.append({'argv': argv, 'exit_code': result.returncode,
                     'stdout_sha256': hashlib.sha256(stdout.encode()).hexdigest(),
                     'stderr_sha256': hashlib.sha256(stderr.encode()).hexdigest()})
    if result.returncode != 0:
        print(stdout)
        print(stderr)
        raise RuntimeError('Actual probe failed; original evidence was not overwritten')


if args.group == 'runtime':
    extra = ['--assert'] + (['--case', args.case] if args.case else [])
    execute('runtime-repro.mts', extra)
    result = json.loads((attempt / 'runtime-repro-results.json').read_text())
    rows = result['results']
    expected_ids = {args.case} if args.case else {
        'QUEUE-10', 'BLOCK-FLAG', 'PENDING-CONCURRENCY', 'EDIT-PARAMS', 'EDIT-HIGH-RISK',
        'RELEVANCE-REPLAY', 'REJECT-TERMINAL', 'PERMISSION-BEFORE-ACTION', 'REJECT-WORKSPACE-COLLISION'}
    if {row['id'] for row in rows} != expected_ids or any(row.get('healthy') is not True for row in rows):
        raise RuntimeError('Missing or failed actual runtime case')
    # Preserve the existing signal and additionally check the original card's
    # observable state. A zero call count alone cannot prove a replay stayed pending.
    for row in rows:
        key, actual = row['id'], row['actual']
        if key == 'BLOCK-FLAG':
            assert all(actual[state] != 'completed' for state in ('control', 'flagged', 'afterApproval'))
        elif key == 'RELEVANCE-REPLAY':
            assert actual['first'] == actual['second'] == 'pending_review'
            assert any(step.get('context', {}).get('plan_unverified') is True for step in actual['stored'])
        elif key == 'PENDING-CONCURRENCY':
            assert len(actual['calls']) == 1 and actual['threadStatus'] == 'completed'
            assert actual['approval']['status'] == 'approved' and actual['approval']['consumed_at']
        elif key == 'QUEUE-10':
            assert actual['first']['picked'] or actual['second']['picked']
        elif key == 'PERMISSION-BEFORE-ACTION':
            assert actual['threadStatus'] != 'completed' and actual['error']
    actual_results = rows
elif args.group == 'auth':
    if args.case:
        raise RuntimeError('Auth runs all original 11 controls')
    execute('auth-fixture.mts')
    execute('auth-production-probe.mjs')
    result = json.loads((attempt / 'auth-production-http-results.json').read_text())
    assert result['passed'] is True and len(result['checks']) == 11
    assert all(row['healthy'] is True for row in result['checks'])
    actual_results = result['checks']
else:
    case = args.case or 'success'
    if case not in ('success', 'missing-output', 'deadline'):
        raise RuntimeError('Unknown film control')
    execute('film-public-probe.mts', ['--case', case])
    result = json.loads((attempt / ('film-public-' + case + '-results.json')).read_text())
    assert result['passed'] is True and len(result['checks']) == (5 if case == 'success' else 1)
    assert all(row['healthy'] is True for row in result['checks'])
    actual_results = result['checks']

revision()
receipt = {'source': args.source, 'group': args.group, 'case': args.case,
           'attempt': str(attempt.relative_to(root)), 'copied_probe_hashes': copies,
           'commands': commands, 'results': actual_results, 'pass': True,
           'scope': 'Actual frozen product, dedicated loopback growth_audit fixture; no paid/provider/business result',
           'original_evidence_overwritten': False}
(attempt / 'receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(receipt, ensure_ascii=False))
