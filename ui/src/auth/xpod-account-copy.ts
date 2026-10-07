import type {
  AccountCredentialsCopy,
  PasswordRecoveryCopy,
  PasswordResetCopy,
} from './XpodAccountViews';

export const xpodAccountCredentialsCopy: AccountCredentialsCopy = {
  productName: 'Xpod 账号',
  loginTitle: '登录',
  registerTitle: '创建账号',
  usernameLabel: 'Pod 名称',
  usernamePlaceholder: '选择 Pod 名称',
  emailLabel: '邮箱',
  emailPlaceholder: 'you@example.com',
  passwordLabel: '密码',
  passwordPlaceholder: '输入密码',
  confirmationLabel: '确认密码',
  confirmationPlaceholder: '再次输入密码',
  loginAction: '登录',
  registerAction: '创建账号',
  switchToRegister: '切换用户',
  switchToLogin: '返回登录',
  usernameChecking: '正在检查 Pod 名称…',
  usernameAvailable: 'Pod 名称可用',
  usernameUnavailable: 'Pod 名称不可用',
  suggestionsLabel: '可用建议',
  mismatchError: '两次输入的密码不一致',
};

export const xpodPasswordRecoveryCopy: PasswordRecoveryCopy = {
  title: '找回密码',
  description: '如果这个邮箱已注册，我们会发送重置链接。',
  emailLabel: '邮箱',
  emailPlaceholder: 'you@example.com',
  actionLabel: '发送重置链接',
  successTitle: '请查收邮件',
  successMessage: '如果该邮箱已注册，重置链接已经发出。',
};

export const xpodPasswordResetCopy: PasswordResetCopy = {
  title: '设置新密码',
  description: '为你的账号选择一个新密码。',
  passwordLabel: '新密码',
  passwordPlaceholder: '输入新密码',
  confirmationLabel: '确认密码',
  confirmationPlaceholder: '再次输入密码',
  actionLabel: '重设密码',
  successMessage: '密码已重设。',
  mismatchError: '两次输入的密码不一致',
};

export const xpodAccountPageCopy = {
  loginSurfaceTitle: '登录',
  registerSurfaceTitle: '创建账号',
  recoverSurfaceTitle: '找回密码',
  resetSurfaceTitle: '重设密码',
  forgotPassword: '忘记密码？',
  backToSignIn: '返回登录',
  cancelAuthorization: '取消授权',
  cancellingAuthorization: '正在取消…',
  resend: '重新发送',
} as const;

export const xpodConsentCopy = {
  surfaceTitle: '授权',
  signInRequiredTitle: '需要先登录',
  signInRequiredDescription: '请先登录，再批准这次请求并选择要共享的 WebID。',
  goToSignIn: '去登录',
  unavailableTitle: '暂时无法授权',
  tryAgain: '重试',
  dismiss: '关闭',
  restoring: '正在恢复授权…',
  applicationFallback: '这个应用',
  title: '批准访问',
  description: (clientName: string) => `${clientName} 请求访问你的账号数据。`,
  webIdLabel: 'WebID',
  bindingLabel: '身份与存储空间',
  storageLabel: 'Storage',
  rememberClientLabel: '记住这个应用',
  approveLabel: '批准',
  approvingLabel: '正在批准…',
  denyLabel: '拒绝',
  denyingLabel: '正在拒绝…',
  editAccountLabel: '管理账号',
  switchAccountLabel: '换一个账号',
  podNameLabel: 'Pod 名称',
  prepareTitle: '准备存储空间',
  prepareDescription: '批准访问前，先准备存储空间。',
  creationMessage: '还没有可用的存储空间。',
  waitingMessage: '正在等待存储空间绑定。',
  readyMessage: '存储空间已就绪。',
  conflictMessage: '所选存储空间与当前身份不匹配。',
  errorMessage: '无法准备存储空间。',
  createLabel: '创建存储空间',
  continueLabel: '继续',
  retryLabel: '重试',
  cancelLabel: '取消',
  // 授权页缺 Pod 的出口（设计第二部分 §4.1 / U06）：授权流程仍然不代用户创建，
  // 创建只在用户显式点击主操作后发生；说明原因，并给出创建、管理与拒绝三个出口。
  missingPodTitle: '还没有可用的存储空间',
  missingPodDescription: '批准访问前需要一个属于当前身份的存储空间。请先在 Pod 管理中创建或绑定，再回到这里继续授权。',
  createPodAndContinueLabel: '创建存储空间并继续授权',
  goToPodManagementLabel: '前往 Pod 管理',
  // WebID 名称的可用性提示（授权页“还没有 WebID”）：只说名称，不说 Pod。
  webIdNameChecking: '正在检查名称…',
  webIdNameAvailable: '可以使用',
  webIdNameTaken: '这个名称已被占用',
} as const;

