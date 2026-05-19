export type WorkspaceUri = string;

export function isWorkspaceUri(value: unknown): value is WorkspaceUri {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'file:';
  } catch {
    return false;
  }
}

export function assertWorkspaceUri(value: unknown, label = 'workspace'): WorkspaceUri {
  if (isWorkspaceUri(value)) {
    return value;
  }
  throw new Error(`${label} must be an http(s):// or file:// URI`);
}
