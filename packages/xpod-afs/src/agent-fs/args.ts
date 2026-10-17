/**
 * Conservative ripgrep argv classifier.
 *
 * Only argument combinations whose semantics the HTTP search backend can
 * reproduce exactly are taken over. Everything else (regex patterns, stdin,
 * ignore-file handling, context flags, unsupported output modes) is reported as
 * `fallback` so the caller can exec the pre-resolved native binary unchanged.
 */

export type RgFallbackReason = string;

export interface RgFilesInvocation {
  kind: 'files';
  hidden: boolean;
  sort: 'path';
  pathArg?: string;
}

export interface RgSearchInvocation {
  kind: 'search';
  query: string;
  hidden: boolean;
  sort: 'path';
  ignoreCase: boolean;
  lineNumber?: boolean;
  filesWithMatches: boolean;
  count: boolean;
  noHeading: boolean;
  color: 'never' | 'auto';
  pathArg?: string;
}

export type RgInvocation = RgFilesInvocation | RgSearchInvocation;

export type RgParseResult =
  | { kind: 'managed'; invocation: RgInvocation }
  | { kind: 'fallback'; reason: RgFallbackReason };

interface MutableOptions {
  files: boolean;
  fixedStrings: boolean;
  noIgnore: boolean;
  hidden: boolean;
  sort?: string;
  ignoreCase: boolean;
  lineNumber?: boolean;
  filesWithMatches: boolean;
  count: boolean;
  noHeading: boolean;
  color: 'never' | 'auto';
  patterns: string[];
  paths: string[];
  endOfOptions: boolean;
}

const BOOLEAN_SHORT = new Set([ 'F', 'i', 'n', 'l', 'c' ]);

function fallback(reason: RgFallbackReason): RgParseResult {
  return { kind: 'fallback', reason };
}

function parseLongOption(arg: string, options: MutableOptions, takeNext: () => string | undefined): RgFallbackReason | undefined {
  const equalsIndex = arg.indexOf('=');
  const name = equalsIndex === -1 ? arg.slice(2) : arg.slice(2, equalsIndex);
  const inlineValue = equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);

  const takesValue = name === 'sort' || name === 'color' || name === 'regexp';
  if (!takesValue && inlineValue !== undefined) {
    // `--hidden=true` is not equivalent to `--hidden`; let native decide.
    return `--${name} does not take an inline value`;
  }

  switch (name) {
    case 'files':
      options.files = true;
      return undefined;
    case 'fixed-strings':
      options.fixedStrings = true;
      return undefined;
    case 'no-ignore':
      options.noIgnore = true;
      return undefined;
    case 'hidden':
      options.hidden = true;
      return undefined;
    case 'ignore-case':
      return 'case-insensitive matching is not differential-proven; use the native binary';
    case 'line-number':
      options.lineNumber = true;
      return undefined;
    case 'no-line-number':
      options.lineNumber = false;
      return undefined;
    case 'files-with-matches':
      options.filesWithMatches = true;
      return undefined;
    case 'count':
      options.count = true;
      return undefined;
    case 'no-heading':
      options.noHeading = true;
      return undefined;
    case 'heading':
      return 'heading output is not reproduced';
    case 'sort': {
      const value = inlineValue ?? takeNext();
      if (value !== 'path') {
        return `--sort ${value ?? ''} is not supported (only "path")`;
      }
      options.sort = 'path';
      return undefined;
    }
    case 'color': {
      const value = inlineValue ?? takeNext();
      if (value === 'never') {
        options.color = 'never';
        return undefined;
      }
      if (value === 'auto') {
        options.color = 'auto';
        return undefined;
      }
      if (value === 'always' || value === 'ansi') {
        return `--color ${value} output is not reproduced; pass --color=never`;
      }
      return `--color ${value ?? ''} is not supported (only "never"/"auto")`;
    }
    case 'regexp': {
      const value = inlineValue ?? takeNext();
      if (value === undefined) {
        return '--regexp requires a value';
      }
      options.patterns.push(value);
      return undefined;
    }
    case 'no-filename':
      return '--no-filename changes the output prefix contract';
    case 'with-filename':
      return undefined;
    case 'no-messages':
    case 'stats':
    case 'json':
    case 'vimgrep':
    case 'null':
    case 'null-data':
      return `--${name} output is not supported`;
    default:
      return `unsupported option --${name}`;
  }
}