export const xpodFirstPodCopy = {
  surfaceTitle: '准备存储空间',
  dismiss: '关闭',
  restoring: '正在检查存储空间…',
  creating: '正在准备存储空间…',
  unavailableTitle: '存储空间未准备好',
  podNameLabel: 'Pod 名称',
  title: '创建第一个存储空间',
  description: '进入工作台前，先为这个账号准备存储空间。',
  creationMessage: '这个账号还没有绑定存储空间。',
  waitingMessage: '正在等待 WebID 与存储空间绑定。',
  readyMessage: '存储空间已就绪。',
  conflictMessage: '所选存储空间与当前身份不匹配。',
  errorMessage: '无法准备存储空间。',
  createLabel: '创建存储空间',
  continueLabel: '继续',
  retryLabel: '重试',
  cancelLabel: '取消',
} as const;

export const xpodRegistrationCopy = {
  usernameRequired: '请填写 Pod 名称',
  usernameLength: 'Pod 名称需为 3-63 个字符',
  usernameCharset: 'Pod 名称只能包含小写字母、数字和连字符',
  usernameHyphen: 'Pod 名称不能以连字符开头或结尾',
  usernameUnavailable: '暂时无法检查 Pod 名称，请重试。',
  usernameChecking: '正在检查 Pod 名称…',
  usernameAvailable: 'Pod 名称可用，可以创建。',
  emailAlreadyRegistered: '该邮箱已注册，请登录或重置密码。',
  emailAlreadyRegisteredPasswordMismatch: '该邮箱已注册，但密码不正确，请登录或重置密码。',
  usernameAlreadyTaken: 'Pod 名称已被占用。账号已创建，请登录后换一个名称。',
  choosePodName: '请填写 Pod 名称。',
  podNameTaken: 'Pod 名称已被占用，请换一个。',
} as const;

export function safeXpodLoginMessage(status: number): string {
  if (status === 401 || status === 403) return '邮箱或密码不正确。';
  if (status === 429) return '尝试次数过多，请稍后再试。';
  return '登录失败，请重试。';
}

export function safeXpodRegistrationMessage(): string {
  return '无法完成注册，请重试。';
}

export function safeXpodAuthorizationCancelMessage(): string {
  return '取消授权失败，请重试。';
}

export function safeXpodConsentMessage(fallback = '授权失败，请重试。'): string {
  return fallback;
}

export const xpodConsentErrors = {
  invalidTransaction: '登录状态无效。',
  expiredInteraction: '本次授权请求已失效，请返回应用重新发起登录。',
  bindingUnavailable: '应用选择的身份与存储空间已不可用，请返回应用重新选择。',
  returnFailed: '无法返回应用，请重试。',
  signInRequired: '请先登录，再继续授权。',
  loadFailed: '无法加载授权信息，请重试。',
  clientUnavailable: '无法获取应用信息。',
  bindingsFailed: '无法加载 WebID 绑定，请重试。',
  signOutIncomplete: '退出未完成，请重试。',
  cancelFailed: '取消授权失败，请重试。',
  chooseStorage: '批准前请先选择存储空间。',
  cannotPersistStorage: '当前浏览器无法保存这次存储选择。',
  webIdSelectionFailed: '无法完成 WebID 选择，请重试。',
  authorizationFailed: '无法完成授权，请重试。',
  missingRedirect: '授权已完成，但没有返回跳转地址，请重新登录。',
  choosePodName: '创建存储空间前请先填写 Pod 名称。',
  storageCreationUnavailable: '暂时无法创建存储空间。',
  storageCreateFailed: '无法创建存储空间，请重试。',
} as const;

