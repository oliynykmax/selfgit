#!/usr/bin/env python3
"""Single-job selfgit CI worker. Jobs run in an isolated proot Debian guest that never sees runner credentials."""
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
DISTRO = os.environ.get('SELFGIT_CI_DISTRO', 'debian')
WORKERD_RELEASES = 'https://github.com/oliynykmax/workerd-arm64-39bit/releases/download'
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
    script = '''set -eu
export HOME=/tmp/home TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/cache
mkdir -p "$HOME" /tmp/work
cd /tmp/work
git init -q
git remote add origin https://git.oliinyk.dev/selfgit.git
git fetch --depth=1 origin "$1"
git checkout --detach FETCH_HEAD
test "$(git rev-parse HEAD)" = "$1"
run() { printf '\\n$ %s\\n' "$1"; sh -c "$1"; }
run 'bun install --frozen-lockfile --backend=copyfile'
export MINIFLARE_WORKERD_PATH="/opt/workerd/$(node -p 'require("workerd/package.json").version')"
test -x "$MINIFLARE_WORKERD_PATH" || run "curl -fsSL $2/v${MINIFLARE_WORKERD_PATH##*/}/workerd.gz | gunzip > $MINIFLARE_WORKERD_PATH.part && chmod 755 $MINIFLARE_WORKERD_PATH.part && mv $MINIFLARE_WORKERD_PATH.part $MINIFLARE_WORKERD_PATH"
run 'bun run ci'
'''
    workspace = tempfile.TemporaryDirectory(prefix='job-', dir=os.environ.get('SELFGIT_CI_WORKDIR', os.path.expanduser('~/ci-work')))
    cache = os.environ.get('SELFGIT_CI_CACHE', os.path.expanduser('~/ci-cache'))
    os.makedirs(cache, exist_ok=True)
    cmd = ['proot-distro', 'login', DISTRO, '--isolated', '--bind', workspace.name + ':/tmp', '--bind', cache + ':/cache', '--',
           'sh', '-c', script, 'ci', job['commit'], WORKERD_RELEASES]
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