function parseShortCluster(arg: string, options: MutableOptions, takeNext: () => string | undefined): RgFallbackReason | undefined {
  const cluster = arg.slice(1);
  for (let index = 0; index < cluster.length; index += 1) {
    const char = cluster[index];
    if (char === 'e') {
      const inline = cluster.slice(index + 1);
      const value = inline.length > 0 ? inline : takeNext();
      if (value === undefined) {
        return '-e requires a value';
      }
      options.patterns.push(value);
      return undefined;
    }
    if (!BOOLEAN_SHORT.has(char)) {
      return `unsupported short option -${char}`;
    }
    switch (char) {
      case 'F':
        options.fixedStrings = true;
        break;
      case 'i':
        return 'case-insensitive matching is not differential-proven; use the native binary';
      case 'n':
        options.lineNumber = true;
        break;
      case 'l':
        options.filesWithMatches = true;
        break;
      case 'c':
        options.count = true;
        break;
      default:
        break;
    }
  }
  return undefined;
}

export function parseRgArgs(argv: string[]): RgParseResult {
  const options: MutableOptions = {
    files: false,
    fixedStrings: false,
    noIgnore: false,
    hidden: false,
    ignoreCase: false,
    filesWithMatches: false,
    count: false,
    noHeading: false,
    color: 'auto',
    patterns: [],
    paths: [],
    endOfOptions: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (options.endOfOptions) {
      if (options.files) {
        options.paths.push(arg);
      } else if (options.patterns.length === 0) {
        options.patterns.push(arg);
      } else {
        options.paths.push(arg);
      }
      continue;
    }

    if (arg === '--') {
      options.endOfOptions = true;
      continue;
    }

    if (arg.startsWith('--')) {
      const error = parseLongOption(arg, options, () => argv[++index]);
      if (error) {
        return fallback(error);
      }
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      const error = parseShortCluster(arg, options, () => argv[++index]);
      if (error) {
        return fallback(error);
      }
      continue;
    }

    if (options.files) {
      options.paths.push(arg);
    } else if (options.patterns.length === 0) {
      options.patterns.push(arg);
    } else {
      options.paths.push(arg);
    }
  }

  if (options.paths.length > 1) {
    return fallback('multiple paths are not merged by the managed backend');
  }

  if (!options.noIgnore) {
    return fallback('ignore-file semantics require the native binary; pass --no-ignore to opt in');
  }
  if (options.sort !== 'path') {
    return fallback('pass --sort path to guarantee deterministic managed ordering');
  }

  const pathArg = options.paths[0];

  if (options.files) {
    if (options.patterns.length > 0) {
      return fallback('--files does not take a pattern');
    }
    return {
      kind: 'managed',
      invocation: {
        kind: 'files',
        hidden: options.hidden,
        sort: 'path',
        ...(pathArg ? { pathArg } : {}),
      },
    };
  }

  if (!options.fixedStrings) {
    return fallback('only fixed-string (-F) searches are taken over in this batch');
  }
  if (options.patterns.length !== 1) {
    return fallback('exactly one fixed-string pattern is required');
  }
  const pattern = options.patterns[0];
  if (pattern.length === 0) {
    return fallback('empty patterns are handled by the native binary');
  }
  if (pattern.includes('\n') || pattern.includes('\r')) {
    return fallback('multi-line patterns are handled by the native binary');
  }
  if (options.filesWithMatches && options.count) {
    return fallback('-l and -c cannot be combined');
  }

  return {
    kind: 'managed',
    invocation: {
      kind: 'search',
      query: options.patterns[0],
      hidden: options.hidden,
      sort: 'path',
      ignoreCase: options.ignoreCase,
      ...(options.lineNumber === undefined ? {} : { lineNumber: options.lineNumber }),
      filesWithMatches: options.filesWithMatches,
      count: options.count,
      noHeading: options.noHeading,
      color: options.color,
      ...(pathArg ? { pathArg } : {}),
    },
  };
}