export const xpodFirstPodErrors = {
  checkFailed: '无法检查存储空间状态，请重试。',
  accountIdentityMissing: '当前账号信息不完整，暂时无法创建 Pod。请刷新后重试。',
  createEndpointMissing: '找不到创建 Pod 的接口，请刷新后重试。',
  cloudRouteUnavailable: '本机 Xpod 还没有和 Cloud 打通，暂时不能准备存储空间。请保持 Xpod 运行，稍后重试。',
  storageCreateFailed: '无法创建存储空间，请重试。',
  cancelFailed: '取消授权失败，请重试或直接关闭此页面。',
  authorizationUnavailable: '原来的授权已经失效，或暂时无法确认它仍然有效。请回到授权页面重试或重新发起。',
} as const;

export function safeXpodRecoveryMessage(status?: number): string {
  if (status === 429) return '请求过多，请稍后再试。';
  return '无法发送重置链接，请重试。';
}

export function safeXpodResetMessage(status?: number): string {
  if (status === 400 || status === 404) return '重置链接无效或已过期。';
  return '无法重设密码，请重试。';
}

/**
 * The Account document copy. Xpod ships zh-CN as the default; `en` is only used
 * when the host explicitly selects it, so the shared sign-in windows and the
 * Account page stay on one locale policy.
 */
export type XpodAccountPageLocale = 'zh-CN' | 'en';

const ACCOUNT_PAGE_LOCALE_KEY = 'xpod.account.locale';

export function resolveXpodAccountPageLocale(explicit?: string | null): XpodAccountPageLocale {
  if (explicit === 'en' || explicit === 'zh-CN') return explicit;
  try {
    if (window.localStorage.getItem(ACCOUNT_PAGE_LOCALE_KEY) === 'en') return 'en';
  } catch {
    // Storage unavailable: fall back to the default locale.
  }
  return 'zh-CN';
}

