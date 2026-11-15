import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function recoverRunnerFailure(run, { repo, api, rerun }) {
  if (run.name !== 'Daily remote Pokemon sales' || run.head_branch !== 'main' ||
      run.head_repository?.full_name !== repo || run.status !== 'completed' ||
      run.conclusion !== 'failure' || !Number.isSafeInteger(run.run_attempt) ||
      run.run_attempt < 1 || run.run_attempt >= 3 ||
      !Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.workflow_id)) return false;
  const base = `repos/${repo}/actions`;
  const latest = await api(`${base}/workflows/${run.workflow_id}/runs?branch=main&per_page=1`);
  if (latest[0]?.workflow_runs?.[0]?.id !== run.id) return false;
  const current = (await api(`${base}/runs/${run.id}`))[0];
  if (current.status !== 'completed' || current.conclusion !== 'failure' ||
      current.run_attempt !== run.run_attempt) return false;
  const jobs = (await api(`${base}/runs/${run.id}/jobs?filter=latest&per_page=100`))
    .flatMap(page => page.jobs);
  const failed = jobs.filter(job => job.conclusion === 'failure');
  if (!failed.length || jobs.some(job => !['failure', 'success', 'skipped'].includes(job.conclusion))) {
    return false;
  }
  for (const job of failed) {
    const check = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/check-runs\/(\d+)$/
      .exec(job.check_run_url ?? '');
    if (!check || check[1] !== repo) return false;
    const annotations = (await api(`repos/${repo}/check-runs/${check[2]}/annotations?per_page=100`))
      .flat().filter(annotation => annotation.annotation_level === 'failure');
    if (!annotations.length || !annotations.every(annotation =>
      annotation.message.startsWith('The hosted runner lost communication with the server.'))) {
      return false;
    }
  }
  await rerun(run.id);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const repo = process.env.GITHUB_REPOSITORY;
    const recovered = await recoverRunnerFailure(event.workflow_run, {
      repo,
      api: route => JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', route],
        { encoding: 'utf8' })),
      rerun: id => execFileSync('gh', ['run', 'rerun', String(id), '--failed', '--repo', repo],
        { stdio: 'inherit' }),
    });
    console.log(recovered ? 'Requeued failed hosted-runner jobs and their dependent passes.' :
      'No eligible hosted-runner failure; no collection was retried.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
