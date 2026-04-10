const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const port = Number(process.env.PORT || 8083);
const dataFilePath = process.env.DATA_FILE_PATH || "/tmp/virtualworkstation-db.json";

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
        imageProfiles: [],
      },
      sessions: [],
    };
    fs.writeFileSync(dataFilePath, JSON.stringify(database, null, 2));
  }
}

function defaultProviders() {
  return [
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
        supportsVirtualMachines: false,
        supportsSuspend: false,
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
        supportsVirtualMachines: true,
        supportsSuspend: true,
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
        supportsVirtualMachines: true,
        supportsSuspend: true,
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

function sanitizeUser(user) {
  return {
    id: user.id,
    username: user.username,
    profile: user.profile,
  };
}

function ensurePlatformShape(database) {
  if (!database.platform) {
    database.platform = { providers: [], events: [], imageProfiles: [] };
  }

  if (!Array.isArray(database.platform.providers)) {
    database.platform.providers = [];
  }

  if (!Array.isArray(database.platform.events)) {
    database.platform.events = [];
  }

  if (!Array.isArray(database.platform.imageProfiles)) {
    database.platform.imageProfiles = [];
  }

  if (database.platform.providers.length === 0) {
    database.platform.providers = defaultProviders();
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
