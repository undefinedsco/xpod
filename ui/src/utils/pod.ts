export function getStoredProvisionCode(): string | undefined {
  try {
    const value = sessionStorage.getItem('provisionCode')?.trim();
    return value ? value : undefined;
  } catch {
    return undefined;
  }
}

export function clearStoredProvisionCode(): void {
  try {
    sessionStorage.removeItem('provisionCode');
  } catch {
    // ignore
  }
}

export function buildPodCreatePayload(name: string, provisionCode = getStoredProvisionCode()): Record<string, unknown> {
  const payload: Record<string, unknown> = { name: name.trim() };
  if (provisionCode) {
    payload.settings = { provisionCode };
  }
  return payload;
}