const accountPageCopy = {
  'zh-CN': {
    serviceName: '账号服务',
    brandName: 'Xpod',
    dashboardTitle: '账号总览',
    about: '关于',
    signOut: '退出登录',
    authorizationPendingTitle: '等待授权',
    authorizationPendingLead: '有应用正在等待你的授权',
    continueAuthorization: '继续授权',
    cancelAuthorization: '取消授权',
    cancelAuthorizationFailed: '取消授权失败，请重试。',
    authorizationUnavailable: '当前授权已失效，请回到应用重新发起。',
    storageTitle: '存储空间',
    storageLead: '你的个人数据存储（Pod）。这里的数据由你拥有和控制。',
    managePods: '管理 Pod',
    workspaceTitle: '桌面 Xpod',
    openWorkspace: '桌面管理入口',
    workspaceHint: '使用桌面 Xpod 管理自己的部署、AI 连接和系统设置。',
    noPodOnDevice: '这台设备还没有 Pod。创建一个即可在这里存储数据。',
    noPodsFound: '还没有 Pod。创建一个即可开始。',
    podLabel: 'Pod',
    deletePod: '删除 Pod',
    enablePodDeletion: '启用删除',
    enablePodDeletionFailed: '无法打开设备授权页面，请重试。',
    identityTitle: '身份',
    identityLead: '你的去中心化标识（WebID）。这是你在 Solid 网络上的身份。',
    noWebIds: '还没有 WebID。先创建存储空间即可获得 WebID。',
    credentialsTitle: 'Solid 客户端凭据',
    credentialsLead: '供需要直接访问 Pod 的客户端使用的 Solid 凭据。Xpod API Key 在 AI 连接中管理。',
    newCredential: '新建凭据',
    credentialEndpointMissing: '尚未配置客户端凭据接口。',
    credentialName: '凭据名称',
    selectWebId: '选择 WebID',
    cancel: '取消',
    create: '创建',
    creating: '正在创建…',
    credentialCreated: '新的 Solid 客户端凭据已创建',
    credentialCreatedLead: '请立即复制 Client ID 与 Client Secret。Secret 不会再次显示。',
    clientId: 'Client ID',
    clientSecret: 'Client Secret',
    copyClientId: '复制 Client ID',
    copyClientSecret: '复制 Client Secret',
    done: '完成',
    noCredentials: '还没有客户端凭据。',
    revokeCredential: '吊销凭据',
    securityTitle: '安全',
    passwordLabel: '密码',
    passwordLead: '更新你的账号密码',
    changePassword: '修改密码',
    closeError: '关闭错误提示',
    deletePodConfirm: (pod: string) => `删除 Pod ${pod}？此操作无法撤销。`,
    deletePodWarning: '此操作会永久删除这个 Pod 的数据，无法撤销。请确认下面的存储地址。',
    deletePodFailed: '无法删除 Pod，请重试。',
    deletePodNodeUnavailable: '无法连接这个 Pod 所在的设备。请确认设备在线后重试。',
    deletePodNodeFailed: '设备未能完成删除。请检查设备状态后重试。',
    deletePodNotAcknowledged: '尚未收到设备的删除确认，请重试以确认结果。',
    deletePodUnsupported: '这个存储服务暂不支持在此删除 Pod。',
    deleting: '正在删除…',
    revokeCredentialFailed: '无法吊销客户端凭据，请重试。',
    actionUnavailable: '当前账号或操作已失效，请刷新后重试。',
    deleteCredentialConfirm: '删除这条凭据？此操作无法撤销。',
  },
  en: {
    serviceName: 'Account service',
    brandName: 'Xpod',
    dashboardTitle: 'Account Dashboard',
    about: 'About',
    signOut: 'Sign out',
    authorizationPendingTitle: 'Authorization Pending',
    authorizationPendingLead: 'An application is waiting for your authorization',
    continueAuthorization: 'Continue',
    cancelAuthorization: 'Cancel authorization',
    cancelAuthorizationFailed: 'Could not cancel the authorization. Try again.',
    authorizationUnavailable: 'This authorization is no longer valid. Start again from the application.',
    storageTitle: 'Storage',
    storageLead: 'Your personal data stores (Pods). You own and control all data stored here.',
    managePods: 'Manage Pods',
    workspaceTitle: 'Xpod workspace',
    openWorkspace: 'Open Xpod workspace',
    workspaceHint: 'Manage Pods, AI connections and system settings in the workspace.',
    noPodOnDevice: 'This device has no Pod yet. Create one to store data here.',
    noPodsFound: 'No Pods found. Create one to get started.',
    podLabel: 'Pod',
    deletePod: 'Delete Pod',
    enablePodDeletion: 'Enable deletion',
    enablePodDeletionFailed: 'Could not open device authorization. Try again.',
    identityTitle: 'Identity',
    identityLead: 'Your unique decentralized identifiers (WebIDs). This is your identity on the Solid network.',
    noWebIds: 'No WebIDs found. Create a Pod first to get a WebID.',
    credentialsTitle: 'Solid Client Credentials',
    credentialsLead: 'Solid credentials for clients that need direct Pod access. Xpod API Keys are managed in AI Connections.',
    newCredential: 'New Credential',
    credentialEndpointMissing: 'Client credential endpoint not configured.',
    credentialName: 'Credential Name',
    selectWebId: 'Select WebID',
    cancel: 'Cancel',
    create: 'Create',
    creating: 'Creating...',
    credentialCreated: 'New Solid Client Credential Created',
    credentialCreatedLead: 'Copy the Client ID and Client Secret now. The secret will not be shown again.',
    clientId: 'Client ID',
    clientSecret: 'Client Secret',
    copyClientId: 'Copy Client ID',
    copyClientSecret: 'Copy Client Secret',
    done: 'Done',
    noCredentials: 'No client credentials found.',
    revokeCredential: 'Revoke Credential',
    securityTitle: 'Security',
    passwordLabel: 'Password',
    passwordLead: 'Update your account password',
    changePassword: 'Change Password',
    closeError: 'Dismiss error',
    deletePodConfirm: (pod: string) => `Delete pod ${pod}? This cannot be undone.`,
    deletePodWarning: 'This permanently deletes the data in this Pod and cannot be undone. Check the storage address below.',
    deletePodFailed: 'Could not delete the Pod. Try again.',
    deletePodNodeUnavailable: 'Cannot connect to the device hosting this Pod. Check that it is online and try again.',
    deletePodNodeFailed: 'The device could not finish deleting the Pod. Check its status and try again.',
    deletePodNotAcknowledged: 'The device has not confirmed deletion yet. Retry to check the result.',
    deletePodUnsupported: 'This storage service does not support deleting Pods here yet.',
    deleting: 'Deleting…',
    revokeCredentialFailed: 'Could not revoke the client credential. Try again.',
    actionUnavailable: 'This account or action is no longer valid. Refresh and try again.',
    deleteCredentialConfirm: 'Delete this credential? This cannot be undone.',
  },
} as const;

