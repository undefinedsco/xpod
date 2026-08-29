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
  applicationFallback: '应用',
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
  prepareDescription: '批准访问前，先创建本机存储空间。',
  creationMessage: '还没有可用的存储空间。',
  waitingMessage: '正在等待存储空间绑定。',
  readyMessage: '存储空间已就绪。',
  conflictMessage: '所选存储空间与当前身份不匹配。',
  errorMessage: '无法准备存储空间。',
  createLabel: '创建存储空间',
  continueLabel: '继续',
  retryLabel: '重试',
  cancelLabel: '取消',
} as const;

export const xpodFirstPodCopy = {
  surfaceTitle: '准备存储空间',
  dismiss: '关闭',
  restoring: '正在检查本机存储空间…',
  creating: '正在准备本机存储空间…',
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
  accountIdentityMissing: '当前账号信息不完整，无法自动准备本机存储空间。',
  createEndpointMissing: '找不到创建 Pod 的接口，请刷新后重试。',
  cloudRouteUnavailable: '本机 Xpod 还没有和 Cloud 打通，暂时不能准备存储空间。请保持 Xpod 运行，稍后重试。',
  storageCreateFailed: '无法创建存储空间，请重试。',
} as const;

export function safeXpodRecoveryMessage(status?: number): string {
  if (status === 429) return '请求过多，请稍后再试。';
  return '无法发送重置链接，请重试。';
}

export function safeXpodResetMessage(status?: number): string {
  if (status === 400 || status === 404) return '重置链接无效或已过期。';
  return '无法重设密码，请重试。';
}
