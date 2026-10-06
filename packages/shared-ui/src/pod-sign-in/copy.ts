/**
 * User-facing wording of the Pod sign-in front door (spec §3).
 *
 * One vocabulary: WebID (the identity), sign-in service (the OIDC issuer),
 * Pod (where data lives), Xpod Cloud / Xpod Edge (where a Pod lives). Hosts may
 * override any string through the `copy` prop; they must not keep a second copy.
 *
 * Placeholders use `{name}` and are filled by `formatCopy`.
 */

export type PodSignInLocale = 'zh-CN' | 'en'

export interface PodSignInCopy {
  // A group: application side
  restoring: string
  enterApp: string
  reauthenticate: string
  useAnother: string
  expiredLine: string
  chooseTitle: string
  chooseLead: string
  useXpod: string
  useOtherSolid: string
  customLabel: string
  customPlaceholder: string
  customSubmit: string
  noAccount: string
  register: string
  noticeDetailsToggle: string
  noticeCopy: string
  noticeCopied: string
  whatIsPod: string
  whatIsPodBody: string
  whatIsWebId: string
  whatIsWebIdBody: string
  signInWith: string
  select: string
  selected: string
  choosePodTitle: string
  choosePodLead: string
  // C group: one-line notices and the primary actions they relabel
  retry: string
  goCreate: string
  refreshPage: string
  startAndEnter: string
  openXpod: string
  noticeUnreachable: string
  noticeIncomplete: string
  noticeNoWebId: string
  noticeCancelled: string
  noticeLocalStopped: string
  noticePending: string
  // B group: sign-in service side
  serviceLabel: string
  signInTitle: string
  returnToApp: string
  email: string
  password: string
  forgotPassword: string
  rememberDevice: string
  signIn: string
  registerLink: string
  registerTitle: string
  username: string
  registerSubmit: string
  haveAccount: string
  podElsewhereSummary: string
  podElsewhereBody: string
  noWebIdTitle: string
  noWebIdLead: string
  webIdName: string
  noWebIdLocation: string
  createAndContinue: string
  chooseOtherLocation: string
  consentTitle: string
  unverifiedWarning: string
  chooseWebId: string
  consentConsequence: string
  requestDetails: string
  scopes: string
  clientId: string
  webIdFull: string
  rememberChoice: string
  manageAccount: string
  switchAccount: string
  deny: string
  allow: string
  storageCloud: string
  storageEdge: string
  // D group: account page
  hostedStorage: string
  independentStorage: string
  identityAddress: string
  storageAddress: string
  showAddresses: string
  webIdSectionTitle: string
  webIdEmpty: string
  createWebId: string
  linkExistingWebId: string
  podOnDevice: string
  authorizedApps: string
  createStepName: string
  createStepLocation: string
  createNameHint: string
  changeDevice: string
  cannotChangeLater: string
  createPod: string
  startDeviceXpod: string
  creatingNote: string
  cancel: string
  devicePickerTitle: string
  addDevice: string
  deviceSectionTitle: string
  deviceStatusOk: string
  deviceStatusUnreachable: string
  deviceStatusStopped: string
  deviceStatusOffline: string
  deviceCloud: string
  deviceEdge: string
  podCount: string
  networkAction: string
  fixAction: string
  collapseAction: string
  webIdSectionHint: string
  deviceSectionHint: string
  credentialSectionHint: string
  startAction: string
  networkTitle: string
  probeLocal: string
  probeLan: string
  probeWan: string
  probeIdle: string
  probeChecking: string
  probeOk: string
  probeFailed: string
  tunnelTitle: string
  enableAndRecheck: string
  enableAndCheck: string
  recheck: string
  skipForNow: string
  reachableVia: string
  networkFootnote: string
  addDeviceTitle: string
  stepInstall: string
  stepNetwork: string
  stepDone: string
  joinThisComputer: string
  installOnOther: string
  waitingForDevice: string
  deviceOnline: string
  finish: string
  useThisDevice: string
  credentialSectionTitle: string
  credentialEmpty: string
  createCredential: string
  revokeCredential: string
  resumeTitle: string
  resumeWaiting: string
  resumeReady: string
  resumeCancel: string
  resumeContinue: string
  close: string
}

