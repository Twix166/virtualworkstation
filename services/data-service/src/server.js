const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const port = Number(process.env.PORT || 8083);
const dataFilePath = process.env.DATA_FILE_PATH || "/tmp/virtualworkstation-db.json";
const dataEncryptionSecret =
  process.env.DATA_ENCRYPTION_SECRET ||
  process.env.AUTH_TOKEN_SECRET ||
  "virtualworkstation-dev-secret";

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function ensureDatabase() {
  const directory = path.dirname(dataFilePath);
  fs.mkdirSync(directory, { recursive: true });

  if (!fs.existsSync(dataFilePath)) {
    const seedUserId = crypto.randomUUID();
    const database = {
      users: [
        {
          id: seedUserId,
          username: "demo",
          passwordHash: crypto.createHash("sha256").update("demo").digest("hex"),
          profile: {
            displayName: "Demo User",
            createdAt: new Date().toISOString(),
            preferences: {
              defaultDesktopEnvironment: "xfce",
            },
          },
        },
      ],
      platform: {
        providers: defaultProviders(),
        events: [],
        providerAssets: [],
        imageProfiles: [],
        sshHosts: [],
        sshCredentials: [],
        sshProfiles: [],
      },
      sessions: [],
    };
    fs.writeFileSync(dataFilePath, JSON.stringify(database, null, 2));
  }
}

function defaultProviders() {
  return [
    {
      id: "ssh-host-provider",
      name: "Managed SSH Hosts",
      kind: "ssh-host",
      driver: "ssh",
      enabled: false,
      default: false,
      scope: "remote",
      description: "Open browser-based SSH terminal sessions to approved network hosts.",
      capabilities: {
        machineTypes: ["ssh-host"],
        supportsImages: false,
        supportsImageBuilder: false,
        supportsVirtualMachines: false,
        supportsSuspend: false,
        supportsSshTerminal: true,
      },
      config: {
        idleTimeoutMinutes: 30,
        allowArbitraryHosts: false,
      },
    },
    {
      id: "docker-local",
      name: "Local Docker Engine",
      kind: "container",
      driver: "docker",
      enabled: true,
      default: true,
      scope: "local",
      description: "Launch Docker-backed workstations on this host.",
      capabilities: {
        machineTypes: ["container"],
        supportsImages: true,
        supportsImageBuilder: true,
        supportsVirtualMachines: false,
        supportsSuspend: false,
        assetTypes: ["registry-image", "docker-build-recipe"],
        builderTabs: ["assets", "profiles", "tests"],
      },
      config: {
        dockerHost: "unix:///var/run/docker.sock",
        publishMode: "localhost",
      },
    },
    {
      id: "libvirt-local",
      name: "Local KVM / libvirt",
      kind: "virtual-machine",
      driver: "libvirt",
      enabled: false,
      default: false,
      scope: "local",
      description: "Provision KVM virtual machines through a local libvirt host.",
      capabilities: {
        machineTypes: ["virtual-machine"],
        supportsImages: false,
        supportsImageBuilder: true,
        supportsVirtualMachines: true,
        supportsSuspend: true,
        assetTypes: ["disk-image", "installer-iso", "template"],
        builderTabs: ["assets", "profiles", "tests"],
      },
      config: {
        uri: "qemu:///system",
        storagePool: "default",
        network: "default",
      },
    },
    {
      id: "proxmox-primary",
      name: "Proxmox VE",
      kind: "virtual-machine",
      driver: "proxmox",
      enabled: false,
      default: false,
      scope: "remote",
      description: "Provision KVM virtual machines on a Proxmox VE cluster.",
      capabilities: {
        machineTypes: ["virtual-machine"],
        supportsImages: false,
        supportsImageBuilder: true,
        supportsVirtualMachines: true,
        supportsSuspend: true,
        supportsIsoAssets: true,
        supportsUnattendedInstall: true,
        supportsBuildTests: true,
        assetTypes: ["installer-iso"],
        builderTabs: ["assets", "profiles", "tests"],
      },
      config: {
        apiUrl: "",
        node: "",
        buildStrategy: "iso-unattended",
        templateVmid: "",
        storage: "",
        isoStorage: "",
        snippetStorage: "",
        networkBridge: "vmbr0",
        validateTls: true,
        tokenId: "",
        tokenSecret: "",
        vmUsername: "",
        vmPassword: "",
        timezone: "Europe/London",
        keyboardLayout: "gb",
        locale: "en_GB.UTF-8",
        isoUrl: "",
        installerIsoVolid: "",
        installerIsoPattern: "ubuntu-24.04",
        seedBaseUrl: "",
        vmConsoleBaseUrl: "",
      },
    },
  ];
}

function readDatabase() {
  ensureDatabase();
  return JSON.parse(fs.readFileSync(dataFilePath, "utf8"));
}

function writeDatabase(database) {
  fs.writeFileSync(dataFilePath, JSON.stringify(database, null, 2));
}

