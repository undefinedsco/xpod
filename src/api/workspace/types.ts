export type WorkspaceRef = string;

export function isWorkspaceRef(value: unknown): value is WorkspaceRef {
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

export function assertWorkspaceRef(value: unknown, label = 'workspace'): WorkspaceRef {
  if (isWorkspaceRef(value)) {
    return value;
  }
  throw new Error(`${label} must be an http(s):// or file:// workspace reference`);
}
