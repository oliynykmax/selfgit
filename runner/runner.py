#!/usr/bin/env python3
"""Single-job selfgit CI worker. The container never receives runner credentials."""
import json
import os
import re
import selectors
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request

API = os.environ.get('SELFGIT_CI_API', 'https://git.oliinyk.dev')
TOKEN = open(os.environ['SELFGIT_CI_TOKEN_FILE'], encoding='utf-8').read().strip()
IMAGE = os.environ.get('SELFGIT_CI_IMAGE', 'localhost/selfgit-ci:latest')
TIMEOUT = 1200
LOG_LIMIT = 60000
HEARTBEAT_INTERVAL = 60


def request(endpoint, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(API + '/api/runner/' + endpoint, data=data,
                                 headers={'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json',
                                          'User-Agent': 'selfgit-ci/1.0'})
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.load(response)


def execute(job):
    if job.get('kind') != 'ci' or not re.fullmatch(r'[0-9a-f]{40}', job.get('commit', '')):
        raise ValueError('Invalid CI job')
    lease = {'id': job['id'], 'leaseToken': job['leaseToken']}
    name = 'selfgit-ci-' + str(job['id'])
    script = '''set -eu
export HOME=/tmp/home TMPDIR=/tmp
mkdir -p "$HOME" /tmp/work
cd /tmp/work
git init -q
git remote add origin https://git.oliinyk.dev/selfgit.git
git fetch --depth=1 origin "$1"
git checkout --detach FETCH_HEAD
test "$(git rev-parse HEAD)" = "$1"
for command in 'bun install --frozen-lockfile' 'bun run typecheck' 'bun run test' 'bun run build'; do
  printf '\\n$ %s\\n' "$command"
  sh -c "$command"
done
'''
    workspace = tempfile.TemporaryDirectory(prefix='job-', dir=os.environ.get('SELFGIT_CI_WORKDIR', '/var/lib/selfgit-ci-work'))
    cmd = ['podman', 'run', '--rm', '--name', name, '--memory=650m', '--memory-swap=768m',
           '--cpus=1', '--pids-limit=256', '--read-only', '--volume', workspace.name + ':/tmp:rw',
           '--cap-drop=all', '--security-opt=no-new-privileges', IMAGE, 'sh', '-c', script, 'ci', job['commit']]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(proc.stdout, selectors.EVENT_READ)
    start = time.monotonic()
    heartbeat = start + HEARTBEAT_INTERVAL
    output = bytearray()
    lease_valid = True
    try:
        while selector.get_map():
            now = time.monotonic()
            if now - start > TIMEOUT:
                raise TimeoutError('CI timed out')
            if now >= heartbeat:
                if not request('heartbeat', lease).get('ok'):
                    lease_valid = False
                    raise RuntimeError('Lease lost')
                heartbeat = now + HEARTBEAT_INTERVAL
            for key, _ in selector.select(timeout=1):
                data = os.read(key.fd, 2048)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                output.extend(data[:max(0, LOG_LIMIT - len(output))])
        text = output.decode('utf-8', 'replace').replace(TOKEN, '[redacted]').replace(job['leaseToken'], '[redacted]')
        print(text, end='', flush=True)
        for offset in range(0, len(text), 1024):
            if not request('log', {**lease, 'text': text[offset:offset + 1024]}).get('ok'):
                lease_valid = False
                raise RuntimeError('Lease lost')
        success = proc.wait() == 0
        if lease_valid and not request('finish', {**lease, 'success': success}).get('ok'):
            raise RuntimeError('Finish rejected')
    except Exception:
        if lease_valid:
            try:
                request('log', {**lease, 'text': '\nRunner error or timeout.\n'})
                request('finish', {**lease, 'success': False})
            except Exception:
                pass
        raise
    finally:
        subprocess.run(['podman', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30, check=False)
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
        selector.close()
        proc.stdout.close()
        workspace.cleanup()


def main():
    while True:
        try:
            job = request('claim', {'kind': 'ci'})
            if job:
                execute(job)
            else:
                time.sleep(15)
        except Exception as exc:
            print('Runner operation failed:', type(exc).__name__, file=sys.stderr, flush=True)
            time.sleep(15)


if __name__ == '__main__':
    main()
