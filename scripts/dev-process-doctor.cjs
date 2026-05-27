#!/usr/bin/env node
const { execFileSync } = require('node:child_process');

function run(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function parseElapsedToSeconds(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }

  const [dayPart, timePartRaw] = trimmed.includes('-') ? trimmed.split('-', 2) : [undefined, trimmed];
  const timePart = timePartRaw ?? '0:00';
  const segments = timePart.split(':').map((part) => Number.parseInt(part, 10));

  let seconds = 0;
  if (segments.length === 3) {
    seconds += segments[0] * 3600 + segments[1] * 60 + segments[2];
  } else if (segments.length === 2) {
    seconds += segments[0] * 60 + segments[1];
  } else if (segments.length === 1) {
    seconds += segments[0];
  }

  if (dayPart !== undefined) {
    seconds += Number.parseInt(dayPart, 10) * 24 * 3600;
  }

  return Number.isFinite(seconds) ? seconds : 0;
}

function formatSeconds(totalSeconds) {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m ${seconds}s`;
}

function classifyProcess(command) {
  const rules = [
    {
      type: 'vitest',
      label: 'Vitest',
      safeToKill: true,
      patterns: [/node_modules\/\.bin\/vitest/, /vitest\/dist\/workers\/forks\.js/, /\bvitest\b/],
    },
    {
      type: 'jest',
      label: 'Jest',
      safeToKill: true,
      patterns: [/node_modules\/\.bin\/jest/, /\bjest\b/],
    },
    {
      type: 'playwright-test',
      label: 'Playwright Test',
      safeToKill: true,
      patterns: [/\bplaywright test\b/, /node_modules\/\.bin\/playwright/],
    },
    {
      type: 'vite-dev',
      label: 'Vite Dev Server',
      safeToKill: false,
      patterns: [/node_modules\/\.bin\/vite(?:\s|$)/, /\bvite\b/],
    },
    {
      type: 'next-dev',
      label: 'Next Dev Server',
      safeToKill: false,
      patterns: [/\bnext dev\b/, /node_modules\/\.bin\/next(?:\s|$)/],
    },
    {
      type: 'nodemon',
      label: 'Nodemon',
      safeToKill: false,
      patterns: [/\bnodemon\b/],
    },
  ];

  for (const rule of rules) {
    if (rule.patterns.some((pattern) => pattern.test(command))) {
      return rule;
    }
  }

  return undefined;
}

function normalizeType(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

function getCwd(pid) {
  try {
    const output = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const line = output.split('\n').find((entry) => entry.startsWith('n'));
    return line ? line.slice(1).trim() : '';
  } catch {
    return '';
  }
}

function collectProcesses() {
  const output = run('ps', ['-Ao', 'pid,ppid,pgid,%cpu,%mem,rss,etime,command']);
  const lines = output.split('\n').slice(1).filter(Boolean);

  return lines.map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) {
      return undefined;
    }

    const [, pid, ppid, pgid, cpu, mem, rss, etime, command] = match;
    const classification = classifyProcess(command);
    if (!classification) {
      return undefined;
    }

    return {
      pid: Number.parseInt(pid, 10),
      ppid: Number.parseInt(ppid, 10),
      pgid: Number.parseInt(pgid, 10),
      cpu: Number.parseFloat(cpu),
      mem: Number.parseFloat(mem),
      rssKb: Number.parseInt(rss, 10),
      etime,
      elapsedSeconds: parseElapsedToSeconds(etime),
      command,
      cwd: '',
      ...classification,
    };
  }).filter(Boolean);
}

function enrichWithCwd(processes) {
  return processes.map((entry) => ({
    ...entry,
    cwd: getCwd(entry.pid),
  }));
}

function printTable(processes) {
  if (processes.length === 0) {
    console.log('No known dev/test processes found.');
    return;
  }

  console.log('PID     PGID    TYPE             CPU   MEM   ELAPSED  SAFE  CWD');
  for (const entry of processes) {
    console.log(
      [
        String(entry.pid).padEnd(7),
        String(entry.pgid).padEnd(7),
        entry.label.padEnd(16),
        `${entry.cpu.toFixed(1)}%`.padStart(5),
        `${entry.mem.toFixed(1)}%`.padStart(5),
        formatSeconds(entry.elapsedSeconds).padStart(8),
        String(entry.safeToKill ? 'yes' : 'no').padStart(5),
        entry.cwd || '(unknown)',
      ].join('  '),
    );
  }
}

function printSummary(processes) {
  const totalCpu = processes.reduce((sum, entry) => sum + entry.cpu, 0);
  const totalMem = processes.reduce((sum, entry) => sum + entry.mem, 0);
  const safeCount = processes.filter((entry) => entry.safeToKill).length;
  console.log(`Found ${processes.length} dev/test processes (${safeCount} safe cleanup targets), CPU ${totalCpu.toFixed(1)}%, MEM ${totalMem.toFixed(1)}%`);
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

function matchesRequestedType(entry, requestedType) {
  if (!requestedType) {
    return true;
  }

  const normalizedRequested = normalizeType(requestedType);
  return normalizedRequested === normalizeType(entry.type)
    || normalizedRequested === normalizeType(entry.label);
}

function cleanup(processes, options) {
  const explicitType = Boolean(options.type);
  const filtered = processes.filter((entry) => {
    if (!matchesRequestedType(entry, options.type)) {
      return false;
    }

    return explicitType ? true : entry.safeToKill;
  });
  const groups = uniqueBy(filtered, (entry) => entry.pgid || entry.pid);

  if (groups.length === 0) {
    console.log(explicitType
      ? `No processes matched cleanup type: ${options.type}`
      : 'No safe processes matched cleanup criteria.');
    return;
  }

  for (const entry of groups) {
    const target = entry.pgid > 0 ? -entry.pgid : entry.pid;
    if (options.dryRun) {
      console.log(`[dry-run] would send SIGTERM to ${target < 0 ? `process group ${-target}` : `pid ${target}`} (${entry.label})`);
      continue;
    }

    try {
      process.kill(target, 'SIGTERM');
      console.log(`sent SIGTERM to ${target < 0 ? `process group ${-target}` : `pid ${target}`} (${entry.label})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`failed to stop ${entry.label} (${target}): ${message}`);
    }
  }
}

function parseArgs(argv) {
  const [mode = 'scan', ...rest] = argv;
  const options = {
    mode,
    dryRun: rest.includes('--dry-run'),
    json: rest.includes('--json'),
    type: undefined,
    limit: 20,
  };

  for (const arg of rest) {
    if (arg.startsWith('--type=')) {
      options.type = arg.slice('--type='.length);
    } else if (arg.startsWith('--limit=')) {
      options.limit = Number.parseInt(arg.slice('--limit='.length), 10) || 20;
    }
  }

  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const processes = enrichWithCwd(collectProcesses())
    .sort((left, right) => right.cpu - left.cpu || right.mem - left.mem)
    .slice(0, options.limit);

  if (options.json) {
    console.log(JSON.stringify(processes, null, 2));
    return;
  }

  printSummary(processes);
  printTable(processes);

  if (options.mode === 'cleanup') {
    console.log('');
    cleanup(processes, options);
  }
}

main();
