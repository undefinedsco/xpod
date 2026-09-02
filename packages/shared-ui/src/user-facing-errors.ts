const INTERNAL_ERROR_PATTERN =
  /\b(provisionCode|providerCode|canonical|OIDC|openid-configuration|issuer|provider|storageProvider|publicUrl|baseUrl|spDomain|idpUrl|WebID|solid:storage|profile|dashboard|findById|IRI|HTTP\s+\d{3}|Cannot find module|node_modules|jsonld|componentsjs|cloudflared|Cloudflare Tunnel|container|root container|database|query failed|resource id|BadRequestHttpError|H400|xpod|runtime|Application Support|localhost|CSS_[A-Z_]+|XPOD_[A-Z_]+|Pod|podUrl|Solid|RDF|row\.id|row id|subject|Agent|Secretary|authenticated fetch|client_secret|client_id|access_token|refresh_token|threadId|chatId|messageId|workspaceUri|nodeId)\b/i

const STACK_OR_PATH_PATTERN = /(?:\/Users\/|\\Users\\|\.tsx?:\d+|\.jsx?:\d+|Require stack|at\s+\w+[\w.]*\s*\()/i
const RAW_ADDRESS_PATTERN = /(?:https?:\/\/|file:\/\/|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i

export function formatErrorForUser(error: unknown, fallback = '操作失败，请重试。'): string {
  const raw = extractErrorMessage(error)
  if (!raw) {
    return fallback
  }

  const message = safeDecodeURIComponent(raw).trim()
  const normalized = message.toLowerCase()

  if (/email_unverified|verify_required/.test(normalized)) {
    return '请先验证邮箱。打开注册邮箱里的验证邮件后，再回到 LinX 重试。'
  }

  if (/login_required|interaction_required|consent_required|account_selection_required/.test(normalized)) {
    return '需要重新确认登录。请在弹出的登录窗口完成授权。'
  }

  if (/access_denied|access denied|authorization_denied|user_cancelled|user canceled|cancelled|canceled/.test(normalized)) {
    return '登录已取消。请重新登录，或返回空间选择页换一个空间。'
  }

  if (/retry failed|reconnect failed|重新发起登录失败/.test(normalized)) {
    return '登录没有重新打开。请返回空间选择页后再试。'
  }

  if (
    /publicurl is required|canonical|spdomain|local.*cloud.*绑定|cloud.*local.*绑定|绑定信息|selected local sp|local storage url|storage provider/.test(normalized)
  ) {
    return '本地空间还没有完成准备。请回到空间选择页，再点一次“本地空间”。'
  }

  if (/invalid or expired provisioncode|invalid or expired providercode|provisioncode.*expired|providercode.*expired/.test(normalized)) {
    return '这次本地登录已失效。请回到空间选择页，重新点“本地空间”。'
  }

  if (/cloudflare tunnel|cloudflared|error 1033|tunnel/.test(normalized)) {
    return '这台电脑暂时无法从外网访问。你可以先在本机使用，或稍后重试。'
  }

  if (/service unavailable|http\s*503/.test(normalized)) {
    return '登录服务暂时不可用。请稍后重试。'
  }

  if (/oidc|openid-configuration|failed to fetch|networkerror|aborterror|无法连接服务器|连接超时/.test(normalized)) {
    return '登录页面暂时打不开。请检查网络，或回到“选择空间”重试。'
  }

  if (/api key|invalid key|missing key|incorrect api key|authentication.*key|invalid_api_key/.test(normalized)) {
    return '密钥不可用。请检查密钥是否填写正确，或换一个密钥后重试。'
  }

  if (/ai error|anthropic error|openai error|model error|模型服务/.test(normalized)) {
    return '模型服务暂时不可用。请检查密钥、服务地址或网络后重试。'
  }

  if (/(?:http|api error|runtime request failed|request failed)[:\s]*401\b|401 unauthorized|unauthorized|读取 webid profile 失败/.test(normalized)) {
    return '登录状态已失效。请重新登录。'
  }

  if (/(?:http|api error|runtime request failed|request failed)[:\s]*403\b|403 forbidden|forbidden|权限/.test(normalized)) {
    return '这个账号还不能写入当前空间。请换一个空间；如果这是你的本地空间，请先完成空间创建。'
  }

  if (/cannot obtain the parent|root container|failed to check pod container|failed to create pod container|pod container/.test(normalized)) {
    return '当前空间还没有创建完成。请回到空间选择页，重新进入后按提示创建。'
  }

  if (
    /selected sp pod url|current sp pod url|pod url was not applied|unable to resolve current pod url|cannot .* pod record|outside the current sp|pod 地址无效|pod 不属于当前选择的空间|当前空间没有声明可写入的 pod/.test(normalized)
  ) {
    return 'LinX 还不能把数据保存到当前空间。请换一个空间；如果这是本地空间，请先完成空间创建。'
  }

  if (/webid does not belong to this account|does not belong to this account/.test(normalized)) {
    return '账号和当前空间不匹配。请返回空间选择页，换账号或换空间。'
  }

  if (/pod init timed out|pod.*timed out/.test(normalized)) {
    return '空间准备超时。请检查网络，或返回空间选择页重试。'
  }

  if (
    /pod write failed|write failed|read failed|solid database is missing authenticated fetch|agent resource id must|agent home|ai secretary|secretary.*初始化失败|created ai secretary.*missing id|secretary chat row|secretary thread row/.test(normalized)
  ) {
    return 'LinX 还不能在当前空间保存数据。请返回空间选择页，换一个空间后重试。'
  }

  if (/pod creation endpoint not found/.test(normalized)) {
    return '当前空间暂时不能创建。请返回空间选择页，确认选择正确后再试。'
  }

  if (/(?:http|api error|runtime request failed|request failed)[:\s]*409\b|409 conflict|conflict|already exists|already registered/.test(normalized)) {
    return '这个账号或空间名已经存在。请直接登录，或换一个名字。'
  }

  if (/(?:http|api error|runtime request failed|request failed)[:\s]*400\b|400 bad request|badrequesthttperror|bad request/.test(normalized)) {
    return '提交的信息不完整或已过期。请回到上一步重新填写。'
  }

  if (/(?:http|api error|runtime request failed|request failed)[:\s]*404\b|404 not found|login page.*not found|authorization page.*not found|登录页.*不存在/.test(normalized)) {
    return '没有找到登录页面。请返回空间选择页重试。'
  }

  if (/(?:http|api error|runtime request failed|request failed)[:\s]*429\b|429 too many requests|rate limit|too many requests/.test(normalized)) {
    return '请求太频繁。请稍等一会儿再试。'
  }

  if (/(?:http|api error|runtime request failed|request failed)[:\s]*5\d\d\b|5\d\d internal|internal server error/.test(normalized)) {
    return '服务暂时没有响应。请稍后重试。'
  }

  if (/model list|models.*failed|模型列表获取失败/.test(normalized)) {
    return '模型列表获取失败。请检查密钥、服务地址或网络后重试。'
  }

  if (/no response body|empty response|response body.*missing/.test(normalized)) {
    return '服务没有返回内容。请检查密钥、服务地址或网络后重试。'
  }

  if (/invalid json request body|malformed json|invalid request body/.test(normalized)) {
    return '消息发送失败。请刷新页面后重试。'
  }

  if (/runtime thread is not active|runtime thread.*inactive|工作会话.*not active/.test(normalized)) {
    return '这个工作会话已经结束。请重新启动工作会话。'
  }

  if (
    /failed to (?:start|resume|subscribe).*runtime|runtime response failed|runtime stream ended without assistant output|runtime session not found/.test(normalized)
  ) {
    return '工作会话暂时没有响应。请重新启动工作会话后再试。'
  }

  if (/nodeid|linx 节点|local workspace|workspace uri|当前环境不支持本地 workspace/.test(normalized)) {
    return '本地工作区还没有配置完成。请在设置里检查本地空间后重试。'
  }

  if (/database not connected|solid database is not ready|database is not ready|数据库未就绪|not ready/.test(normalized)) {
    return 'LinX 还不能在当前空间保存数据。请稍后重试；如果仍失败，请换一个空间重新登录。'
  }

  if (
    /(?:chat|thread|message).*not found|no chat found|cannot find pod message|failed to resolve (?:chat|thread|message)|(?:chat|thread|message).*missing id|row is missing id/.test(normalized)
  ) {
    return '当前内容还没有准备好。请刷新页面后重试。'
  }

  if (/findbyid requires|base-relative|full iris/.test(normalized)) {
    return 'LinX 初始化失败。请刷新页面；如果仍失败，请换一个空间重新登录。'
  }

  if (/unable to install @undefineds\.co\/xpod|unable to prepare xpod runtime/.test(normalized)) {
    return '本地空间组件下载失败。请检查网络后重试。'
  }

  if (/unable to locate xpod|unable to determine exact @undefineds\.co\/xpod version/.test(normalized)) {
    return '本地空间启动文件损坏。请重启 LinX 让它自动修复；如果仍失败，请打开本地空间设置修复。'
  }

  if (/missing required local login\/startup capabilities|scoped webid|scoped pickwebid|scoped picker|escaped recursive css runtime/.test(normalized)) {
    return '本地空间版本过旧。请重启 LinX 让它自动更新；如果仍失败，请打开本地空间设置修复。'
  }

  if (/local 服务在完成启动前已退出|exceeded max restarts|failed to start xpod/.test(normalized)) {
    return '本地空间启动失败。请点“重新检查”；如果仍失败，请重启 LinX。'
  }

  if (/等待 local 服务就绪超时|local.*启动超时/.test(normalized)) {
    return '本地空间启动超时。请点“重新检查”；如果仍失败，请重启 LinX。'
  }

  if (/cannot find module|invalid resource iri|jsonld|componentsjs|application support|require stack/.test(normalized)) {
    return '本地空间启动文件损坏。请重启 LinX 让它自动修复；如果仍失败，请打开本地空间设置修复。'
  }

  if (/spawn bun enoent|本地运行环境|node\/npm|npm|bun/.test(normalized)) {
    return '本机缺少本地空间运行环境。请检查网络后重试，LinX 会自动安装需要的组件。'
  }

  if (/spacekind must|configuredspacekind|requestedspacekind/.test(normalized)) {
    return '当前页面和已启动的空间不一致。请回到空间选择页重新进入。'
  }

  if (/preview|读取预览失败|read resource|failed to fetch|network/.test(normalized)) {
    return '预览加载失败。请检查网络后重试，或直接打开文件。'
  }

  if (isInternalDiagnostic(message)) {
    return fallback
  }

  const productMessage = localizeProductTerms(message)
  if (isSafeUserMessage(productMessage)) {
    return productMessage
  }

  return fallback
}

export function createUserFacingError(error: unknown, fallback: string): Error {
  const userMessage = formatErrorForUser(error, fallback)
  return new Error(userMessage)
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  if (error && typeof error === 'object') {
    const maybeMessage = (error as { message?: unknown }).message
    if (typeof maybeMessage === 'string') {
      return maybeMessage
    }
  }

  return ''
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function isSafeUserMessage(message: string): boolean {
  if (message.length > 180) {
    return false
  }

  if (INTERNAL_ERROR_PATTERN.test(message) || STACK_OR_PATH_PATTERN.test(message) || RAW_ADDRESS_PATTERN.test(message)) {
    return false
  }

  return true
}

function isInternalDiagnostic(message: string): boolean {
  return INTERNAL_ERROR_PATTERN.test(message) || STACK_OR_PATH_PATTERN.test(message) || RAW_ADDRESS_PATTERN.test(message)
}

function localizeProductTerms(message: string): string {
  return message
    .replace(/Cloud-managed canonical URL/gi, '自动分配登录地址')
    .replace(/Cloud provisioning/gi, 'LinX')
    .replace(/\bCloud\s+账号/g, '云端账号')
    .replace(/\bCloud\s+身份/g, '云端账号')
    .replace(/\bCloud\b/g, '云端')
    .replace(/\bStandalone\b/g, '独立空间')
    .replace(/\bLocal\s+空间/g, '本地空间')
    .replace(/\bLocal\s+服务/g, '本地空间')
    .replace(/\bLocal\s+设置/g, '本地空间设置')
    .replace(/\bLocal\b/g, '本地空间')
    .replace(/\btunnel\b/gi, '隧道')
    .replace(/\bPod\b/g, '空间')
    .replace(/\bWebID\s+Profile\b/gi, '账号')
    .replace(/\bWebID\b/gi, '账号')
    .replace(/\bOIDC\b/gi, '登录')
    .replace(/\bxpod\b/gi, '本地空间')
    .replace(/([\u4e00-\u9fff])\s+(本地空间|独立空间|云端账号|云端|空间|账号|登录|隧道)/g, '$1$2')
    .replace(/(本地空间|独立空间|云端账号|云端|空间|账号|登录|隧道)\s+([\u4e00-\u9fff])/g, '$1$2')
}
