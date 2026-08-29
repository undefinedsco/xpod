export function isLocalAccessUrl(url?: string | null): boolean {
  if (typeof url !== 'string' || !url.trim()) {
    return false
  }

  try {
    return isLocalAccessHostname(new URL(url).hostname)
  } catch {
    return false
  }
}
export function isLocalAccessHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  if (normalized === 'localhost' || normalized === '[::1]' || normalized.endsWith('.local')) {
    return true
  }

  const parts = normalized.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }

  const [first, second] = parts
  return first === 10
    || first === 127
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254)
}