function encryptionKey() {
  return crypto.createHash("sha256").update(dataEncryptionSecret).digest();
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);

  return {
    privateKeyCiphertext: ciphertext.toString("base64"),
    privateKeyIv: iv.toString("base64"),
    privateKeyTag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptSecret(record) {
  if (!record?.privateKeyCiphertext || !record?.privateKeyIv || !record?.privateKeyTag) {
    return record?.privateKey || "";
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(record.privateKeyIv, "base64")
  );
  decipher.setAuthTag(Buffer.from(record.privateKeyTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.privateKeyCiphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function hasPrivateKey(record) {
  return Boolean(record?.privateKey || record?.privateKeyCiphertext);
}

function sanitizeUser(user) {
  return {
    id: user.id,
    username: user.username,
    profile: user.profile,
  };
}

function ensurePlatformShape(database) {
  if (!database.platform) {
    database.platform = {
      providers: [],
      events: [],
      providerAssets: [],
      imageProfiles: [],
      sshHosts: [],
      sshCredentials: [],
      sshProfiles: [],
    };
  }

  if (!Array.isArray(database.platform.providers)) {
    database.platform.providers = [];
  }

  if (!Array.isArray(database.platform.events)) {
    database.platform.events = [];
  }

  if (!Array.isArray(database.platform.providerAssets)) {
    database.platform.providerAssets = [];
  }

  if (!Array.isArray(database.platform.imageProfiles)) {
    database.platform.imageProfiles = [];
  }

  if (!Array.isArray(database.platform.sshHosts)) {
    database.platform.sshHosts = [];
  }

  if (!Array.isArray(database.platform.sshCredentials)) {
    database.platform.sshCredentials = [];
  }

  if (!Array.isArray(database.platform.sshProfiles)) {
    database.platform.sshProfiles = [];
  }

  if (database.platform.providers.length === 0) {
    database.platform.providers = defaultProviders();
    return;
  }

  const defaultsById = new Map(defaultProviders().map((entry) => [entry.id, entry]));
  database.platform.providers = database.platform.providers.map((provider) => {
    const defaultProvider = defaultsById.get(provider.id);

    if (!defaultProvider) {
      return provider;
    }

    return {
      ...defaultProvider,
      ...provider,
      capabilities: {
        ...(defaultProvider.capabilities || {}),
        ...(provider.capabilities || {}),
      },
      config: {
        ...(defaultProvider.config || {}),
        ...(provider.config || {}),
      },
    };
  });

  for (const defaultProvider of defaultProviders()) {
    if (!database.platform.providers.find((entry) => entry.id === defaultProvider.id)) {
      database.platform.providers.push(defaultProvider);
    }
  }
}

function appendPlatformEvent(database, event) {
  ensurePlatformShape(database);
  database.platform.events.unshift({
    id: crypto.randomUUID(),
    level: event.level || "info",
    code: event.code || "platform.event",
    message: event.message || "",
    scope: event.scope || "platform",
    resourceId: event.resourceId || null,
    resourceType: event.resourceType || null,
    metadata: event.metadata || null,
    createdAt: new Date().toISOString(),
  });
  database.platform.events = database.platform.events.slice(0, 500);
}

function sanitizeProvider(provider) {
  const config = { ...(provider.config || {}) };

  if ("tokenSecret" in config) {
    config.tokenSecret = "";
    config.hasTokenSecret = Boolean(provider.config?.tokenSecret);
  }

  if ("vmPassword" in config) {
    config.vmPassword = "";
    config.hasVmPassword = Boolean(provider.config?.vmPassword);
  }

  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    driver: provider.driver,
    enabled: Boolean(provider.enabled),
    default: Boolean(provider.default),
    scope: provider.scope || "local",
    description: provider.description || "",
    capabilities: provider.capabilities || {},
    config,
  };
}

function sanitizeProviderAsset(asset) {
  return {
    id: asset.id,
    providerId: asset.providerId,
    assetType: asset.assetType,
    name: asset.name,
    state: asset.state || "ready",
    source: asset.source || null,
    detected: asset.detected || null,
    metadata: asset.metadata || null,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}

function sanitizeSshHost(host) {
  return {
    id: host.id,
    name: host.name,
    hostname: host.hostname,
    port: Number(host.port || 22),
    enabled: host.enabled !== false,
    tags: Array.isArray(host.tags) ? host.tags : [],
    createdAt: host.createdAt,
    updatedAt: host.updatedAt,
  };
}

function sanitizeSshCredential(credential) {
  return {
    id: credential.id,
    name: credential.name,
    username: credential.username,
    authType: credential.authType || "private-key",
    hasPrivateKey: hasPrivateKey(credential),
    hasPassphrase: Boolean(credential.passphrase),
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
  };
}

function sanitizeSshProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description || "",
    hostId: profile.hostId,
    credentialId: profile.credentialId,
    shell: profile.shell || "",
    enabled: profile.enabled !== false,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function sanitizeSshProfileForLaunch(profile, database) {
  const host = database.platform.sshHosts.find((entry) => entry.id === profile.hostId);
  const credential = database.platform.sshCredentials.find(
    (entry) => entry.id === profile.credentialId
  );

  return {
    ...sanitizeSshProfile(profile),
    host: host ? sanitizeSshHost(host) : null,
    credential: credential ? sanitizeSshCredential(credential) : null,
  };
}

function findProviderAssetIndex(database, assetId) {
  ensurePlatformShape(database);
  return database.platform.providerAssets.findIndex((entry) => entry.id === assetId);
}

function findProviderAssetByVolid(database, providerId, volid) {
  ensurePlatformShape(database);
  return database.platform.providerAssets.find(
    (entry) =>
      entry.providerId === providerId &&
      entry.source &&
      String(entry.source.volid || "") === String(volid || "")
  );
}

function findSession(database, sessionId) {
  return database.sessions.find((session) => session.id === sessionId);
}

function findSessionIndex(database, sessionId) {
  return database.sessions.findIndex((session) => session.id === sessionId);
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    json(res, 400, { error: "Invalid request" });
    return;
  }

  const requestUrl = new URL(req.url, "http://data-service.local");

  if (req.method === "GET" && req.url === "/health") {
    json(res, 200, { service: "data-service", status: "ok" });
    return;
  }

  if (req.method === "POST" && req.url === "/v1/users") {
    const body = await readRequestBody(req);
    const request = body ? JSON.parse(body) : {};

    if (!request.username || !request.password || !request.displayName) {
      json(res, 400, {
        error: "username, password, and displayName are required",
      });
      return;
    }

    const database = readDatabase();
    const existingUser = database.users.find(
      (user) => user.username.toLowerCase() === request.username.toLowerCase()
    );

    if (existingUser) {
      json(res, 409, { error: "Username already exists" });
      return;
    }

    const user = {
      id: crypto.randomUUID(),
      username: request.username,
      passwordHash: crypto.createHash("sha256").update(request.password).digest("hex"),
      profile: {
        displayName: request.displayName,
        createdAt: new Date().toISOString(),
        preferences: {
          defaultDesktopEnvironment: request.defaultDesktopEnvironment || "xfce",
        },
      },
    };

    database.users.push(user);
    writeDatabase(database);
    json(res, 201, { user: sanitizeUser(user) });
    return;
  }

  if (req.method === "POST" && req.url === "/v1/users/lookup") {
    const body = await readRequestBody(req);
    const request = body ? JSON.parse(body) : {};
    const database = readDatabase();
    const user = database.users.find(
      (entry) => entry.username.toLowerCase() === String(request.username || "").toLowerCase()
    );

    if (!user) {
      json(res, 404, { error: "User not found" });
      return;
    }

    json(res, 200, { user });
    return;
  }

  if (req.method === "GET" && req.url === "/v1/platform/providers") {
    const database = readDatabase();
    ensurePlatformShape(database);
    json(res, 200, {
      providers: database.platform.providers.map(sanitizeProvider),
    });
    return;
  }

  if (req.method === "GET" && req.url === "/v1/platform/providers/internal") {
    const database = readDatabase();
    ensurePlatformShape(database);
    json(res, 200, {
      providers: database.platform.providers,
    });
    return;
  }

  if (req.method === "GET" && req.url === "/v1/platform/events") {
    const database = readDatabase();
    ensurePlatformShape(database);
    json(res, 200, {
      events: database.platform.events.slice(),
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/v1/platform/provider-assets") {
    const database = readDatabase();
    ensurePlatformShape(database);
    const providerId = String(requestUrl.searchParams.get("providerId") || "").trim();
    const assetType = String(requestUrl.searchParams.get("assetType") || "").trim();
    let assets = database.platform.providerAssets.slice();

    if (providerId) {
      assets = assets.filter((entry) => entry.providerId === providerId);
    }

    if (assetType) {
      assets = assets.filter((entry) => entry.assetType === assetType);
    }

    assets.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));

    json(res, 200, {
      providerAssets: assets.map(sanitizeProviderAsset),
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/v1/platform/provider-assets/upsert") {
    const body = await readRequestBody(req);
    const request = body ? JSON.parse(body) : {};
    const database = readDatabase();
    ensurePlatformShape(database);

    if (!String(request.providerId || "").trim()) {
      json(res, 400, { error: "providerId is required" });
      return;
    }

    if (!String(request.assetType || "").trim()) {
      json(res, 400, { error: "assetType is required" });
      return;
    }

    const source = request.source && typeof request.source === "object" ? request.source : {};
    const existingById =
      request.id && findProviderAssetIndex(database, String(request.id).trim()) !== -1
        ? database.platform.providerAssets[findProviderAssetIndex(database, String(request.id).trim())]
        : null;
    const existingByVolid =
      source.volid
        ? findProviderAssetByVolid(database, String(request.providerId).trim(), String(source.volid).trim())
        : null;
    const existing = existingById || existingByVolid;

    if (existing) {
      existing.name = String(request.name || existing.name || "").trim();
      existing.assetType = String(request.assetType || existing.assetType || "").trim();
      existing.state = String(request.state || existing.state || "ready").trim();
      existing.providerId = String(request.providerId || existing.providerId || "").trim();
      existing.source = {
        ...(existing.source || {}),
        ...source,
      };
      existing.detected = request.detected && typeof request.detected === "object"
        ? {
            ...(existing.detected || {}),
            ...request.detected,
          }
        : existing.detected || null;
      existing.metadata = request.metadata && typeof request.metadata === "object"
        ? {
            ...(existing.metadata || {}),
            ...request.metadata,
          }
        : existing.metadata || null;
      existing.updatedAt = new Date().toISOString();
      writeDatabase(database);
      json(res, 200, { providerAsset: sanitizeProviderAsset(existing) });
      return;
    }

    const providerAsset = {
      id: request.id || crypto.randomUUID(),
      providerId: String(request.providerId).trim(),
      assetType: String(request.assetType).trim(),
      name: String(request.name || "").trim() || String(source.filename || source.volid || "Provider Asset"),
      state: String(request.state || "ready").trim(),
      source,
      detected: request.detected && typeof request.detected === "object" ? request.detected : null,
      metadata: request.metadata && typeof request.metadata === "object" ? request.metadata : null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    database.platform.providerAssets.push(providerAsset);
    writeDatabase(database);
    json(res, 201, { providerAsset: sanitizeProviderAsset(providerAsset) });
    return;
  }

  if (
    (req.method === "PATCH" || req.method === "DELETE") &&
    requestUrl.pathname.startsWith("/v1/platform/provider-assets/")
  ) {
    const assetId = requestUrl.pathname.split("/").filter(Boolean)[3];
    const database = readDatabase();
    ensurePlatformShape(database);
    const assetIndex = findProviderAssetIndex(database, assetId);

    if (assetIndex === -1) {
      json(res, 404, { error: "Provider asset not found" });
      return;
    }

    if (req.method === "DELETE") {
      const [providerAsset] = database.platform.providerAssets.splice(assetIndex, 1);
      writeDatabase(database);
      json(res, 200, { providerAsset: sanitizeProviderAsset(providerAsset) });
      return;
    }

    const body = await readRequestBody(req);
    const request = body ? JSON.parse(body) : {};
    const asset = database.platform.providerAssets[assetIndex];

    if (request.name !== undefined) {
      asset.name = String(request.name || "").trim();
    }
    if (request.state !== undefined) {
      asset.state = String(request.state || "ready").trim();
    }
    if (request.detected && typeof request.detected === "object") {
      asset.detected = {
        ...(asset.detected || {}),
        ...request.detected,
      };
    }
    if (request.metadata && typeof request.metadata === "object") {
      asset.metadata = {
        ...(asset.metadata || {}),
        ...request.metadata,
      };
    }
    if (request.source && typeof request.source === "object") {
      asset.source = {
        ...(asset.source || {}),
        ...request.source,
      };
    }
    asset.updatedAt = new Date().toISOString();
    writeDatabase(database);
    json(res, 200, { providerAsset: sanitizeProviderAsset(asset) });
    return;
  }

  if (req.method === "GET" && req.url === "/v1/platform/image-profiles") {
    const database = readDatabase();
    ensurePlatformShape(database);
    json(res, 200, {
      imageProfiles: database.platform.imageProfiles.slice(),
    });
    return;
  }

  if (req.method === "POST" && req.url === "/v1/platform/image-profiles") {
    const body = await readRequestBody(req);
    const request = body ? JSON.parse(body) : {};
    const database = readDatabase();
    ensurePlatformShape(database);

    if (!String(request.name || "").trim()) {
      json(res, 400, { error: "name is required" });
      return;
    }

    const profile = {
      id: request.id || crypto.randomUUID(),
      name: String(request.name).trim(),
      description: String(request.description || "").trim(),
      providerId: request.providerId || "proxmox-primary",
      assetId: request.assetId || null,
      distributionId: request.distributionId || null,
      interfaceId: request.interfaceId || null,
      enabled: request.enabled !== false,
      installerIsoVolid: request.installerIsoVolid || "",
      installConfig: {
        locale: request.installConfig?.locale || "",
        keyboardLayout: request.installConfig?.keyboardLayout || "",
        timezone: request.installConfig?.timezone || "",
        hostname: request.installConfig?.hostname || "",
      },
      packages: Array.isArray(request.packages)
        ? request.packages.map((entry) => String(entry).trim()).filter(Boolean)
        : [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    database.platform.imageProfiles.push(profile);
    writeDatabase(database);
    json(res, 201, { imageProfile: profile });
    return;
  }

  if (
    (req.method === "PATCH" || req.method === "DELETE") &&
    req.url.startsWith("/v1/platform/image-profiles/")
  ) {
    const parts = req.url.split("/").filter(Boolean);
    const profileId = parts[3];
    const database = readDatabase();
    ensurePlatformShape(database);
    const profileIndex = database.platform.imageProfiles.findIndex(
      (entry) => entry.id === profileId
    );

    if (profileIndex === -1) {
      json(res, 404, { error: "Image profile not found" });
      return;
    }

    if (req.method === "DELETE") {
      const [imageProfile] = database.platform.imageProfiles.splice(profileIndex, 1);
      writeDatabase(database);
      json(res, 200, { imageProfile });
      return;
    }

    const body = await readRequestBody(req);
    const request = body ? JSON.parse(body) : {};
    const profile = database.platform.imageProfiles[profileIndex];

    if (request.name !== undefined) {
      const name = String(request.name || "").trim();
      if (!name) {
        json(res, 400, { error: "name is required" });
        return;
      }
      profile.name = name;
    }

    if (request.description !== undefined) {
      profile.description = String(request.description || "").trim();
    }

    if (request.providerId !== undefined) {
      profile.providerId = request.providerId || null;
    }

    if (request.assetId !== undefined) {
      profile.assetId = request.assetId || null;
    }

    if (request.distributionId !== undefined) {
      profile.distributionId = request.distributionId || null;
    }

    if (request.interfaceId !== undefined) {
      profile.interfaceId = request.interfaceId || null;
    }

    if (request.enabled !== undefined) {
      profile.enabled = Boolean(request.enabled);
    }

    if (request.installerIsoVolid !== undefined) {
      profile.installerIsoVolid = String(request.installerIsoVolid || "");
    }

    if (request.installConfig && typeof request.installConfig === "object") {
      profile.installConfig = {
        ...(profile.installConfig || {}),
        ...request.installConfig,
      };
    }

    if (request.packages !== undefined) {
      profile.packages = Array.isArray(request.packages)
        ? request.packages.map((entry) => String(entry).trim()).filter(Boolean)
        : [];
    }

    profile.updatedAt = new Date().toISOString();
    writeDatabase(database);
    json(res, 200, { imageProfile: profile });
    return;
  }

  if (req.method === "POST" && req.url === "/v1/platform/events") {
    const body = await readRequestBody(req);
    const request = body ? JSON.parse(body) : {};
    const database = readDatabase();
    appendPlatformEvent(database, request);
    writeDatabase(database);
    json(res, 201, {
      event: database.platform.events[0],
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/v1/platform/ssh-hosts") {
    const database = readDatabase();
    ensurePlatformShape(database);
    json(res, 200, {
      sshHosts: database.platform.sshHosts.map(sanitizeSshHost),
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/v1/platform/ssh-hosts") {
    const body = await readRequestBody(req);
    const request = body ? JSON.parse(body) : {};
    const database = readDatabase();
    ensurePlatformShape(database);
    const name = String(request.name || "").trim();
    const hostname = String(request.hostname || "").trim();

    if (!name || !hostname) {
      json(res, 400, { error: "name and hostname are required" });
      return;
    }

    const host = {
      id: request.id || crypto.randomUUID(),
      name,
      hostname,
      port: Number(request.port || 22),
      enabled: request.enabled !== false,
      tags: Array.isArray(request.tags)
        ? request.tags.map((entry) => String(entry).trim()).filter(Boolean)
        : [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    database.platform.sshHosts.push(host);
    writeDatabase(database);
    json(res, 201, { sshHost: sanitizeSshHost(host) });
    return;
  }

  if (
    (req.method === "PATCH" || req.method === "DELETE") &&
    requestUrl.pathname.startsWith("/v1/platform/ssh-hosts/")
  ) {
    const hostId = requestUrl.pathname.split("/").filter(Boolean)[3];
    const database = readDatabase();
    ensurePlatformShape(database);
    const hostIndex = database.platform.sshHosts.findIndex((entry) => entry.id === hostId);

    if (hostIndex === -1) {
      json(res, 404, { error: "SSH host not found" });
      return;
    }

    if (req.method === "DELETE") {
      const profileUsesHost = database.platform.sshProfiles.some((entry) => entry.hostId === hostId);
      if (profileUsesHost) {
        json(res, 409, { error: "SSH host is used by one or more profiles" });
        return;
      }
      const [sshHost] = database.platform.sshHosts.splice(hostIndex, 1);
      writeDatabase(database);
      json(res, 200, { sshHost: sanitizeSshHost(sshHost) });
      return;
    }

    const body = await readRequestBody(req);
    const request = body ? JSON.parse(body) : {};
    const host = database.platform.sshHosts[hostIndex];
    if (request.name !== undefined) host.name = String(request.name || "").trim();
    if (request.hostname !== undefined) host.hostname = String(request.hostname || "").trim();
    if (request.port !== undefined) host.port = Number(request.port || 22);
    if (request.enabled !== undefined) host.enabled = Boolean(request.enabled);
    if (request.tags !== undefined) {
      host.tags = Array.isArray(request.tags)
        ? request.tags.map((entry) => String(entry).trim()).filter(Boolean)
        : [];
    }
    if (!host.name || !host.hostname) {
      json(res, 400, { error: "name and hostname are required" });
      return;
    }
    host.updatedAt = new Date().toISOString();
    writeDatabase(database);
    json(res, 200, { sshHost: sanitizeSshHost(host) });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/v1/platform/ssh-credentials") {
    const database = readDatabase();
    ensurePlatformShape(database);
    json(res, 200, {
      sshCredentials: database.platform.sshCredentials.map(sanitizeSshCredential),
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/v1/platform/ssh-credentials") {
    const body = await readRequestBody(req);
    const request = body ? JSON.parse(body) : {};
    const database = readDatabase();
    ensurePlatformShape(database);
    const name = String(request.name || "").trim();
    const username = String(request.username || "").trim();
    const privateKey = String(request.privateKey || "").trim();

    if (!name || !username || !privateKey) {
      json(res, 400, { error: "name, username, and privateKey are required" });
      return;
    }

    const credential = {
      id: request.id || crypto.randomUUID(),
      name,
      username,
      authType: "private-key",
      ...encryptSecret(privateKey),
      passphrase: request.passphrase ? String(request.passphrase) : "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    database.platform.sshCredentials.push(credential);
    writeDatabase(database);
    json(res, 201, { sshCredential: sanitizeSshCredential(credential) });
    return;
  }

  if (
    (req.method === "PATCH" || req.method === "DELETE") &&
    requestUrl.pathname.startsWith("/v1/platform/ssh-credentials/")
  ) {
    const credentialId = requestUrl.pathname.split("/").filter(Boolean)[3];
    const database = readDatabase();
    ensurePlatformShape(database);
    const credentialIndex = database.platform.sshCredentials.findIndex(
      (entry) => entry.id === credentialId
    );

    if (credentialIndex === -1) {
      json(res, 404, { error: "SSH credential not found" });
      return;
    }

    if (req.method === "DELETE") {
      const profileUsesCredential = database.platform.sshProfiles.some(
        (entry) => entry.credentialId === credentialId
      );
      if (profileUsesCredential) {
        json(res, 409, { error: "SSH credential is used by one or more profiles" });
        return;
      }
      const [sshCredential] = database.platform.sshCredentials.splice(credentialIndex, 1);
      writeDatabase(database);
      json(res, 200, { sshCredential: sanitizeSshCredential(sshCredential) });
      return;
    }

    const body = await readRequestBody(req);
    const request = body ? JSON.parse(body) : {};
    const credential = database.platform.sshCredentials[credentialIndex];
    if (request.name !== undefined) credential.name = String(request.name || "").trim();
    if (request.username !== undefined) credential.username = String(request.username || "").trim();
    if (request.privateKey !== undefined && String(request.privateKey || "").trim()) {
      delete credential.privateKey;
      Object.assign(credential, encryptSecret(String(request.privateKey).trim()));
    }
    if (request.passphrase !== undefined) credential.passphrase = String(request.passphrase || "");
    if (!credential.name || !credential.username || !hasPrivateKey(credential)) {
      json(res, 400, { error: "name, username, and privateKey are required" });
      return;
    }
    credential.updatedAt = new Date().toISOString();
    writeDatabase(database);
    json(res, 200, { sshCredential: sanitizeSshCredential(credential) });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/v1/platform/ssh-profiles") {
    const database = readDatabase();
    ensurePlatformShape(database);
    json(res, 200, {
      sshProfiles: database.platform.sshProfiles.map((entry) =>
        sanitizeSshProfileForLaunch(entry, database)
      ),
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/v1/platform/ssh-profiles/internal") {
    const database = readDatabase();
    ensurePlatformShape(database);
    json(res, 200, {
      sshProfiles: database.platform.sshProfiles.map((profile) => ({
        ...profile,
        host: database.platform.sshHosts.find((entry) => entry.id === profile.hostId) || null,
        credential: (() => {
          const credential =
            database.platform.sshCredentials.find((entry) => entry.id === profile.credentialId) ||
            null;
          return credential
            ? {
                ...credential,
                privateKey: decryptSecret(credential),
              }
            : null;
        })(),
      })),
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/v1/platform/ssh-profiles") {
    const body = await readRequestBody(req);
    const request = body ? JSON.parse(body) : {};
    const database = readDatabase();
    ensurePlatformShape(database);
    const name = String(request.name || "").trim();
    const hostId = String(request.hostId || "").trim();
    const credentialId = String(request.credentialId || "").trim();

    if (!name || !hostId || !credentialId) {
      json(res, 400, { error: "name, hostId, and credentialId are required" });
      return;
    }

    if (!database.platform.sshHosts.some((entry) => entry.id === hostId)) {
      json(res, 400, { error: "hostId does not reference an SSH host" });
      return;
    }

    if (!database.platform.sshCredentials.some((entry) => entry.id === credentialId)) {
      json(res, 400, { error: "credentialId does not reference an SSH credential" });
      return;
    }

    const profile = {
      id: request.id || crypto.randomUUID(),
      name,
      description: String(request.description || "").trim(),
      hostId,
      credentialId,
      shell: String(request.shell || "").trim(),
      enabled: request.enabled !== false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    database.platform.sshProfiles.push(profile);
    writeDatabase(database);
    json(res, 201, { sshProfile: sanitizeSshProfileForLaunch(profile, database) });
    return;
  }

  if (
    (req.method === "PATCH" || req.method === "DELETE") &&
    requestUrl.pathname.startsWith("/v1/platform/ssh-profiles/")
  ) {
    const profileId = requestUrl.pathname.split("/").filter(Boolean)[3];
    const database = readDatabase();
    ensurePlatformShape(database);
    const profileIndex = database.platform.sshProfiles.findIndex((entry) => entry.id === profileId);

    if (profileIndex === -1) {
      json(res, 404, { error: "SSH profile not found" });
      return;
    }

    if (req.method === "DELETE") {
      const [sshProfile] = database.platform.sshProfiles.splice(profileIndex, 1);
      writeDatabase(database);
      json(res, 200, { sshProfile: sanitizeSshProfileForLaunch(sshProfile, database) });
      return;
    }

    const body = await readRequestBody(req);
    const request = body ? JSON.parse(body) : {};
    const profile = database.platform.sshProfiles[profileIndex];
    if (request.name !== undefined) profile.name = String(request.name || "").trim();
    if (request.description !== undefined) {
      profile.description = String(request.description || "").trim();
    }
    if (request.hostId !== undefined) profile.hostId = String(request.hostId || "").trim();
    if (request.credentialId !== undefined) {
      profile.credentialId = String(request.credentialId || "").trim();
    }
    if (request.shell !== undefined) profile.shell = String(request.shell || "").trim();
    if (request.enabled !== undefined) profile.enabled = Boolean(request.enabled);
    if (!profile.name || !profile.hostId || !profile.credentialId) {
      json(res, 400, { error: "name, hostId, and credentialId are required" });
      return;
    }
    if (!database.platform.sshHosts.some((entry) => entry.id === profile.hostId)) {
      json(res, 400, { error: "hostId does not reference an SSH host" });
      return;
    }
    if (!database.platform.sshCredentials.some((entry) => entry.id === profile.credentialId)) {
      json(res, 400, { error: "credentialId does not reference an SSH credential" });
      return;
    }
    profile.updatedAt = new Date().toISOString();
    writeDatabase(database);
    json(res, 200, { sshProfile: sanitizeSshProfileForLaunch(profile, database) });
    return;
  }

  if (req.method === "PATCH" && req.url.startsWith("/v1/platform/providers/")) {
    const parts = req.url.split("/").filter(Boolean);
    const providerId = parts[3];
    const body = await readRequestBody(req);
    const request = body ? JSON.parse(body) : {};
    const database = readDatabase();
    ensurePlatformShape(database);
    const provider = database.platform.providers.find((entry) => entry.id === providerId);

    if (!provider) {
      json(res, 404, { error: "Provider not found" });
      return;
    }

    if (request.name !== undefined) {
      const name = String(request.name || "").trim();

      if (!name) {
        json(res, 400, { error: "name is required" });
        return;
      }

      provider.name = name;
    }

    if (request.description !== undefined) {
      provider.description = String(request.description || "").trim();
    }

    if (request.enabled !== undefined) {
      provider.enabled = Boolean(request.enabled);
    }

    if (request.default !== undefined) {
      const nextDefault = Boolean(request.default);
      provider.default = nextDefault;

      if (nextDefault) {
        for (const entry of database.platform.providers) {
          if (entry.id !== provider.id && entry.kind === provider.kind) {
            entry.default = false;
          }
        }
      }
    }

    if (request.config && typeof request.config === "object") {
      provider.config = {
        ...(provider.config || {}),
      };

      for (const [key, value] of Object.entries(request.config)) {
        if (key === "tokenSecret") {
          if (value !== undefined && value !== null && String(value).trim()) {
            provider.config.tokenSecret = String(value);
          }
          continue;
        }

        provider.config[key] = value;
      }
    }

    writeDatabase(database);
    json(res, 200, { provider: sanitizeProvider(provider) });
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/v1/users/")) {
    const parts = req.url.split("/").filter(Boolean);
    const userId = parts[2];
    const resource = parts[3];
    const database = readDatabase();
    const user = database.users.find((entry) => entry.id === userId);

    if (!user) {
      json(res, 404, { error: "User not found" });
      return;
    }

    if (!resource || resource === "profile") {
      json(res, 200, { user: sanitizeUser(user) });
      return;
    }

    if (resource === "sessions") {
      const sessions = database.sessions
        .filter((session) => session.userId === userId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      json(res, 200, { sessions });
      return;
    }
  }

  if (req.method === "PATCH" && req.url.startsWith("/v1/users/")) {
    const parts = req.url.split("/").filter(Boolean);
    const userId = parts[2];
    const resource = parts[3];

    if (resource !== "profile") {
      json(res, 404, { error: "Not found" });
      return;
    }

    const body = await readRequestBody(req);
    const request = body ? JSON.parse(body) : {};
    const database = readDatabase();
    const user = database.users.find((entry) => entry.id === userId);

    if (!user) {
      json(res, 404, { error: "User not found" });
      return;
    }

    if (request.displayName !== undefined) {
      const nextDisplayName = String(request.displayName || "").trim();

      if (!nextDisplayName) {
        json(res, 400, { error: "displayName is required" });
        return;
      }

      user.profile.displayName = nextDisplayName;
    }

    if (request.preferences !== undefined) {
      user.profile.preferences = {
        ...(user.profile.preferences || {}),
        ...(request.preferences || {}),
      };
    }

    writeDatabase(database);
    json(res, 200, { user: sanitizeUser(user) });
    return;
  }

  if (req.method === "POST" && req.url === "/v1/sessions") {
    const body = await readRequestBody(req);
    const request = body ? JSON.parse(body) : {};

    if (!request.userId) {
      json(res, 400, {
        error: "userId is required",
      });
      return;
    }

    const database = readDatabase();
    const session = {
      id: request.id || crypto.randomUUID(),
      userId: request.userId,
      desktopEnvironment: request.desktopEnvironment || "xfce",
      distributionId: request.distributionId || null,
      interfaceId: request.interfaceId || null,
      instanceSizeId: request.instanceSizeId || null,
      machineTypeId: request.machineTypeId || "container",
      providerId: request.providerId || "docker-local",
      imageProfileId: request.imageProfileId || null,
      profileId: request.profileId || null,
      state: request.state || "building",
      statusDetail: request.statusDetail || "",
      containerId: request.containerId || null,
      containerName: request.containerName || null,
      connection: request.connection || null,
      resolvedRuntimeSpec: request.resolvedRuntimeSpec || null,
      lifecycleCapabilities: request.lifecycleCapabilities || null,
      createdAt: request.createdAt || new Date().toISOString(),
      updatedAt: request.updatedAt || new Date().toISOString(),
    };

    database.sessions.push(session);
    writeDatabase(database);
    json(res, 201, { session });
    return;
  }

  if (req.method === "GET" && req.url === "/v1/sessions") {
    const database = readDatabase();
    const sessions = database.sessions
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    json(res, 200, { sessions });
    return;
  }

  if (req.method === "PATCH" && req.url.startsWith("/v1/sessions/")) {
    const parts = req.url.split("/").filter(Boolean);
    const sessionId = parts[2];
    const body = await readRequestBody(req);
    const request = body ? JSON.parse(body) : {};
    const database = readDatabase();
    const session = findSession(database, sessionId);

    if (!session) {
      json(res, 404, { error: "Session not found" });
      return;
    }

    if (request.state !== undefined) {
      session.state = request.state;
    }

    if (request.statusDetail !== undefined) {
      session.statusDetail = request.statusDetail;
    }

    if (request.containerId !== undefined) {
      session.containerId = request.containerId;
    }

    if (request.containerName !== undefined) {
      session.containerName = request.containerName;
    }

    if (request.connection !== undefined) {
      session.connection = request.connection;
    }

    if (request.resolvedRuntimeSpec !== undefined) {
      session.resolvedRuntimeSpec = request.resolvedRuntimeSpec;
    }

    if (request.machineTypeId !== undefined) {
      session.machineTypeId = request.machineTypeId;
    }

    if (request.providerId !== undefined) {
      session.providerId = request.providerId;
    }

    if (request.imageProfileId !== undefined) {
      session.imageProfileId = request.imageProfileId;
    }

    if (request.lifecycleCapabilities !== undefined) {
      session.lifecycleCapabilities = request.lifecycleCapabilities;
    }

    session.updatedAt = new Date().toISOString();
    writeDatabase(database);
    json(res, 200, { session });
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/v1/sessions/")) {
    const parts = req.url.split("/").filter(Boolean);
    const sessionId = parts[2];
    const database = readDatabase();
    const session = findSession(database, sessionId);

    if (!session) {
      json(res, 404, { error: "Session not found" });
      return;
    }

    json(res, 200, { session });
    return;
  }

  if (req.method === "DELETE" && req.url.startsWith("/v1/sessions/")) {
    const parts = req.url.split("/").filter(Boolean);
    const sessionId = parts[2];
    const database = readDatabase();
    const sessionIndex = findSessionIndex(database, sessionId);

    if (sessionIndex === -1) {
      json(res, 404, { error: "Session not found" });
      return;
    }

    const [session] = database.sessions.splice(sessionIndex, 1);
    writeDatabase(database);
    json(res, 200, { session });
    return;
  }

  json(res, 404, { error: "Not found" });
});

server.listen(port, () => {
  console.log(`data-service listening on ${port}`);
});
