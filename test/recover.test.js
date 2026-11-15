import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverRunnerFailure } from '../src/recover.js';

const repo = 'owner/repo';
const run = { id: 42, workflow_id: 7, name: 'Daily remote Pokemon sales',
  head_branch: 'main', head_repository: { full_name: repo },
  status: 'completed', conclusion: 'failure', run_attempt: 1 };
const runnerFailure = { annotation_level: 'failure',
  message: 'The hosted runner lost communication with the server. Anything in your workflow...' };

function fixture({ latest = 42, attempt = 1, annotations = [runnerFailure], extraJob } = {}) {
  const calls = [], reruns = [];
  return {
    calls, reruns, repo,
    api: async route => {
      calls.push(route);
      if (route.includes('/workflows/')) return [{ workflow_runs: [{ id: latest }] }];
      if (route.endsWith('/runs/42')) return [{ ...run, run_attempt: attempt }];
      if (route.includes('/jobs?')) return [{ jobs: [
        { conclusion: 'failure', check_run_url: `https://api.github.com/repos/${repo}/check-runs/99` },
        { conclusion: 'skipped' }, ...(extraJob ? [extraJob] : []),
      ] }];
      if (route.includes('/annotations?')) return [annotations];
      throw new Error(`Unexpected API route: ${route}`);
    },
    rerun: async id => { reruns.push(id); },
  };
}

test('confirmed runner loss requeues the failed jobs and dependent passes', async () => {
  const options = fixture();
  assert.equal(await recoverRunnerFailure(run, options), true);
  assert.deepEqual(options.reruns, [42]);
});

test('collection, access-denial, missing and mixed failures are not automatically retried', async () => {
  for (const annotations of [[], [{ annotation_level: 'failure', message: 'History HTTP 403' }],
    [runnerFailure, { annotation_level: 'failure', message: 'Process completed with exit code 1.' }]]) {
    const options = fixture({ annotations });
    assert.equal(await recoverRunnerFailure(run, options), false);
    assert.deepEqual(options.reruns, []);
  }
  const options = fixture({ extraJob: { conclusion: 'cancelled' } });
  assert.equal(await recoverRunnerFailure(run, options), false);
  assert.deepEqual(options.reruns, []);
});

test('recovery rejects exhausted attempts, cancellations, other workflows, branches and forks', async () => {
  for (const change of [{ run_attempt: 3 }, { run_attempt: undefined }, { run_attempt: 0 },
    { conclusion: 'cancelled' }, { status: 'in_progress' }, { name: 'Other workflow' },
    { head_branch: 'other' }, { head_repository: { full_name: 'other/repo' } }]) {
    const options = fixture();
    assert.equal(await recoverRunnerFailure({ ...run, ...change }, options), false);
    assert.deepEqual(options.calls, []);
    assert.deepEqual(options.reruns, []);
  }
});

test('a newer daily run or an already-started retry prevents stale recovery', async () => {
  for (const change of [{ latest: 43 }, { attempt: 2 }]) {
    const options = fixture(change);
    assert.equal(await recoverRunnerFailure(run, options), false);
    assert.deepEqual(options.reruns, []);
  }
});