const zhCN: PodSignInCopy = {
  restoring: '正在恢复登录…',
  enterApp: '进入 {app}',
  reauthenticate: '重新登录',
  useAnother: '使用其他账号',
  expiredLine: '登录已过期，需要重新确认',
  chooseTitle: '登录',
  chooseLead: '用你的 WebID 账号登录，数据保存在你自己的 Pod 里',
  useXpod: '使用 Xpod 账号登录',
  useOtherSolid: '使用其他 Solid 账号',
  customLabel: '账号服务地址或 WebID',
  customPlaceholder: 'https://example.com/',
  customSubmit: '继续',
  noAccount: '没有账号？',
  register: '注册 Xpod',
  noticeDetailsToggle: '详情',
  noticeCopy: '复制',
  noticeCopied: '已复制',
  whatIsPod: '什么是 Pod？',
  whatIsPodBody: 'Pod 是保存你数据的个人空间。',
  whatIsWebId: '什么是 WebID？',
  whatIsWebIdBody: 'WebID 是登录用的身份，它指向你的个人资料和 Pod。',
  signInWith: '使用 {service} 登录',
  select: '选择',
  selected: '已选择',
  choosePodTitle: '选择 Pod',
  choosePodLead: '选择要继续使用的 Pod',
  retry: '重试',
  goCreate: '去创建',
  refreshPage: '刷新页面',
  startAndEnter: '启动 Xpod 并进入',
  openXpod: '打开 Xpod',
  noticeUnreachable: '暂时连不上 Xpod，请稍后再试',
  noticeIncomplete: '登录没有完成，请再试一次',
  noticeNoWebId: '还没有 WebID',
  noticeCancelled: '登录已取消',
  noticeLocalStopped: '这台电脑上的 Xpod 没有运行',
  noticePending: '上次登录尚未结束',
  serviceLabel: '账号服务',
  signInTitle: '登录 {service}',
  returnToApp: '完成后回到 {app}',
  email: '邮箱',
  password: '密码',
  forgotPassword: '忘记密码？',
  rememberDevice: '在这台设备上保持登录',
  signIn: '登录',
  registerLink: '注册账号',
  registerTitle: '注册 {service}',
  username: '用户名',
  registerSubmit: '注册',
  haveAccount: '已有账号？登录',
  podElsewhereSummary: '想用你自己的独立部署存放 Pod？',
  podElsewhereBody: '注册后，可以在账号页的“存储”里把 Pod 建到你自己的独立部署上；它和当前账号服务是分开的，普通浏览器不会自动把 Pod 转到本机。',
  noWebIdTitle: '还没有 WebID',
  noWebIdLead: '新建一个 WebID 来登录 {app}，数据存在它的 Pod 里',
  webIdName: 'WebID 名称',
  noWebIdLocation: '存放在当前服务',
  createAndContinue: '创建并继续',
  chooseOtherLocation: '存到边缘设备（打开账号页）',
  consentTitle: '授权 {app}',
  unverifiedWarning: '未能验证这个应用的来源，请确认是你要使用的应用',
  chooseWebId: '用哪个 WebID 登录？',
  consentConsequence: '{app} 将以这个身份读写你的数据，之后可以在 Xpod 中收回。',
  requestDetails: '请求详情',
  scopes: '权限范围',
  clientId: '应用标识',
  webIdFull: 'WebID',
  rememberChoice: '以后不再询问',
  manageAccount: '管理账号',
  switchAccount: '换一个账号',
  deny: '拒绝',
  allow: '允许',
  storageCloud: '数据存在 Xpod 云端',
  storageEdge: '数据存在边缘设备上',
  hostedStorage: '账号服务托管',
  independentStorage: '独立部署',
  identityAddress: 'WebID（身份地址）',
  storageAddress: 'Pod（存储地址）',
  showAddresses: '查看地址',
  webIdSectionTitle: 'WebID',
  webIdEmpty: '还没有 WebID。新建一个，用它登录应用。',
  createWebId: '新建 WebID',
  linkExistingWebId: '关联已有 WebID',
  podOnDevice: 'Pod 在 {device}',
  authorizedApps: '已授权 {count} 个应用',
  createStepName: '名称',
  createStepLocation: '存放在',
  createNameHint: 'WebID 地址',
  changeDevice: '更换 ›',
  cannotChangeLater: '创建后不能直接更换，以后要换请使用迁移',
  createPod: '创建 WebID 和 Pod',
  startDeviceXpod: '启动这台设备上的 Xpod',
  creatingNote: '关闭页面不会中断创建',
  cancel: '取消',
  devicePickerTitle: '选择存放设备',
  addDevice: '＋ 添加设备',
  deviceSectionTitle: '设备',
  deviceStatusOk: '正常',
  deviceStatusUnreachable: '⚠ 其他设备访问不到',
  deviceStatusStopped: 'Xpod 已停止',
  deviceStatusOffline: '离线',
  deviceCloud: 'Xpod 云端',
  deviceEdge: '边缘',
  podCount: '{count} 个 Pod',
  networkAction: '网络',
  fixAction: '处理',
  collapseAction: '收起',
  webIdSectionHint: '登录应用时使用的身份，数据存在它的 Pod 里',
  deviceSectionHint: 'Pod 可以存放的地方，网络设置跟着设备走',
  credentialSectionHint: '让脚本或服务以某个 WebID 直接访问 Pod',
  startAction: '启动',
  networkTitle: '网络访问',
  probeLocal: '这台电脑',
  probeLan: '局域网',
  probeWan: '其他网络',
  probeIdle: '未检测',
  probeChecking: '检测中',
  probeOk: '可以访问',
  probeFailed: '不通',
  tunnelTitle: '选择隧道',
  enableAndRecheck: '开启并重新检测',
  enableAndCheck: '开启并检测',
  recheck: '重新检测',
  skipForNow: '跳过，稍后设置',
  reachableVia: '通过 {tunnel} 可以访问',
  networkFootnote: '只影响其他设备；这台电脑上照常可用',
  addDeviceTitle: '添加设备',
  stepInstall: '安装并登录',
  stepNetwork: '检查网络',
  stepDone: '完成',
  joinThisComputer: '把这台电脑加入',
  installOnOther: '在那台设备上安装 Xpod 边缘并登录本账号',
  waitingForDevice: '正在等待新设备上线，登录后这里会自动继续',
  deviceOnline: '已上线',
  finish: '完成',
  useThisDevice: '用这台设备',
  credentialSectionTitle: '密钥',
  credentialEmpty: '还没有密钥。',
  createCredential: '新建密钥',
  revokeCredential: '删除',
  resumeTitle: '{app} 正在等你完成授权',
  resumeWaiting: '在下面新建一个 WebID，完成后就能回去授权',
  resumeReady: 'WebID 已就绪，可以回去授权了',
  resumeCancel: '取消授权',
  resumeContinue: '继续授权 {app}',
  close: '关闭',
}

