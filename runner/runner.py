#!/usr/bin/env python3
"""Single-job selfgit CI worker. Each job runs in a rootless Podman container that never sees runner credentials."""
import codecs
import json
import os
import re
import selectors
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request

API = os.environ.get('SELFGIT_CI_API', 'https://git.oliinyk.dev')
TOKEN = open(os.environ['SELFGIT_CI_TOKEN_FILE'], encoding='utf-8').read().strip()
IMAGE = os.environ.get('SELFGIT_CI_IMAGE', 'localhost/selfgit-ci:latest')
MEMORY = os.environ.get('SELFGIT_CI_MEMORY', '1536m')
CPUS = os.environ.get('SELFGIT_CI_CPUS', '1')
TIMEOUT = 1200
LOG_LIMIT = 60000
HEARTBEAT_INTERVAL = 60
STREAM_INTERVAL = 3


def request(endpoint, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(API + '/api/runner/' + endpoint, data=data,
                                 headers={'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json',
                                          'User-Agent': 'selfgit-ci/1.0'})
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.load(response)


PRELUDE = '''set -eu
export HOME=/tmp/home TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/cache WRANGLER_SEND_METRICS=false
mkdir -p "$HOME" /tmp/work
cd /tmp/work
git init -q
git remote add origin https://git.oliinyk.dev/selfgit.git
git fetch --depth=1 origin "$1"
git checkout --detach FETCH_HEAD
test "$(git rev-parse HEAD)" = "$1"
run() { printf '\\n$ %s\\n' "$1"; sh -c "$1"; }
run 'bun install --frozen-lockfile'
'''
SCRIPTS = {
    'ci': PRELUDE + "run 'bun run ci'\n",
    # Alchemy reads CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the container environment.
    'deploy': PRELUDE + "run 'bun run deploy'\n",
}


# Runs on the runner host, not in a container: it executes no repository code, only git.
BACKUP_SCRIPT = '''set -eu
git init -q --bare "$1"
cd "$1"
git fetch https://git.oliinyk.dev/selfgit.git '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*'
printf 'selfgit main is at %s\\n' "$(git rev-parse refs/heads/main)"
# Never force and never delete: a rewritten or emptied selfgit fails the backup instead of overwriting it.
git push "git@github.com:$2.git" 'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*'
'''
GITHUB_REPO = re.compile(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+')


def github_key():
    """The backup deploy key and pinned GitHub host keys, or None when this runner is not set up to back up."""
    key = os.environ.get('SELFGIT_CI_GITHUB_KEY_FILE')
    known = os.environ.get('SELFGIT_CI_GITHUB_KNOWN_HOSTS')
    if not key or not known or not os.path.exists(key) or not os.path.exists(known):
        return None
    return key, known


def cloudflare_token():
    """The deploy credential, or None when this runner is not set up to deploy."""
    path = os.environ.get('SELFGIT_CI_CLOUDFLARE_TOKEN_FILE')
    account = os.environ.get('SELFGIT_CI_CLOUDFLARE_ACCOUNT_ID')
    if not path or not account or not os.path.exists(path):
        return None
    return open(path, encoding='utf-8').read().strip() or None


def execute(job):
    if job.get('kind') not in (*SCRIPTS, 'backup') or not re.fullmatch(r'[0-9a-f]{40}', job.get('commit', '')):
        raise ValueError('Invalid CI job')
    secrets = [TOKEN, job['leaseToken']]
    env = None
    env_args = []
    if job['kind'] == 'backup':
        credential = github_key()
        if not credential:
            raise ValueError('Backup credential is not configured')
        if not GITHUB_REPO.fullmatch(job.get('target', '')):
            raise ValueError('Invalid backup target')
        key, known = credential
        env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GIT_SSH_COMMAND': ' '.join([
            'ssh', '-i', shlex.quote(key), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + shlex.quote(known)])}
    elif job['kind'] == 'deploy':
        deploy_token = cloudflare_token()
        if not deploy_token:
            raise ValueError('Deploy credential is not configured')
        secrets.append(deploy_token)
        # Values go through the environment, never the command line.
        env = {**os.environ, 'CLOUDFLARE_API_TOKEN': deploy_token}
        env_args = ['--env', 'CLOUDFLARE_API_TOKEN', '--env', 'CLOUDFLARE_ACCOUNT_ID=' + os.environ['SELFGIT_CI_CLOUDFLARE_ACCOUNT_ID']]
    lease = {'id': job['id'], 'leaseToken': job['leaseToken']}
    workspace = tempfile.TemporaryDirectory(prefix='job-', dir=os.environ.get('SELFGIT_CI_WORKDIR', os.path.expanduser('~/ci-work')))
    if job['kind'] == 'backup':
        cmd = ['sh', '-c', BACKUP_SCRIPT, 'backup', os.path.join(workspace.name, 'mirror.git'), job['target']]
    else:
        cache = os.environ.get('SELFGIT_CI_CACHE', os.path.expanduser('~/ci-cache'))
        os.makedirs(cache, exist_ok=True)
        cmd = ['podman', 'run', '--rm', '--name', 'selfgit-ci-%s' % job['id'], '--memory', MEMORY, '--memory-swap', MEMORY,
               '--cpus', CPUS, '--pids-limit', '512', *env_args, '--volume', workspace.name + ':/tmp:Z', '--volume', cache + ':/cache:Z',
               IMAGE, 'sh', '-c', SCRIPTS[job['kind']], 'ci', job['commit']]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True, env=env)
    selector = selectors.DefaultSelector()
    selector.register(proc.stdout, selectors.EVENT_READ)
    start = time.monotonic()
    heartbeat = start + HEARTBEAT_INTERVAL
    decoder = codecs.getincrementaldecoder('utf-8')('replace')
    raw = 0
    text = ''
    sent = 0
    next_stream = start + STREAM_INTERVAL
    lease_valid = True
    # A secret split across two reads must not leak, so hold back the tail until the output completes.
    hold = max(len(secret) for secret in secrets)

    def stream(final=False):
        nonlocal sent, lease_valid
        clean = text
        for secret in secrets:
            clean = clean.replace(secret, '[redacted]')
        end = len(clean) if final else max(sent, len(clean) - hold)
        for offset in range(sent, end, 1024):
            if not request('log', {**lease, 'text': clean[offset:min(offset + 1024, end)]}).get('ok'):
                lease_valid = False
                raise RuntimeError('Lease lost')
        print(clean[sent:end], end='', flush=True)
        sent = end

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
            if now >= next_stream:
                stream()
                next_stream = now + STREAM_INTERVAL
            for key, _ in selector.select(timeout=1):
                data = os.read(key.fd, 2048)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                data = data[:max(0, LOG_LIMIT - raw)]
                raw += len(data)
                text += decoder.decode(data)
        text += decoder.decode(b'', final=True)
        stream(final=True)
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
            if not job and cloudflare_token():
                job = request('claim', {'kind': 'deploy'})
            if not job and github_key():
                job = request('claim', {'kind': 'backup'})
            if job:
                execute(job)
            else:
                time.sleep(15)
        except Exception as exc:
            print('Runner operation failed:', type(exc).__name__, file=sys.stderr, flush=True)
            time.sleep(15)


if __name__ == '__main__':
    main()
