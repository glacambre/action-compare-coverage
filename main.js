const fs = require('fs');
const sep = require('path').sep;

const getSummary = require('./istanbul-wrapper');

const core = require('@actions/core');
const artifact = require('@actions/artifact');
const github = require('@actions/github');

const AdmZip = require('adm-zip');
const fetch = require('node-fetch');

function ref_to_coverage_artifact_name(ref) {
  const prefix = "refs/heads/";
  if (ref.startsWith(prefix)) {
    ref = ref.slice(prefix.length);
  }
  return ref.replace(/[":<>|*?\\/]/g, "_") + "-coverage";
}

async function main() {
  const token = core.getInput("github_token", { required: true });
  const nyc_results = core.getInput("nyc_results", { required: true });

  // Just upload coverage for branch as artifact
  if (github.context.eventName === "push") {
    core.info(`Uploading coverage artifact.`);
    const artifactClient = artifact.create();
    const artifactName = ref_to_coverage_artifact_name(github.context.ref);
    const files = [nyc_results];
    const rootDirectory = nyc_results.split(sep).slice(0,-1).join(sep);
    const uploadResult = await artifactClient.uploadArtifact(
      artifactName,
      files,
      rootDirectory,
      { continueOnError: true},
    );
    return;
  }
  if (github.context.eventName !== "pull_request") {
    return;
  }

  const pull_request = github.context.payload.pull_request;

  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;
  const baseline_ref = pull_request.base.ref;
  const baseline = ref_to_coverage_artifact_name(baseline_ref);
  const head_sha = pull_request.head.sha;
  const head_url = pull_request.head.repo.html_url + "/blob/" + head_sha;

  const octokit = github.getOctokit(token);

  const comparison = (await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
    owner,
    repo,
    basehead: `${baseline_ref}...${head_sha}`,
  })).data;
  const changed_filenames = new Set(comparison.files.map(f => f.filename));


  const all_artifacts = await octokit.request('GET /repos/{owner}/{repo}/actions/artifacts', {
    owner,
    repo
  });
  if (all_artifacts.data.total_count < 1) {
    throw new Error("No artifacts found!");
  }

  const baseline_artifact = all_artifacts.data.artifacts.find((x) => x.name === baseline);
  if (baseline_artifact === undefined) {
    throw new Error(`No artifact found with name ${baseline}`);
  }
  const download_url = await octokit.request('GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}', {
    owner,
    repo,
    artifact_id: baseline_artifact.id,
    archive_format: 'zip'
  })
  const zip = new AdmZip(await (fetch(download_url.url).then(r => r.buffer())));

  fs.writeFileSync("baseline", zip.getEntry(nyc_results.split(sep).slice(-1)[0]).getData());
  const master_coverage = await getSummary("baseline");
  const branch_coverage = await getSummary(nyc_results);
  let branch_total = branch_coverage.total;
  delete branch_coverage.total;
  let master_total = master_coverage.total;
  delete master_coverage.total;

  let conclusion = 'pending';
  let title = 'Coverage is not changing';

  let summary = '| File | Coverage | Delta |';
  summary += '\n' + summary.split("").map((x) => x === '|' || x === ' ' ? x : '-').join("") + '\n';
  let prefix = process.cwd().length + 1;
  for (let [path, file] of Object.entries(branch_coverage).sort((x, y) => x[0].localeCompare(y[0]))) {
    if (file === undefined) {
      continue;
    }
    let name = path.substr(prefix);
    if (name.startsWith("node_modules") || name.startsWith("bpack/runtime/")) {
      continue;
    }
    core.info(name, path);
    let master_file = master_coverage[path];
    let url = `[${name}](${head_url + '/' + name})`;
    let bar = "";
    for (let i = 0; i < 10; ++i) {
      bar += (i < Math.floor(file.lines.pct / 10)) ? '⬛' : '⬜';
    }
    // The comparison here is to make sure we avoid floating-point idiocy
    const file_pct = Math.floor(file.lines.pct * 100);
    const master_pct = master_file === undefined ? 0 : Math.floor(master_file.lines.pct * 100);

    if (file_pct < master_pct) {
      conclusion = 'failure';
      title = 'Coverage is decreasing';
    } else if (conclusion == 'pending' && file_pct > master_pct) {
      title = 'Coverage is increasing';
    }

    let delta = (file_pct - master_pct) / 100;
    let delta_string = (delta >= 0 ? '+' : '') + delta + (delta === 0 ? ".0" : "")
    summary += `| ${url} | ${bar} ${file.lines.pct}% | ${delta_string} |\n`;
  }

  if (conclusion == 'pending') {
    conclusion = 'success';
  }

  const check_run = await octokit.request('POST /repos/{owner}/{repo}/check-runs', {
    owner,
    repo,
    head_sha,
    name: 'Coverage',
    status: 'completed',
    started_at: (new Date()).toISOString(),
    completed_at: (new Date()).toISOString(),
    conclusion,
    output: {
      title,
      summary: `${summary}`,
    }
  })
}

main()
