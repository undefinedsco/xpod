import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

export interface CreateWorktreeOptions {
  repoPath: string;
  worktreePath: string;
  baseRef: string;
  branch?: string;
}

export class GitWorktreeService {
  async assertGitRepo(repoPath: string): Promise<void> {
    const ok = await this.isGitRepo(repoPath);
    if (!ok) {
      throw new Error(`repoPath is not a git repository: ${repoPath}`);
    }
  }

  async isGitRepo(repoPath: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('git', [ '-C', repoPath, 'rev-parse', '--is-inside-work-tree' ], {
        timeout: 10_000,
      });
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  async createWorktree(options: CreateWorktreeOptions): Promise<void> {
    await this.assertGitRepo(options.repoPath);

    fs.mkdirSync(path.dirname(options.worktreePath), { recursive: true });

    const args: string[] = [ '-C', options.repoPath, 'worktree', 'add' ];
    if (options.branch) {
      args.push('-b', options.branch);
    }
    args.push(options.worktreePath, options.baseRef);

    await execFileAsync('git', args, { timeout: 60_000 });
  }

  ensurePathInsideRepo(repoPath: string, candidatePath: string): void {
    const repoReal = fs.realpathSync(repoPath);
    const candidateReal = fs.realpathSync(candidatePath);
    const rel = path.relative(repoReal, candidateReal);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`workdir must be inside repoPath. repoPath=${repoReal}, workdir=${candidateReal}`);
    }
  }
}

