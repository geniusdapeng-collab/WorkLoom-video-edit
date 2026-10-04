"""Assert the current installed film entry reaches its real IPC guard.

There is no parent channel, job, database access, or provider call in this
negative control. Imports must load before CHANNEL_UNAVAILABLE is raised.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent.parent
repo = root / 'work/growth-audit'
evidence = root / 'outputs/growth-production-fix-2026-10-02/evidence'
parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True)
parser.add_argument('--prefix', choices=['floor', 'scene', 'surface', 'dependency'], default='scene')
args = parser.parse_args()


def revision():
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
    dirty = subprocess.check_output(['git', 'status', '--porcelain'], cwd=repo, text=True).strip()
    if head != args.source or dirty:
        raise RuntimeError('Installed load check requires the exact clean source')


revision()
fingerprint = json.loads((evidence / (args.prefix + '-payload-fingerprint.json')).read_text())
runtime = root / 'work/终态修复 升级客户/runtime'
node = root / 'work/终态修复 升级客户/node/bin/node'
if fingerprint['source'] != args.source or not runtime.is_dir() or not node.is_file():
    raise RuntimeError('The current real upgraded QA runtime is not available')
paths = ['scripts/tools/full-chain-film.mts', 'scripts/tools/film-voice-artifact.ts',
         'packages/video-studio/src/film-worker-runtime.ts',
         'packages/video-studio/src/film-worker-channel.ts',
         'packages/video-studio/src/index.ts', 'apps/server/src/video/film-worker.ts']
rows = []
for relative in paths:
    shipped = runtime / relative
    if shipped.is_symlink() or not shipped.is_file():
        raise RuntimeError('A required installed module is missing: ' + relative)
    actual = hashlib.sha256(shipped.read_bytes()).hexdigest()
    frozen = subprocess.check_output(['git', 'show', args.source + ':' + relative], cwd=repo)
    expected = hashlib.sha256(frozen).hexdigest()
    if actual != expected:
        raise RuntimeError('Installed code differs from the frozen source: ' + relative)
    rows.append({'path': relative, 'sha256': actual, 'matches_frozen_source': True})
argv = [str(node), '--import=tsx', str(runtime / 'scripts/tools/full-chain-film.mts'), '--worker']
result = subprocess.run(argv, cwd=runtime,
                        env={'PATH': str(node.parent) + ':/usr/bin:/bin', 'LLM_PROVIDER': 'mock',
                             'LLM_API_KEY': '', 'WORKLOOM_KEYS_FILE': '/dev/null'},
                        capture_output=True, text=True, timeout=20, check=False)
output = result.stdout + '\n' + result.stderr
healthy = (result.returncode == 1 and 'CHANNEL_UNAVAILABLE' in output
           and 'ERR_MODULE_NOT_FOUND' not in output and 'MODULE_NOT_FOUND' not in output)
revision()
print(json.dumps({'source': args.source, 'argv': argv, 'exit_code': result.returncode,
                  'reached_current_worker_ipc_guard': 'CHANNEL_UNAVAILABLE' in output,
                  'missing_module': 'MODULE_NOT_FOUND' in output, 'critical_source_files': rows,
                  'output_sha256': hashlib.sha256(output.encode()).hexdigest(), 'pass': healthy,
                  'scope': 'Actual current installed QA Node/runtime module load only; no parent/job/provider'},
                 ensure_ascii=False))
raise SystemExit(0 if healthy else 1)
