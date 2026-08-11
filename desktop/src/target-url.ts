const DEFAULT_DESKTOP_URL = 'http://127.0.0.1:3000/status/overview'

export function resolveDesktopTargetUrl({
  argv = process.argv,
  env = process.env,
}: {
  argv?: readonly string[]
  env?: Readonly<Record<string, string | undefined>>
} = {}): string {
  const argumentIndex = argv.findIndex((item) => item === '--url')
  const fromArgument = argumentIndex >= 0 ? argv[argumentIndex + 1] : undefined
  return [fromArgument, env.XPOD_DESKTOP_URL, DEFAULT_DESKTOP_URL]
    .map((candidate) => candidate?.trim())
    .find((candidate): candidate is string => isSafeLoopbackUrl(candidate))!
}

function isSafeLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false

  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return false
    }
    return isLoopbackHostname(url.hostname)
  } catch {
    return false
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  if (normalized === 'localhost' || normalized === '::1') return true

  const octets = normalized.split('.')
  return octets.length === 4
    && octets[0] === '127'
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
}