const en: PodSignInCopy = {
  restoring: 'Restoring your sign-in…',
  enterApp: 'Open {app}',
  reauthenticate: 'Sign in again',
  useAnother: 'Use another account',
  expiredLine: 'Your sign-in expired. Please confirm again.',
  chooseTitle: 'Sign in',
  chooseLead: 'Sign in with your WebID account. Your data stays in your own Pod.',
  useXpod: 'Sign in with Xpod',
  useOtherSolid: 'Use another Solid account',
  customLabel: 'Sign-in service address or WebID',
  customPlaceholder: 'https://example.com/',
  customSubmit: 'Continue',
  noAccount: 'No account?',
  register: 'Register for Xpod',
  noticeDetailsToggle: 'Details',
  noticeCopy: 'Copy',
  noticeCopied: 'Copied',
  whatIsPod: 'What is a Pod?',
  whatIsPodBody: 'A Pod is a personal space that holds your data.',
  whatIsWebId: 'What is a WebID?',
  whatIsWebIdBody: 'A WebID is the identity you sign in with. It points to your profile and your Pod.',
  signInWith: 'Sign in with {service}',
  select: 'Select',
  selected: 'Selected',
  choosePodTitle: 'Choose a Pod',
  choosePodLead: 'Choose the Pod to continue with',
  retry: 'Retry',
  goCreate: 'Create one',
  refreshPage: 'Refresh page',
  startAndEnter: 'Start Xpod and open',
  openXpod: 'Open Xpod',
  noticeUnreachable: 'Cannot reach Xpod right now. Please try again later.',
  noticeIncomplete: 'Sign-in did not finish. Please try again.',
  noticeNoWebId: 'No WebID yet',
  noticeCancelled: 'Sign-in cancelled',
  noticeLocalStopped: 'Xpod is not running on this computer',
  noticePending: 'The previous sign-in has not finished',
  serviceLabel: 'Sign-in service',
  signInTitle: 'Sign in to {service}',
  returnToApp: 'You will return to {app}',
  email: 'Email',
  password: 'Password',
  forgotPassword: 'Forgot password?',
  rememberDevice: 'Keep me signed in on this device',
  signIn: 'Sign in',
  registerLink: 'Register',
  registerTitle: 'Register for {service}',
  username: 'Username',
  registerSubmit: 'Register',
  haveAccount: 'Already have an account? Sign in',
  podElsewhereSummary: 'Want it on your own standalone deployment?',
  podElsewhereBody: 'After registering, create the Pod on your own standalone deployment under Storage on the account page; it is separate from this account service.',
  noWebIdTitle: 'No WebID yet',
  noWebIdLead: 'Create a WebID to sign in to {app}. Your data lives in its Pod.',
  webIdName: 'WebID name',
  noWebIdLocation: 'Stored on the current service',
  createAndContinue: 'Create and continue',
  chooseOtherLocation: 'Store on an edge device (open account page)',
  consentTitle: 'Authorize {app}',
  unverifiedWarning: 'We could not verify this application. Make sure it is the one you meant to use.',
  chooseWebId: 'Which WebID do you sign in with?',
  consentConsequence: '{app} will read and write your data as this identity. You can revoke it later in Xpod.',
  requestDetails: 'Request details',
  scopes: 'Permissions',
  clientId: 'Application ID',
  webIdFull: 'WebID',
  rememberChoice: 'Do not ask again',
  manageAccount: 'Manage account',
  switchAccount: 'Switch account',
  deny: 'Deny',
  allow: 'Allow',
  storageCloud: 'Data is stored on Xpod Cloud',
  storageEdge: 'Data is stored on an edge device',
  hostedStorage: 'Hosted by account service',
  independentStorage: 'Independent deployment',
  identityAddress: 'WebID (identity address)',
  storageAddress: 'Pod (storage address)',
  showAddresses: 'View addresses',
  webIdSectionTitle: 'WebID',
  webIdEmpty: 'No WebID yet. Create one to sign in to applications.',
  createWebId: 'New WebID',
  linkExistingWebId: 'Link an existing WebID',
  podOnDevice: 'Pod on {device}',
  authorizedApps: '{count} authorized apps',
  createStepName: 'Name',
  createStepLocation: 'Store on',
  createNameHint: 'WebID address',
  changeDevice: 'Change ›',
  cannotChangeLater: 'It cannot be changed directly after creation. Use migration later.',
  createPod: 'Create WebID and Pod',
  startDeviceXpod: 'Start Xpod on this device',
  creatingNote: 'Closing this page will not interrupt creation',
  cancel: 'Cancel',
  devicePickerTitle: 'Choose where to store',
  addDevice: '+ Add device',
  deviceSectionTitle: 'Devices',
  deviceStatusOk: 'Healthy',
  deviceStatusUnreachable: '⚠ Not reachable from other devices',
  deviceStatusStopped: 'Xpod stopped',
  deviceStatusOffline: 'Offline',
  deviceCloud: 'Xpod Cloud',
  deviceEdge: 'Edge',
  podCount: '{count} Pods',
  networkAction: 'Network',
  fixAction: 'Fix',
  collapseAction: 'Collapse',
  webIdSectionHint: 'The identity you sign in to apps with. Your data lives in its Pod.',
  deviceSectionHint: 'Places a Pod can live. Network settings follow the device.',
  credentialSectionHint: 'Let a script or service reach a Pod directly as one WebID.',
  startAction: 'Start',
  networkTitle: 'Network access',
  probeLocal: 'This computer',
  probeLan: 'Local network',
  probeWan: 'Other networks',
  probeIdle: 'Not checked',
  probeChecking: 'Checking',
  probeOk: 'Reachable',
  probeFailed: 'Unreachable',
  tunnelTitle: 'Choose a tunnel',
  enableAndRecheck: 'Enable and recheck',
  enableAndCheck: 'Enable and check',
  recheck: 'Recheck',
  skipForNow: 'Skip, set up later',
  reachableVia: 'Reachable through {tunnel}',
  networkFootnote: 'Only affects other devices. This computer keeps working as usual.',
  addDeviceTitle: 'Add a device',
  stepInstall: 'Install and sign in',
  stepNetwork: 'Check network',
  stepDone: 'Done',
  joinThisComputer: 'Add this computer',
  installOnOther: 'Install Xpod Edge on that device and sign in to this account',
  waitingForDevice: 'Waiting for the new device to come online. This continues automatically after sign-in.',
  deviceOnline: 'Online',
  finish: 'Done',
  useThisDevice: 'Use this device',
  credentialSectionTitle: 'Credentials',
  credentialEmpty: 'No credentials yet.',
  createCredential: 'New credential',
  revokeCredential: 'Delete',
  resumeTitle: '{app} is waiting for you to finish authorizing',
  resumeWaiting: 'Create a WebID below, then you can go back and authorize',
  resumeReady: 'Your WebID is ready. You can go back and authorize.',
  resumeCancel: 'Cancel authorization',
  resumeContinue: 'Continue authorizing {app}',
  close: 'Close',
}

export const podSignInCopy: Record<PodSignInLocale, PodSignInCopy> = { 'zh-CN': zhCN, en }

export function resolvePodSignInCopy(
  locale: PodSignInLocale = 'zh-CN',
  overrides?: Partial<PodSignInCopy>,
): PodSignInCopy {
  return { ...podSignInCopy[locale], ...overrides }
}

/** Fills `{name}` placeholders; unknown placeholders are left untouched. */
export function formatCopy(template: string, values: Record<string, string | number | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key]
    return value === undefined ? match : String(value)
  })
}
