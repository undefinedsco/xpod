const DEFAULT_DESKTOP_URL = 'http://127.0.0.1:3000/network/overview'

export function resolveDesktopTargetUrl({
  argv = process.argv,
  env = process.env,
}: {
  argv?: readonly string[]
  env?: Readonly<Record<string, string | undefined>>
} = {}): string {
  const argumentIndex = argv.findIndex((item) => item === '--url')
  const fromArgument = argumentIndex >= 0 ? argv[argumentIndex + 1] : undefined
  return fromArgument || env.XPOD_DESKTOP_URL || DEFAULT_DESKTOP_URL
}
