import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import simpleGit from 'simple-git';
import { getDB } from '../db/database.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = process.env.BUILD_DIR || '/tmp/podman-paas-builds';
const BUILD_TIMEOUT_MS = parseInt(process.env.BUILD_TIMEOUT_MS || '600000', 10); // 10 min

mkdirSync(BUILD_DIR, { recursive: true });

export async function cloneRepo(gitUrl, branch = 'main', onLog) {
  // Basic URL validation — reject non-http(s)/git URLs to prevent command injection
  if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(gitUrl)) {
    throw new Error(`Unsafe git URL: ${gitUrl}`);
  }

  const buildId = uuidv4();
  const repoPath = join(BUILD_DIR, buildId);
  mkdirSync(repoPath, { recursive: true });

  onLog?.(`📦 Cloning ${gitUrl} (branch: ${branch})...`);

  try {
    const git = simpleGit({ timeout: { block: 120000 } }); // 2 min clone timeout
    await git.clone(gitUrl, repoPath, ['--branch', branch, '--depth', '1', '--single-branch']);
    onLog?.(`✅ Clone complete`);
    return { repoPath, buildId };
  } catch (err) {
    cleanBuildDir(repoPath);
    throw new Error(`Git clone failed: ${err.message}`);
  }
}

export function detectBuildMethod(repoPath) {
  if (existsSync(join(repoPath, 'Dockerfile')))                               return 'dockerfile';
  if (existsSync(join(repoPath, 'dockerfile')))                               return 'dockerfile';
  if (existsSync(join(repoPath, 'package.json')))                             return 'nixpacks';
  if (existsSync(join(repoPath, 'requirements.txt')))                         return 'nixpacks';
  if (existsSync(join(repoPath, 'pyproject.toml')))                           return 'nixpacks';
  if (existsSync(join(repoPath, 'go.mod')))                                   return 'nixpacks';
  if (existsSync(join(repoPath, 'Cargo.toml')))                               return 'nixpacks';
  if (existsSync(join(repoPath, 'Gemfile')))                                  return 'nixpacks';
  return 'dockerfile';
}

export async function buildWithDockerfile(repoPath, tag, dockerfilePath = 'Dockerfile', buildArgs = {}, onLog) {
  onLog?.(`🔨 Building with Dockerfile: ${dockerfilePath}`);

  // Prevent path traversal in dockerfile path
  const safePath = resolve(repoPath, dockerfilePath);
  if (!safePath.startsWith(resolve(repoPath) + '/') && safePath !== resolve(repoPath)) {
    throw new Error('Unsafe dockerfile path — path traversal detected');
  }
  if (!existsSync(safePath)) throw new Error(`Dockerfile not found: ${dockerfilePath}`);

  return new Promise((resolve, reject) => {
    const args = ['build', '-t', tag, '-f', safePath];

    for (const [key, val] of Object.entries(buildArgs)) {
      // Sanitize build arg keys
      if (/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
        args.push('--build-arg', `${key}=${val}`);
      }
    }
    args.push(repoPath);

    const proc = spawn('podman', args, { stdio: 'pipe', timeout: BUILD_TIMEOUT_MS });
    let stderr = '';

    proc.stdout.on('data', d => onLog?.(d.toString().trimEnd()));
    proc.stderr.on('data', d => {
      const msg = d.toString().trimEnd();
      stderr += msg + '\n';
      onLog?.(msg);
    });

    proc.on('close', code => {
      if (code === 0) { onLog?.(`✅ Image built: ${tag}`); resolve(tag); }
      else reject(new Error(`Docker build failed (exit ${code})`));
    });
    proc.on('error', reject);
  });
}

export async function buildWithNixpacks(repoPath, tag, onLog) {
  onLog?.(`🔨 Building with Nixpacks...`);

  return new Promise((resolve, reject) => {
    const proc = spawn('nixpacks', ['build', repoPath, '--name', tag], {
      stdio: 'pipe',
      timeout: BUILD_TIMEOUT_MS,
    });

    proc.stdout.on('data', d => onLog?.(d.toString().trimEnd()));
    proc.stderr.on('data', d => onLog?.(d.toString().trimEnd()));

    proc.on('close', code => {
      if (code === 0) { onLog?.(`✅ Nixpacks build complete: ${tag}`); resolve(tag); }
      else reject(new Error(`Nixpacks build failed (exit ${code})`));
    });

    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error('nixpacks not installed. Run: curl -sSL https://nixpacks.com/install.sh | sh'));
      } else {
        reject(err);
      }
    });
  });
}

export async function getCommitInfo(repoPath) {
  try {
    const git = simpleGit(repoPath);
    const log = await git.log(['--max-count=1']);
    const latest = log.latest;
    return {
      sha:     latest?.hash?.substring(0, 8) || 'unknown',
      message: latest?.message?.substring(0, 72) || '',
      author:  latest?.author_name || '',
      date:    latest?.date || new Date().toISOString(),
    };
  } catch {
    return { sha: 'unknown', message: '', author: '', date: new Date().toISOString() };
  }
}

export function cleanBuildDir(repoPath) {
  try { rmSync(repoPath, { recursive: true, force: true }); } catch {}
}

export async function runBuildPipeline(app, deploymentId, onLog) {
  const tag = `podman-paas/${app.name.replace(/[^a-z0-9-]/g, '-')}:latest`;
  let repoPath = null;

  try {
    const { repoPath: rp } = await cloneRepo(app.git_url, app.branch || 'main', onLog);
    repoPath = rp;

    const commit = await getCommitInfo(repoPath);
    onLog?.(`📝 Commit ${commit.sha}: ${commit.message}`);

    const method = (app.build_method === 'auto' || !app.build_method)
      ? detectBuildMethod(repoPath)
      : app.build_method;
    onLog?.(`🔍 Build method: ${method}`);

    if (method === 'nixpacks') {
      await buildWithNixpacks(repoPath, tag, onLog);
    } else {
      await buildWithDockerfile(repoPath, tag, app.dockerfile_path || 'Dockerfile', {}, onLog);
    }

    return { tag, commit };
  } finally {
    if (repoPath) cleanBuildDir(repoPath);
  }
}
