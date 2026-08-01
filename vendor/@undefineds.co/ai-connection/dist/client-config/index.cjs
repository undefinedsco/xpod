var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __toESM = (mod, isNodeMode, target) => {
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: () => mod[key],
        enumerable: true
      });
  return to;
};
var __moduleCache = /* @__PURE__ */ new WeakMap;
var __toCommonJS = (from) => {
  var entry = __moduleCache.get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function")
    __getOwnPropNames(from).map((key) => !__hasOwnProp.call(entry, key) && __defProp(entry, key, {
      get: () => from[key],
      enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
    }));
  __moduleCache.set(from, entry);
  return entry;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: (newValue) => all[name] = () => newValue
    });
};

// src/client-config/index.ts
var exports_client_config = {};
__export(exports_client_config, {
  stripLegacyXpodObject: () => stripLegacyXpodObject,
  stringifyJson: () => stringifyJson,
  parseJsonObject: () => parseJsonObject,
  normalizeV1Endpoint: () => normalizeV1Endpoint,
  normalizeMessagesEndpoint: () => normalizeMessagesEndpoint,
  looksLikePreviousXpodValue: () => looksLikePreviousXpodValue,
  hashWebId: () => hashWebId,
  PiConfigAdapter: () => PiConfigAdapter,
  CodexConfigAdapter: () => CodexConfigAdapter,
  CodeBuddyConfigAdapter: () => CodeBuddyConfigAdapter,
  ClaudeCodeConfigAdapter: () => ClaudeCodeConfigAdapter,
  BaseAiClientConfigAdapter: () => BaseAiClientConfigAdapter,
  AiClientConfigTransaction: () => AiClientConfigTransaction
});
module.exports = __toCommonJS(exports_client_config);

// src/client-config/base-adapter.ts
var crypto2 = __toESM(require("node:crypto"));
var fs2 = __toESM(require("node:fs"));
var path2 = __toESM(require("node:path"));

// src/client-config/transaction.ts
var crypto = __toESM(require("node:crypto"));
var fs = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));

