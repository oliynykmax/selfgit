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
            proot = Path(directory) / 'proot-distro'
            proot.write_text('#!/bin/sh\nif [ "$1" = login ]; then printf sensitive-; sleep 0.1; printf "token lease-secret\\n"; exit 1; fi\n')
            proot.chmod(0o755)
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
            proot = Path(directory) / 'proot-distro'
            proot.write_text('#!/bin/sh\nif [ "$1" = login ]; then sleep 1.2; fi\n')
            proot.chmod(0o755)
            calls = []
            def request(endpoint, body):
                calls.append(endpoint)
                return {'ok': True}
            with patch.dict(os.environ, {'PATH': directory + ':' + os.environ['PATH'], 'SELFGIT_CI_WORKDIR': directory}), patch.object(runner, 'request', request), patch.object(runner, 'HEARTBEAT_INTERVAL', 0.1):
                runner.execute({'id': 2, 'kind': 'ci', 'commit': 'b' * 40, 'leaseToken': 'lease'})
            self.assertIn('heartbeat', calls)
            self.assertEqual(calls[-1], 'finish')

    def test_rejects_other_kinds(self):
        with self.assertRaises(ValueError):
            runner.execute({'kind': 'backup', 'commit': 'a' * 40})

if __name__ == '__main__':
    unittest.main()