export function xpodAccountDashboardCopy(locale: XpodAccountPageLocale = 'zh-CN') {
  return accountPageCopy[locale];
}


export const podDeletionAuthorizationCopy = {
  'zh-CN': {
    title: '启用 Pod 删除', lead: '允许这个账号管理下方当前的 Pod。授权成功后，请返回账号页面；删除数据仍需另行确认。',
    account: '授权给账号', address: '当前 Pod 地址', identities: '当前 Pod 的身份', allow: '允许这个账号删除此 Pod', cancel: '取消',
    loading: '正在核对设备与 Pod…', pending: '正在授权…', retry: '重新核对', back: '返回账号页面',
    done: '已启用删除。这个 Pod 的数据尚未删除。',
    operator: '请在存放这个 Pod 的设备上打开 Xpod，再完成授权。当前访问没有设备管理权限。',
    localAddress: '本机 Xpod 管理地址',
    localHint: '仅当这台电脑就是存放这个 Pod 的设备时继续。请从这台设备上的 Xpod 复制管理地址；不会自动探测本机服务。',
    localContinue: '在本机继续',
    localInvalid: '请输入本机 localhost、127.0.0.1 或 [::1] 的 HTTP(S) 地址，不得包含账号密码、查询参数或片段。',
    invalid: '授权请求已失效，请返回账号页面重新开始。',
    changed: '这个地址的 Pod 已发生变化。请返回账号页面重新发起授权。',
    unavailable: '暂时无法连接账号服务，请稍后重试。',
    failed: '未能完成授权，请重试。',
  },
  en: {
    title: 'Enable Pod deletion', lead: 'Allow this account to manage the current Pod below. Return to the account page afterwards; deleting data still requires a separate confirmation.',
    account: 'Authorize account', address: 'Current Pod address', identities: 'Current Pod identities', allow: 'Allow this account to delete this Pod', cancel: 'Cancel',
    loading: 'Checking the device and Pod…', pending: 'Authorizing…', retry: 'Check again', back: 'Return to account',
    done: 'Deletion is enabled. The Pod data has not been deleted.',
    operator: 'Open Xpod on the device hosting this Pod to authorize it. This connection has no device management access.',
    localAddress: 'Xpod address on this device',
    localHint: 'Continue only if this computer hosts the Pod. Copy the management address from Xpod on this device. Local services are not probed automatically.',
    localContinue: 'Continue on this device',
    localInvalid: 'Enter an HTTP(S) address on localhost, 127.0.0.1, or [::1], without credentials, query parameters, or a fragment.',
    invalid: 'This authorization request is no longer valid. Start again from your account page.',
    changed: 'The Pod at this address has changed. Start a new authorization from your account page.',
    unavailable: 'Cannot reach the account service. Try again later.', failed: 'Could not authorize this Pod. Try again.',
  },
};