class AiClientConfigTransaction {
  rename;
  constructor(dependencies = {}) {
    this.rename = dependencies.rename ?? fs.promises.rename;
  }
  async apply(writes) {
    const uniquePaths = new Set(writes.map((write) => path.resolve(write.path)));
    if (uniquePaths.size !== writes.length) {
      throw new Error("AI client configuration transaction contains duplicate paths");
    }
    for (const write of writes) {
      await this.preparePath(write.path);
      if (write.backupPath) {
        await this.preparePath(write.backupPath);
      }
    }
    const snapshots = await Promise.all(writes.map((write) => this.snapshot(write.path)));
    const staged = new Map;
    try {
      for (const write of writes) {
        const snapshot = snapshots.find((candidate) => candidate.path === write.path);
        if (write.createBackup && write.backupPath && snapshot.existed) {
          if (await this.exists(write.backupPath)) {
            throw new Error(`AI client configuration backup already exists: ${write.backupPath}`);
          }
          await this.writeNewFile(write.backupPath, snapshot.content, snapshot.mode ?? 384);
        }
        if (write.content !== null) {
          staged.set(write.path, await this.stage(write.path, write.content));
        }
      }
      for (const write of writes) {
        if (write.content === null) {
          await fs.promises.rm(write.path, { force: true });
        } else {
          await this.rename(staged.get(write.path), write.path);
          await fs.promises.chmod(write.path, 384);
          await this.syncDirectory(path.dirname(write.path));
        }
      }
    } catch (error) {
      await this.rollback(snapshots);
      throw error;
    } finally {
      await Promise.all([...staged.values()].map((tempPath) => fs.promises.rm(tempPath, { force: true }).catch(() => {
        return;
      })));
    }
  }
  async preparePath(filePath) {
    const directory = path.dirname(filePath);
    await fs.promises.mkdir(directory, { recursive: true, mode: 448 });
    await this.rejectSymlink(directory, true);
    await this.rejectSymlink(filePath);
  }
  async rejectSymlink(filePath, allowDirectory = false) {
    try {
      const stats = await fs.promises.lstat(filePath);
      if (stats.isSymbolicLink()) {
        throw new Error(`Refusing to configure symbolic link: ${filePath}`);
      }
      if (!allowDirectory && stats.isDirectory()) {
        throw new Error(`Refusing to replace directory with AI client configuration: ${filePath}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  async snapshot(filePath) {
    try {
      const stats = await fs.promises.lstat(filePath);
      if (!stats.isFile()) {
        throw new Error(`AI client configuration is not a regular file: ${filePath}`);
      }
      return {
        path: filePath,
        existed: true,
        content: await fs.promises.readFile(filePath),
        mode: stats.mode & 511
      };
    } catch (error) {
      if (error.code === "ENOENT") {
        return { path: filePath, existed: false };
      }
      throw error;
    }
  }
  async stage(targetPath, content) {
    const tempPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.xpod-tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
    await this.writeNewFile(tempPath, Buffer.from(content, "utf8"), 384);
    return tempPath;
  }
  async writeNewFile(filePath, content, mode) {
    const handle = await fs.promises.open(filePath, "wx", mode);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.chmod(filePath, 384);
    await this.syncDirectory(path.dirname(filePath));
  }
  async rollback(snapshots) {
    for (const snapshot of [...snapshots].reverse()) {
      try {
        if (!snapshot.existed) {
          await fs.promises.rm(snapshot.path, { force: true });
          continue;
        }
        const tempPath = await this.stage(snapshot.path, snapshot.content.toString("utf8"));
        await this.rename(tempPath, snapshot.path);
        await fs.promises.chmod(snapshot.path, snapshot.mode ?? 384);
        await this.syncDirectory(path.dirname(snapshot.path));
      } catch {}
    }
  }
  async syncDirectory(directory) {
    let handle;
    try {
      handle = await fs.promises.open(directory, "r");
      await handle.sync();
    } catch (error) {
      if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error.code ?? "")) {
        throw error;
      }
    } finally {
      await handle?.close();
    }
  }
  async exists(filePath) {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

// src/client-config/base-adapter.ts
function hashWebId(webId) {
  return crypto2.createHash("sha256").update(webId.trim(), "utf8").digest("hex");
}
function normalizeV1Endpoint(endpoint) {
  const normalized = endpoint.trim().replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}
function normalizeMessagesEndpoint(endpoint) {
  return endpoint.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}
function parseJsonObject(content, label) {
  if (!content?.trim())
    return {};
  let value;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`Cannot configure ${label}: invalid JSON (${String(error)})`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Cannot configure ${label}: root must be a JSON object`);
  }
  return value;
}
function stringifyJson(value) {
  return `${JSON.stringify(value, null, 2)}
`;
}
function looksLikePreviousXpodValue(value) {
  return typeof value === "string" && (value.includes("xpod") || value.includes("/api/ai") || value.includes("xpod."));
}
function stripLegacyXpodObject(value) {
  const legacy = value.xpod;
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    delete value.xpod;
  }
}

class BaseAiClientConfigAdapter {
  client;
  executable;
  configPaths;
  transaction;
  statePath;
  constructor(client, executable, configPaths, stateDirectory, transaction = new AiClientConfigTransaction) {
    this.client = client;
    this.executable = executable;
    this.configPaths = configPaths;
    this.transaction = transaction;
    this.statePath = path2.join(stateDirectory, `.xpod-ai-connection-${client}.json`);
  }
  async detect() {
    return {
      installed: await this.isExecutableOnPath(),
      configExists: (await Promise.all(this.configPaths.map((filePath) => this.exists(filePath)))).some(Boolean),
      configPaths: [...this.configPaths]
    };
  }
  async inspect() {
    const state = await this.readState();
    return {
      ownership: state ? "owned" : "unowned",
      ...state ? { webIdHash: state.webIdHash } : {},
      configPaths: [...this.configPaths]
    };
  }
  async plan(profile) {
    this.validateProfile(profile);
    const ownerHash = hashWebId(profile.webId);
    const currentState = await this.readState();
    if (currentState && currentState.webIdHash !== ownerHash) {
      throw new Error(`${this.client} AI Connection projection is owned by another WebID`);
    }
    const contents = new Map;
    for (const filePath of this.configPaths) {
      await this.rejectSymlink(filePath);
      contents.set(filePath, await this.readOptional(filePath));
    }
    const projected = await this.project(profile, contents);
    const timestamp = Date.now();
    const files = this.configPaths.map((filePath) => {
      const prior = currentState?.files.find((file) => file.path === filePath);
      const existed = contents.get(filePath) !== undefined;
      return prior ?? {
        path: filePath,
        existed,
        ...existed ? { backupPath: `${filePath}.xpod-backup-${timestamp}` } : {}
      };
    });
    const writes = [...projected.entries()].map(([filePath, content]) => ({
      path: filePath,
      content,
      backupPath: files.find((file) => file.path === filePath)?.backupPath,
      createBackup: !currentState && contents.get(filePath) !== undefined
    }));
    const state = {
      version: 1,
      client: this.client,
      webIdHash: ownerHash,
      files
    };
    writes.push({ path: this.statePath, content: stringifyJson(state) });
    return { client: this.client, webIdHash: ownerHash, writes };
  }
  async apply(plan) {
    if (plan.client !== this.client) {
      throw new Error(`Cannot apply ${plan.client} plan with ${this.client} adapter`);
    }
    await this.transaction.apply(plan.writes);
  }
  async verify(profile) {
    const state = await this.readState();
    if (!state || state.webIdHash !== hashWebId(profile.webId)) {
      return { ok: false, reason: "AI Connection ownership does not match the current WebID" };
    }
    return this.verifyProjection(profile);
  }
  async restore(webId) {
    const state = await this.readState();
    if (!state)
      return;
    if (state.webIdHash !== hashWebId(webId)) {
      throw new Error(`${this.client} AI Connection projection is owned by another WebID`);
    }
    const writes = [];
    for (const file of state.files) {
      await this.rejectSymlink(file.path);
      const current = await this.readOptional(file.path);
      let original;
      if (file.existed) {
        if (!file.backupPath) {
          throw new Error(`Missing ${this.client} backup metadata for ${file.path}`);
        }
        await this.rejectSymlink(file.backupPath);
        original = await this.readOptional(file.backupPath);
        if (original === undefined) {
          throw new Error(`Missing ${this.client} backup at ${file.backupPath}`);
        }
      }
      writes.push({
        path: file.path,
        content: await this.restoreFile(file.path, current, original, file.existed)
      });
    }
    writes.push({ path: this.statePath, content: null });
    await this.transaction.apply(writes);
  }
  async readOptional(filePath) {
    try {
      return await fs2.promises.readFile(filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT")
        return;
      throw error;
    }
  }
  validateProfile(profile) {
    if (!profile.endpoint.trim())
      throw new Error("AI Connection endpoint is required");
    if (!profile.gatewayKey.trim())
      throw new Error("AI Connection Gateway key is required");
    if (!profile.webId.trim())
      throw new Error("Current WebID is required");
  }
  async readState() {
    await this.rejectSymlink(this.statePath);
    const content = await this.readOptional(this.statePath);
    if (!content)
      return;
    const parsed = parseJsonObject(content, `${this.client} ownership state`);
    if (parsed.version !== 1 || parsed.client !== this.client || typeof parsed.webIdHash !== "string" || !Array.isArray(parsed.files)) {
      throw new Error(`Invalid ${this.client} AI Connection ownership state`);
    }
    return parsed;
  }
  async rejectSymlink(filePath) {
    try {
      if ((await fs2.promises.lstat(filePath)).isSymbolicLink()) {
        throw new Error(`Refusing to configure symbolic link: ${filePath}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT")
        throw error;
    }
  }
  async exists(filePath) {
    try {
      return (await fs2.promises.lstat(filePath)).isFile();
    } catch (error) {
      if (error.code === "ENOENT")
        return false;
      throw error;
    }
  }
  async isExecutableOnPath() {
    const pathValue = process.env.PATH ?? "";
    for (const directory of pathValue.split(path2.delimiter).filter(Boolean)) {
      try {
        await fs2.promises.access(path2.join(directory, this.executable), fs2.constants.X_OK);
        return true;
      } catch {}
    }
    return false;
  }
}
// src/client-config/codex.ts
var fs3 = __toESM(require("node:fs"));
var os = __toESM(require("node:os"));
var path3 = __toESM(require("node:path"));
var START = "# >>> xpod-ai-connection managed";
var END = "# <<< xpod-ai-connection managed";

class CodexConfigAdapter extends BaseAiClientConfigAdapter {
  configPath;
  authPath;
  constructor(options = {}) {
    const codexHome = path3.join(options.homeDir ?? os.homedir(), ".codex");
    const configPath = path3.join(codexHome, "config.toml");
    const authPath = path3.join(codexHome, "auth.json");
    super("codex", "codex", [configPath, authPath], codexHome);
    this.configPath = configPath;
    this.authPath = authPath;
  }
  async project(profile, current) {
    const config = this.removeManagedBlock(current.get(this.configPath) ?? "").split(`
`).filter((line) => !/^\s*model_provider\s*=/.test(line)).join(`
`).trimEnd();
    const model = profile.model?.trim();
    const block = [
      START,
      'model_provider = "xpod"',
      ...model ? [`model = ${JSON.stringify(model)}`] : [],
      "",
      "[model_providers.xpod]",
      'name = "Xpod AI Connection"',
      `base_url = ${JSON.stringify(normalizeV1Endpoint(profile.endpoint))}`,
      'wire_api = "responses"',
      "requires_openai_auth = true",
      END,
      ""
    ].join(`
`);
    const auth = parseJsonObject(current.get(this.authPath), "Codex auth.json");
    auth.OPENAI_API_KEY = profile.gatewayKey;
    return new Map([
      [this.configPath, `${config}${config ? `

` : ""}${block}`],
      [this.authPath, stringifyJson(auth)]
    ]);
  }
  async verifyProjection(profile) {
    try {
      const config = await fs3.promises.readFile(this.configPath, "utf8");
      const auth = parseJsonObject(await fs3.promises.readFile(this.authPath, "utf8"), "Codex auth.json");
      const ok = config.includes('model_provider = "xpod"') && config.includes(`base_url = ${JSON.stringify(normalizeV1Endpoint(profile.endpoint))}`) && auth.OPENAI_API_KEY === profile.gatewayKey;
      return ok ? { ok: true } : { ok: false, reason: "Codex projection differs from the requested connection" };
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
  }
  async restoreFile(filePath, current, original, originallyExisted) {
    if (filePath === this.authPath) {
      const restored2 = parseJsonObject(current, "Codex auth.json");
      const before = parseJsonObject(original, "Codex original auth.json");
      if (Object.prototype.hasOwnProperty.call(before, "OPENAI_API_KEY") && !looksLikePreviousXpodValue(before.OPENAI_API_KEY)) {
        restored2.OPENAI_API_KEY = before.OPENAI_API_KEY;
      } else {
        delete restored2.OPENAI_API_KEY;
      }
      return !originallyExisted && Object.keys(restored2).length === 0 ? null : stringifyJson(restored2);
    }
    let restored = this.removeManagedBlock(current ?? "").trim();
    const hasCurrentProvider = restored.split(`
`).some((line) => /^\s*model_provider\s*=/.test(line));
    if (!hasCurrentProvider) {
      const originalProviders = (original ?? "").split(`
`).filter((line) => /^\s*model_provider\s*=/.test(line) && !line.includes("xpod"));
      if (originalProviders.length > 0) {
        restored = `${originalProviders.join(`
`)}${restored ? `
${restored}` : ""}`;
      }
    }
    return !originallyExisted && !restored ? null : `${restored}${restored ? `
` : ""}`;
  }
  removeManagedBlock(content) {
    const start = content.indexOf(START);
    if (start < 0)
      return content;
    const end = content.indexOf(END, start);
    if (end < 0)
      throw new Error("Codex xpod managed block is incomplete");
    return `${content.slice(0, start)}${content.slice(end + END.length)}`;
  }
}
// src/client-config/json-env-adapter.ts
var fs4 = __toESM(require("node:fs"));
var os2 = __toESM(require("node:os"));
var path4 = __toESM(require("node:path"));
class JsonEnvAdapter extends BaseAiClientConfigAdapter {
  envProjection;
  settingsPath;
  constructor(client, settingsPath, envProjection) {
    super(client, client === "claude-code" ? "claude" : "codebuddy", [settingsPath], path4.dirname(settingsPath));
    this.envProjection = envProjection;
    this.settingsPath = settingsPath;
  }
  async project(profile, current) {
    const settings = parseJsonObject(current.get(this.settingsPath), `${this.client} settings.json`);
    const env = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env) ? { ...settings.env } : {};
    Object.assign(env, this.envProjection(profile));
    settings.env = env;
    return new Map([[this.settingsPath, stringifyJson(settings)]]);
  }
  async verifyProjection(profile) {
    try {
      const settings = parseJsonObject(await fs4.promises.readFile(this.settingsPath, "utf8"), `${this.client} settings.json`);
      const env = settings.env;
      const expected = this.envProjection(profile);
      const ok = env !== undefined && Object.entries(expected).every(([key, value]) => env[key] === value);
      return ok ? { ok: true } : {
        ok: false,
        reason: `${this.client} projection differs from the requested connection`
      };
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
  }
  async restoreFile(_filePath, current, original, originallyExisted) {
    const restored = parseJsonObject(current, `${this.client} settings.json`);
    const before = parseJsonObject(original, `${this.client} original settings.json`);
    stripLegacyXpodObject(restored);
    const restoredEnv = isObject(restored.env) ? { ...restored.env } : {};
    const beforeEnv = isObject(before.env) ? before.env : {};
    for (const key of Object.keys(this.envProjection({
      endpoint: "https://owned.invalid",
      gatewayKey: "owned",
      webId: "https://owned.invalid/profile#me"
    }))) {
      if (Object.prototype.hasOwnProperty.call(beforeEnv, key) && !looksLikePreviousXpodValue(beforeEnv[key])) {
        restoredEnv[key] = beforeEnv[key];
      } else {
        delete restoredEnv[key];
      }
    }
    if (Object.keys(restoredEnv).length > 0 || Object.prototype.hasOwnProperty.call(before, "env")) {
      restored.env = restoredEnv;
    } else {
      delete restored.env;
    }
    return !originallyExisted && Object.keys(restored).length === 0 ? null : stringifyJson(restored);
  }
}
function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

class ClaudeCodeConfigAdapter extends JsonEnvAdapter {
  constructor(options = {}) {
    const settingsPath = path4.join(options.homeDir ?? os2.homedir(), ".claude", "settings.json");
    super("claude-code", settingsPath, (profile) => ({
      ANTHROPIC_BASE_URL: normalizeMessagesEndpoint(profile.endpoint),
      ANTHROPIC_AUTH_TOKEN: profile.gatewayKey
    }));
  }
}

class CodeBuddyConfigAdapter extends JsonEnvAdapter {
  constructor(options = {}) {
    const settingsPath = path4.join(options.homeDir ?? os2.homedir(), ".codebuddy", "settings.json");
    super("codebuddy", settingsPath, (profile) => ({
      CODEBUDDY_BASE_URL: normalizeV1Endpoint(profile.endpoint),
      CODEBUDDY_API_KEY: profile.gatewayKey
    }));
  }
}
// src/client-config/pi.ts
var fs5 = __toESM(require("node:fs"));
var os3 = __toESM(require("node:os"));
var path5 = __toESM(require("node:path"));
class PiConfigAdapter extends BaseAiClientConfigAdapter {
  settingsPath;
  modelsPath;
  constructor(options = {}) {
    const dir = path5.join(options.homeDir ?? os3.homedir(), ".pi", "agent");
    const settingsPath = path5.join(dir, "settings.json");
    const modelsPath = path5.join(dir, "models.json");
    super("pi", "pi", [settingsPath, modelsPath], dir);
    this.settingsPath = settingsPath;
    this.modelsPath = modelsPath;
  }
  async project(profile, current) {
    const settings = parseJsonObject(current.get(this.settingsPath), "Pi settings.json");
    const models = parseJsonObject(current.get(this.modelsPath), "Pi models.json");
    const providers = models.providers && typeof models.providers === "object" && !Array.isArray(models.providers) ? { ...models.providers } : {};
    const model = profile.model?.trim() || "default";
    settings.defaultProvider = "xpod";
    settings.defaultModel = model;
    providers.xpod = {
      baseUrl: normalizeV1Endpoint(profile.endpoint),
      apiKey: profile.gatewayKey,
      authHeader: true,
      api: "openai-responses",
      models: [{ id: model, name: model }]
    };
    models.providers = providers;
    return new Map([
      [this.settingsPath, stringifyJson(settings)],
      [this.modelsPath, stringifyJson(models)]
    ]);
  }
  async verifyProjection(profile) {
    try {
      const models = parseJsonObject(await fs5.promises.readFile(this.modelsPath, "utf8"), "Pi models.json");
      const xpod = models.providers?.xpod;
      const ok = xpod?.baseUrl === normalizeV1Endpoint(profile.endpoint) && xpod.apiKey === profile.gatewayKey;
      return ok ? { ok: true } : { ok: false, reason: "Pi projection differs from the requested connection" };
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
  }
  async restoreFile(filePath, current, original, originallyExisted) {
    const restored = parseJsonObject(current, `Pi ${path5.basename(filePath)}`);
    const before = parseJsonObject(original, `Pi original ${path5.basename(filePath)}`);
    stripLegacyXpodObject(restored);
    if (filePath === this.settingsPath) {
      restoreOwnedProperty(restored, before, "defaultProvider");
      restoreOwnedProperty(restored, before, "defaultModel");
    } else {
      const restoredProviders = isObject2(restored.providers) ? { ...restored.providers } : {};
      const beforeProviders = isObject2(before.providers) ? before.providers : {};
      restoreOwnedProperty(restoredProviders, beforeProviders, "xpod");
      if (Object.keys(restoredProviders).length > 0 || Object.prototype.hasOwnProperty.call(before, "providers")) {
        restored.providers = restoredProviders;
      } else {
        delete restored.providers;
      }
    }
    return !originallyExisted && Object.keys(restored).length === 0 ? null : stringifyJson(restored);
  }
}
function restoreOwnedProperty(target, original, key) {
  if (key === "xpod" || looksLikePreviousXpodValue(original[key])) {
    delete target[key];
  } else if (Object.prototype.hasOwnProperty.call(original, key)) {
    target[key] = original[key];
  } else {
    delete target[key];
  }
}
function isObject2(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
