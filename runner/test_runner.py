import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

with tempfile.NamedTemporaryFile(mode='w') as token:
    token.write('sensitive-token')
    token.flush()
    os.environ['SELFGIT_CI_TOKEN_FILE'] = token.name
    spec = importlib.util.spec_from_file_location('runner', Path(__file__).with_name('runner.py'))
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)


class RunnerTest(unittest.TestCase):
    def test_failure_and_secret_redaction(self):
        with tempfile.TemporaryDirectory() as directory:
            podman = Path(directory) / 'podman'
            podman.write_text('#!/bin/sh\nif [ "$1" = run ]; then printf sensitive-; sleep 0.1; printf "token lease-secret\\n"; exit 1; fi\n')
            podman.chmod(0o755)
            calls = []
            def request(endpoint, body):
                calls.append((endpoint, body))
                return {'ok': True}
            with patch.dict(os.environ, {'PATH': directory + ':' + os.environ['PATH'], 'SELFGIT_CI_WORKDIR': directory}), patch.object(runner, 'request', request):
                runner.execute({'id': 1, 'kind': 'ci', 'commit': 'a' * 40, 'leaseToken': 'lease-secret'})
            text = ''.join(body['text'] for endpoint, body in calls if endpoint == 'log')
            self.assertNotIn('sensitive-token', text)
            self.assertNotIn('lease-secret', text)
            self.assertEqual(calls[-1][1]['success'], False)

    def test_heartbeat_during_job(self):
        with tempfile.TemporaryDirectory() as directory:
            podman = Path(directory) / 'podman'
            podman.write_text('#!/bin/sh\nif [ "$1" = run ]; then sleep 1.2; fi\n')
            podman.chmod(0o755)
            calls = []
            def request(endpoint, body):
                calls.append(endpoint)
                return {'ok': True}
            with patch.dict(os.environ, {'PATH': directory + ':' + os.environ['PATH'], 'SELFGIT_CI_WORKDIR': directory}), patch.object(runner, 'request', request), patch.object(runner, 'HEARTBEAT_INTERVAL', 0.1):
                runner.execute({'id': 2, 'kind': 'ci', 'commit': 'b' * 40, 'leaseToken': 'lease'})
            self.assertIn('heartbeat', calls)
            self.assertEqual(calls[-1], 'finish')

    def test_output_streams_while_the_job_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            podman = Path(directory) / 'podman'
            podman.write_text('#!/bin/sh\nif [ "$1" = run ]; then printf first-line-padding-padding; sleep 1; printf "\\nsecond\\n"; fi\n')
            podman.chmod(0o755)
            calls = []
            def request(endpoint, body):
                calls.append((endpoint, body.get('text')))
                return {'ok': True}
            with patch.dict(os.environ, {'PATH': directory + ':' + os.environ['PATH'], 'SELFGIT_CI_WORKDIR': directory}), patch.object(runner, 'request', request), patch.object(runner, 'STREAM_INTERVAL', 0.2):
                runner.execute({'id': 3, 'kind': 'ci', 'commit': 'd' * 40, 'leaseToken': 'x'})
            logs = [text for endpoint, text in calls if endpoint == 'log']
            self.assertGreater(len(logs), 1)
            self.assertEqual(''.join(logs), 'first-line-padding-padding\nsecond\n')
            self.assertEqual(calls[-1][0], 'finish')

    def test_deploy_needs_credentials_and_keeps_them_off_the_command_line(self):
        with tempfile.TemporaryDirectory() as directory:
            podman = Path(directory) / 'podman'
            podman.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$SELFGIT_ARGS"\nif [ "$1" = run ]; then echo "token is $CLOUDFLARE_API_TOKEN"; fi\n')
            podman.chmod(0o755)
            token = Path(directory) / 'cf'
            token.write_text('cf-secret-value\n')
            args = Path(directory) / 'args'
            calls = []
            def request(endpoint, body):
                calls.append((endpoint, body))
                return {'ok': True}
            job = {'id': 8, 'kind': 'deploy', 'commit': 'e' * 40, 'leaseToken': 'lease'}
            env = {'PATH': directory + ':' + os.environ['PATH'], 'SELFGIT_CI_WORKDIR': directory, 'SELFGIT_ARGS': str(args)}
            with patch.dict(os.environ, env), patch.object(runner, 'request', request):
                self.assertIsNone(runner.cloudflare_token())
                with self.assertRaises(ValueError):
                    runner.execute(job)
            env.update(SELFGIT_CI_CLOUDFLARE_TOKEN_FILE=str(token), SELFGIT_CI_CLOUDFLARE_ACCOUNT_ID='acct123')
            with patch.dict(os.environ, env), patch.object(runner, 'request', request):
                runner.execute(job)
            self.assertNotIn('cf-secret-value', args.read_text())
            text = ''.join(body['text'] for endpoint, body in calls if endpoint == 'log')
            self.assertIn('token is [redacted]', text)
            self.assertNotIn('cf-secret-value', text)
            self.assertIn('CLOUDFLARE_ACCOUNT_ID=acct123', args.read_text())
            self.assertEqual(calls[-1], ('finish', {'id': 8, 'leaseToken': 'lease', 'success': True}))

    def test_container_limits_and_command(self):
        with tempfile.TemporaryDirectory() as directory:
            podman = Path(directory) / 'podman'
            podman.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$SELFGIT_ARGS"\n')
            podman.chmod(0o755)
            args = Path(directory) / 'args'
            calls = []
            def request(endpoint, body):
                calls.append(endpoint)
                return {'ok': True}
            env = {'PATH': directory + ':' + os.environ['PATH'], 'SELFGIT_CI_WORKDIR': directory, 'SELFGIT_ARGS': str(args)}
            with patch.dict(os.environ, env), patch.object(runner, 'request', request):
                runner.execute({'id': 7, 'kind': 'ci', 'commit': 'c' * 40, 'leaseToken': 'lease'})
            lines = args.read_text().split('\n')
            self.assertEqual(lines[:2], ['run', '--rm'])
            self.assertIn('selfgit-ci-7', lines)
            self.assertIn('1536m', lines)
            self.assertEqual(calls[-1], 'finish')

    def test_rejects_other_kinds(self):
        with self.assertRaises(ValueError):
            runner.execute({'kind': 'backup', 'commit': 'a' * 40})

if __name__ == '__main__':
    unittest.main()
