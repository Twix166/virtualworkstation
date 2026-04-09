const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");

const port = Number(process.env.PORT || 8082);
const publicBaseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:8080";
const dataServiceUrl = process.env.DATA_SERVICE_URL || "http://localhost:8083";
const authTokenSecret = process.env.AUTH_TOKEN_SECRET || "virtualworkstation-dev-secret";
const workspaceCatalogPath =
  process.env.WORKSPACE_CATALOG_PATH ||
  path.resolve(__dirname, "../../../config/workspace-catalog.json");
const runtimeSourceRoot =
  process.env.RUNTIME_SOURCE_ROOT || path.resolve(__dirname, "../../..");
const cleanupIntervalMs = Number(process.env.CLEANUP_INTERVAL_MS || 120000);
const staleProvisioningSessionMs = Number(
  process.env.STALE_PROVISIONING_SESSION_MS || 20 * 60 * 1000
);
let cleanupInProgress = false;
const imageBuildOperations = new Map();
let buildxAvailablePromise = null;

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

function loadCatalog() {
  return JSON.parse(fs.readFileSync(workspaceCatalogPath, "utf8"));
}

function verifyToken(authorization) {
  if (!authorization.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length);
  const [payload, signature] = token.split(".");

  if (!payload || !signature) {
    return null;
  }

  const expectedSignature = crypto
    .createHmac("sha256", authTokenSecret)
    .update(payload)
    .digest("base64url");

  if (expectedSignature !== signature) {
    return null;
  }

  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function isAdminIdentity(identity) {
  return Boolean(
    identity && (identity.isAdmin || identity.role === "admin" || identity.username === "demo")
  );
}

function forwardJson(route, method, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(route, dataServiceUrl);
    const request = http.request(
      target,
      {
        method,
        headers: {
          "Content-Type": "application/json",
        },
      },
      (response) => {
        let responseBody = "";
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode || 500,
            payload: responseBody ? JSON.parse(responseBody) : {},
          });
        });
      }
    );

    request.on("error", reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function execDocker(args) {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function runDocker(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      env: {
        ...process.env,
        ...(options.env || {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const appendOutput = (target, chunk) => {
      const nextValue = (target + chunk.toString("utf8")).slice(-64 * 1024);
      return nextValue;
    };

    const emitLines = (streamName, chunk) => {
      const key = streamName === "stdout" ? "stdoutBuffer" : "stderrBuffer";
      let buffer = key === "stdoutBuffer" ? stdoutBuffer : stderrBuffer;
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        options.onLine?.(line, streamName);
      }

      if (key === "stdoutBuffer") {
        stdoutBuffer = buffer;
      } else {
        stderrBuffer = buffer;
      }
    };

    child.stdout.on("data", (chunk) => {
      stdout = appendOutput(stdout, chunk);
      emitLines("stdout", chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = appendOutput(stderr, chunk);
      emitLines("stderr", chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (stdoutBuffer) {
        options.onLine?.(stdoutBuffer, "stdout");
      }
      if (stderrBuffer) {
        options.onLine?.(stderrBuffer, "stderr");
      }

      if (code === 0) {
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
        return;
      }

      reject(
        new Error(stderr.trim() || stdout.trim() || `docker ${args[0]} failed with exit code ${code}`)
      );
    });
  });
}

function mapBuildOutputToStatus(line) {
  const text = String(line || "").trim();

  if (!text) {
    return null;
  }

  if (
    text.includes("[internal] load metadata for") ||
    text.includes("load metadata for") ||
    text.includes("FROM ")
  ) {
    return "Resolving base image...";
  }

  if (
    text.includes("load build context") ||
    text.includes("Sending build context to Docker daemon")
  ) {
    return "Preparing build context...";
  }

  if (
    text.includes("apt-get update") ||
    text.includes("Reading package lists") ||
    text.includes("Building dependency tree") ||
    text.includes("The following NEW packages will be installed") ||
    text.includes("Need to get ") ||
    text.includes("Fetched ")
  ) {
    return "Installing desktop packages...";
  }

  if (
    text.includes("Selecting previously unselected package") ||
    text.includes("Preparing to unpack ") ||
    text.includes("Unpacking ")
  ) {
    return "Unpacking desktop packages...";
  }

  if (
    text.includes("Setting up ") ||
    text.includes("Processing triggers for ")
  ) {
    return "Configuring installed packages. This can take several minutes for a full desktop image...";
  }

  if (
    text.includes("exporting to image") ||
    text.includes("exporting layers") ||
    text.includes("importing to docker") ||
    text.includes("writing image sha256:") ||
    text.includes("naming to ") ||
    text.includes("unpacking to ")
  ) {
    return "Finalizing runtime image...";
  }

  if (text.includes("DONE")) {
    return "Finishing image build steps...";
  }

  return null;
}

async function isBuildxAvailable() {
  if (!buildxAvailablePromise) {
    buildxAvailablePromise = execDocker(["buildx", "version"])
      .then(() => true)
      .catch(() => false);
  }

  return buildxAvailablePromise;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveCatalogSelections(catalog, request) {
  const distributionId =
    request.distributionId || catalog.policies?.defaultDistributionId;
  const interfaceId = request.interfaceId || catalog.policies?.defaultInterfaceId;
  const instanceSizeId =
    request.instanceSizeId || catalog.policies?.defaultInstanceSizeId;

  const distribution = (catalog.distributions || []).find(
    (entry) => entry.id === distributionId
  );
  const runtimeInterface = (catalog.interfaces || []).find(
    (entry) => entry.id === interfaceId
  );
  const instanceSize = (catalog.instanceSizes || []).find(
    (entry) => entry.id === instanceSizeId
  );
  const runtimeProfile = (catalog.runtimeProfiles || []).find(
    (entry) =>
      entry.distributionId === distributionId && entry.interfaceId === interfaceId
  );

  return {
    distributionId,
    interfaceId,
    instanceSizeId,
    distribution,
    runtimeInterface,
    instanceSize,
    runtimeProfile,
  };
}

function pickDefaultOptionId(options) {
  return (
    (options || []).find((entry) => entry.default)?.id ||
    (options || [])[0]?.id ||
    ""
  );
}

function resolveInstallConfig(catalog, request, identity) {
  const installOptions = catalog.installOptions || {};
  const defaultInstallConfig = catalog.policies?.defaultInstallConfig || {};
  const locale =
    request.installConfig?.locale ||
    defaultInstallConfig.locale ||
    pickDefaultOptionId(installOptions.locales);
  const keyboardLayout =
    request.installConfig?.keyboardLayout ||
    defaultInstallConfig.keyboardLayout ||
    pickDefaultOptionId(installOptions.keyboardLayouts);
  const timezone =
    request.installConfig?.timezone ||
    defaultInstallConfig.timezone ||
    pickDefaultOptionId(installOptions.timezones);
  const hostnameInput =
    request.installConfig?.hostname ||
    `vw-${String(identity?.username || "session")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)}`;
  const hostname = hostnameInput
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

  return {
    locale,
    keyboardLayout,
    timezone,
    hostname: hostname || "virtualworkstation",
  };
}

function buildRuntimeSpec(selection, installConfig = null) {
  return {
    profileId: selection.runtimeProfile.id,
    distributionId: selection.distribution.id,
    interfaceId: selection.runtimeInterface.id,
    instanceSizeId: selection.instanceSize.id,
    image: selection.runtimeProfile.image,
    protocol: selection.runtimeInterface.protocol,
    resources: selection.instanceSize.resources,
    imageSource: selection.runtimeProfile.imageSource || null,
    runtime: {
      mode: selection.runtimeProfile.launch.mode,
      exposedPort: selection.runtimeProfile.launch.exposedPort,
      connectionPath: selection.runtimeProfile.launch.connectionPath,
    },
    installConfig,
  };
}

function defaultMachineTypes() {
  return [
    {
      id: "container",
      name: "Docker Image",
      kind: "container",
      description: "Launch a container-backed workstation or terminal session.",
      default: true,
    },
    {
      id: "virtual-machine",
      name: "Virtual Machine",
      kind: "virtual-machine",
      description: "Launch a KVM-backed virtual machine through a provider plugin.",
    },
  ];
}

async function listProviders() {
  const response = await forwardJson("/v1/platform/providers/internal", "GET");
  return response.payload.providers || [];
}

async function getProviderRecordForSession(session) {
  const providers = await listProviders();
  const providerId = session?.providerId || session?.resolvedRuntimeSpec?.provider?.id;
  return providers.find((entry) => entry.id === providerId) || null;
}

function getSessionRuntimeResource(session) {
  return session?.resolvedRuntimeSpec?.provisionedResource || null;
}

function buildProxmoxAuthorizationHeader(provider) {
  const tokenId = String(provider?.config?.tokenId || "").trim();
  const tokenSecret = String(provider?.config?.tokenSecret || "").trim();

  if (!tokenId || !tokenSecret) {
    throw new Error("Proxmox provider is missing tokenId or tokenSecret");
  }

  return `PVEAPIToken=${tokenId}=${tokenSecret}`;
}

function text(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, { "Content-Type": contentType });
  res.end(body);
}

function getLocalRequestUrl(req) {
  return new URL(req.url || "/", "http://workspace-service.local");
}

function getProviderConfigValue(provider, key) {
  return String(provider?.config?.[key] || "").trim();
}

function getProviderBoolean(provider, key, fallback = false) {
  const value = provider?.config?.[key];

  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return Boolean(value);
}

function sanitizeProviderRecord(provider) {
  if (!provider) {
    return null;
  }

  const config = {
    ...(provider.config || {}),
  };

  if ("tokenSecret" in config) {
    config.tokenSecret = "";
    config.hasTokenSecret = Boolean(provider.config?.tokenSecret);
  }

  if ("vmPassword" in config) {
    config.vmPassword = "";
    config.hasVmPassword = Boolean(provider.config?.vmPassword);
  }

  return {
    ...provider,
    config,
  };
}

function sanitizeRuntimeSpecForPersistence(runtimeSpec) {
  if (!runtimeSpec) {
    return null;
  }

  return {
    ...runtimeSpec,
    providerRecord: sanitizeProviderRecord(runtimeSpec.providerRecord),
  };
}

function buildSeedPaths(sessionId, installToken) {
  const basePath = `/api/install-seeds/${encodeURIComponent(sessionId)}/${encodeURIComponent(
    installToken
  )}`;
  return {
    basePath,
    userDataPath: `${basePath}/user-data`,
    metaDataPath: `${basePath}/meta-data`,
  };
}

function getSeedBaseUrl(provider) {
  const configuredSeedBaseUrl = getProviderConfigValue(provider, "seedBaseUrl");

  if (configuredSeedBaseUrl) {
    return configuredSeedBaseUrl.replace(/\/$/, "");
  }

  const fallbackUrl = String(publicBaseUrl || "").trim();

  if (!fallbackUrl) {
    throw new Error(
      "Proxmox provider is missing seedBaseUrl. Set a guest-reachable URL for unattended install seeds."
    );
  }

  const parsed = new URL(fallbackUrl);

  if (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error(
      "Proxmox unattended installs require a guest-reachable seedBaseUrl. Update the provider config with this host's LAN URL, for example http://10.0.0.149:8080."
    );
  }

  return parsed.origin.replace(/\/$/, "");
}

function getVmConsoleBaseUrl(provider) {
  const configured = getProviderConfigValue(provider, "vmConsoleBaseUrl");

  if (configured) {
    return configured.replace(/\/$/, "");
  }

  const apiUrl = getProviderConfigValue(provider, "apiUrl");

  if (!apiUrl) {
    return "";
  }

  return new URL(apiUrl).origin.replace(/\/$/, "");
}

function buildProxmoxConsoleUrl(provider, vmid) {
  const baseUrl = getVmConsoleBaseUrl(provider);
  const node = getProviderConfigValue(provider, "node");

  if (!baseUrl || !vmid || !node) {
    return null;
  }

  return `${baseUrl}/?console=kvm&novnc=1&vmid=${encodeURIComponent(
    String(vmid)
  )}&node=${encodeURIComponent(node)}&resize=scale`;
}

async function getSessionById(sessionId) {
  const response = await getSession(sessionId);
  return response.payload.session || null;
}

async function listProxmoxStorageContent(provider, node, storage) {
  return (
    (await proxmoxRequest(
      provider,
      `/api2/json/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content`
    )) || []
  );
}

async function resolveProxmoxInstallerIsoVolid(provider, runtimeSpec) {
  const node = getProviderConfigValue(provider, "node");
  const isoStorage = getProviderConfigValue(provider, "isoStorage") || "local";
  const configuredVolid = getProviderConfigValue(provider, "installerIsoVolid");

  if (!node) {
    throw new Error("Proxmox provider is missing node");
  }

  if (configuredVolid) {
    return configuredVolid;
  }

  const content = await listProxmoxStorageContent(provider, node, isoStorage);
  const distributionId = String(runtimeSpec?.distributionId || "");
  const patterns = [];

  if (distributionId === "xubuntu-24.04" || distributionId === "ubuntu-24.04") {
    patterns.push(/ubuntu-24\.04.*live-server.*\.iso$/i);
    patterns.push(/ubuntu-24\.04.*\.iso$/i);
  }

  if (distributionId === "debian-12") {
    patterns.push(/debian-12.*\.iso$/i);
    patterns.push(/debian.*bookworm.*\.iso$/i);
  }

  const configuredPattern = getProviderConfigValue(provider, "installerIsoPattern");
  if (configuredPattern) {
    patterns.unshift(new RegExp(configuredPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }

  const matched = content.find((entry) => {
    if (entry.content !== "iso") {
      return false;
    }

    return patterns.some((pattern) => pattern.test(String(entry.volid || "")));
  });

  if (!matched) {
    throw new Error(
      `No installer ISO was found on Proxmox storage '${isoStorage}'. Upload an Ubuntu 24.04 live-server ISO or set installerIsoVolid in the provider config.`
    );
  }

  return matched.volid;
}

function buildAutoinstallMetaData(sessionId, runtimeSpec) {
  const hostname = runtimeSpec?.installConfig?.hostname || "virtualworkstation";
  return `instance-id: ${sessionId}\nlocal-hostname: ${hostname}\n`;
}

function buildAutoinstallUserData(sessionId, runtimeSpec, provider) {
  const vmUsername = getProviderConfigValue(provider, "vmUsername") || "demo";
  const vmPassword = getProviderConfigValue(provider, "vmPassword") || "demo";
  const installConfig = runtimeSpec?.installConfig || {};
  const timezone =
    installConfig.timezone ||
    getProviderConfigValue(provider, "timezone") ||
    "Europe/London";
  const keyboardLayout =
    installConfig.keyboardLayout ||
    getProviderConfigValue(provider, "keyboardLayout") ||
    "gb";
  const locale =
    installConfig.locale ||
    getProviderConfigValue(provider, "locale") ||
    "en_GB.UTF-8";
  const hostname = installConfig.hostname || `vw-${sessionId.slice(0, 8)}`;
  const xubuntuTarget =
    runtimeSpec.distributionId === "xubuntu-24.04"
      ? "xubuntu-desktop"
      : runtimeSpec.interfaceId === "gnome"
        ? "ubuntu-desktop"
        : "ubuntu-desktop";

  return `#cloud-config
autoinstall:
  version: 1
  interactive-sections: []
  locale: ${locale}
  refresh-installer:
    update: true
  keyboard:
    layout: ${keyboardLayout}
  timezone: ${timezone}
  ssh:
    install-server: true
    allow-pw: true
  storage:
    layout:
      name: direct
  apt:
    preserve_sources_list: false
  packages:
    - qemu-guest-agent
    - sudo
    - ${xubuntuTarget}
  user-data:
    hostname: ${hostname}
    disable_root: false
    package_update: true
    package_upgrade: true
    timezone: ${timezone}
    users:
      - default
      - name: ${vmUsername}
        gecos: Virtual Workstation User
        sudo: ALL=(ALL) NOPASSWD:ALL
        shell: /bin/bash
        lock_passwd: false
    chpasswd:
      expire: false
      users:
        - name: ${vmUsername}
          password: ${vmPassword}
          type: text
  late-commands:
    - curtin in-target --target=/target -- systemctl enable qemu-guest-agent
    - curtin in-target --target=/target -- systemctl set-default graphical.target
  shutdown: reboot
`;
}

function mapCharacterToQemuKey(char) {
  if (/^[a-z0-9]$/.test(char)) {
    return char;
  }

  const mapping = {
    " ": "spc",
    "-": "minus",
    ".": "dot",
    "/": "slash",
    ":": "shift-semicolon",
    ";": "semicolon",
    "\\": "backslash",
    "=": "equal",
  };

  if (mapping[char]) {
    return mapping[char];
  }

  throw new Error(`Unsupported boot automation character '${char}'`);
}

async function sendQemuKey(provider, node, vmid, key) {
  await runProxmoxMonitorCommand(provider, node, vmid, `sendkey ${key}`);
}

async function sendQemuText(provider, node, vmid, text) {
  for (const character of String(text || "")) {
    await sendQemuKey(provider, node, vmid, mapCharacterToQemuKey(character));
    await sleep(60);
  }
}

async function automateUbuntuAutoinstallBoot(provider, node, vmid, seedBaseUrl, seedPaths) {
  const seedFromUrl = `${seedBaseUrl}${seedPaths.basePath}/`;
  const bootParameters = ` autoinstall ds=nocloud-net\\;s=${seedFromUrl} ---`;

  await sleep(5000);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sendQemuKey(provider, node, vmid, "esc");
    await sleep(400);
  }

  await sendQemuKey(provider, node, vmid, "e");
  await sleep(1200);

  // Walk down to the kernel line rather than editing the title/setparams line.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sendQemuKey(provider, node, vmid, "down");
    await sleep(250);
  }

  await sendQemuKey(provider, node, vmid, "end");
  await sleep(300);
  await sendQemuKey(provider, node, vmid, "backspace");
  await sleep(120);
  await sendQemuKey(provider, node, vmid, "backspace");
  await sleep(120);
  await sendQemuKey(provider, node, vmid, "backspace");
  await sleep(200);
  await sendQemuText(provider, node, vmid, bootParameters);
  await sleep(300);
  await sendQemuKey(provider, node, vmid, "ctrl-x");
}

async function createProxmoxVirtualMachineShell(sessionId, userId, runtimeSpec, provider, installerIsoVolid) {
  const node = getProviderConfigValue(provider, "node");
  const storage = getProviderConfigValue(provider, "storage");
  const networkBridge = getProviderConfigValue(provider, "networkBridge") || "vmbr0";

  if (!node) {
    throw new Error("Proxmox provider is missing node");
  }

  if (!storage) {
    throw new Error("Proxmox provider is missing storage");
  }

  const vmid = String(await proxmoxRequest(provider, "/api2/json/cluster/nextid"));
  const vmName = `vws-${String(userId).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8)}-${sessionId.slice(0, 8)}`;
  const diskGiB = Number(runtimeSpec?.resources?.storageGiB || 32);
  const createTask = await proxmoxRequest(
    provider,
    `/api2/json/nodes/${encodeURIComponent(node)}/qemu`,
    {
      method: "POST",
      body: {
        vmid,
        name: vmName,
        memory: runtimeSpec.resources.memoryMiB,
        cores: runtimeSpec.resources.cpus,
        sockets: 1,
        scsihw: "virtio-scsi-pci",
        scsi0: `${storage}:${diskGiB}`,
        ide2: `${installerIsoVolid},media=cdrom`,
        net0: `virtio,bridge=${networkBridge}`,
        ostype: "l26",
        boot: "order=ide2;scsi0;net0",
        vga: "std",
        agent: 1,
      },
    }
  );
  await waitForProxmoxTask(provider, node, createTask);

  return {
    vmid,
    vmName,
    node,
  };
}

async function runProxmoxMonitorCommand(provider, node, vmid, command) {
  return proxmoxRequest(
    provider,
    `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(vmid)}/monitor`,
    {
      method: "POST",
      body: {
        command,
      },
    }
  );
}

function proxmoxRequest(provider, apiPath, options = {}) {
  return new Promise((resolve, reject) => {
    const apiUrl = String(provider?.config?.apiUrl || "").trim();

    if (!apiUrl) {
      reject(new Error("Proxmox provider is missing apiUrl"));
      return;
    }

    const baseUrl = new URL(apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`);
    const target = new URL(apiPath.replace(/^\//, ""), baseUrl);
    const transport = target.protocol === "https:" ? https : http;
    const payload =
      options.body && typeof options.body === "object"
        ? new URLSearchParams(
            Object.entries(options.body)
              .filter(([, value]) => value !== undefined && value !== null && value !== "")
              .map(([key, value]) => [key, String(value)])
          ).toString()
        : options.body || "";

    const request = transport.request(
      target,
      {
        method: options.method || "GET",
        headers: {
          Accept: "application/json",
          Authorization: buildProxmoxAuthorizationHeader(provider),
          ...(payload
            ? {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
        rejectUnauthorized: provider?.config?.validateTls !== false,
      },
      (response) => {
        let responseBody = "";
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          let parsed = {};

          if (responseBody) {
            try {
              parsed = JSON.parse(responseBody);
            } catch (error) {
              reject(error);
              return;
            }
          }

          if ((response.statusCode || 500) >= 400) {
            reject(
              new Error(
                parsed.errors
                  ? JSON.stringify(parsed.errors)
                  : parsed.message || parsed.error || responseBody || `Proxmox request failed with ${response.statusCode}`
              )
            );
            return;
          }

          resolve(parsed.data);
        });
      }
    );

    request.on("error", reject);

    if (payload) {
      request.write(payload);
    }

    request.end();
  });
}

async function waitForProxmoxTask(provider, node, upid) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = await proxmoxRequest(
      provider,
      `/api2/json/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`
    );

    if (status?.status === "stopped") {
      if (status.exitstatus && status.exitstatus !== "OK") {
        throw new Error(`Proxmox task failed: ${status.exitstatus}`);
      }
      return status;
    }

    await sleep(2000);
  }

  throw new Error("Timed out waiting for Proxmox task completion");
}

async function provisionProxmoxVirtualMachine(sessionId, userId, runtimeSpec, reportBuildProgress) {
  const provider = runtimeSpec.providerRecord;
  const node = String(provider?.config?.node || "").trim();
  const templateVmid = String(provider?.config?.templateVmid || "").trim();
  const buildStrategy = getProviderConfigValue(provider, "buildStrategy") || "iso-unattended";

  if (!node) {
    throw new Error("Proxmox provider is missing node");
  }

  if (buildStrategy === "template-clone" && templateVmid) {
    reportBuildProgress?.("Allocating Proxmox VM identifier...");
    const vmid = await proxmoxRequest(provider, "/api2/json/cluster/nextid");
    const vmName = `vws-${String(userId).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8)}-${sessionId.slice(0, 8)}`;

    reportBuildProgress?.("Cloning virtual machine template on Proxmox...");
    const cloneTask = await proxmoxRequest(
      provider,
      `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(templateVmid)}/clone`,
      {
        method: "POST",
        body: {
          newid: vmid,
          name: vmName,
          full: 1,
          target: node,
          storage: provider?.config?.storage || undefined,
        },
      }
    );
    await waitForProxmoxTask(provider, node, cloneTask);

    reportBuildProgress?.("Applying CPU and memory sizing...");
    const configTask = await proxmoxRequest(
      provider,
      `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(vmid)}/config`,
      {
        method: "POST",
        body: {
          cores: runtimeSpec.resources.cpus,
          memory: runtimeSpec.resources.memoryMiB,
          name: vmName,
        },
      }
    );
    await waitForProxmoxTask(provider, node, configTask);

    reportBuildProgress?.("Starting virtual machine on Proxmox...");
    const startTask = await proxmoxRequest(
      provider,
      `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(vmid)}/status/start`,
      { method: "POST" }
    );
    await waitForProxmoxTask(provider, node, startTask);

    const consoleUrl = buildProxmoxConsoleUrl(provider, vmid);

    return {
      state: "ready",
      statusDetail: "Virtual machine is running on Proxmox.",
      connection: consoleUrl
        ? {
            type: "browser",
            url: consoleUrl,
          }
        : null,
      provisionedResource: {
        kind: "proxmox-vm",
        node,
        vmid: String(vmid),
        name: vmName,
      },
    };
  }

  const installToken = crypto.randomUUID();
  const seedBaseUrl = getSeedBaseUrl(provider);
  const seedPaths = buildSeedPaths(sessionId, installToken);
  const installerIsoVolid = await resolveProxmoxInstallerIsoVolid(provider, runtimeSpec);

  reportBuildProgress?.("Creating Proxmox virtual machine shell...");
  const vm = await createProxmoxVirtualMachineShell(
    sessionId,
    userId,
    runtimeSpec,
    provider,
    installerIsoVolid
  );
  const autoinstall = {
    mode: "ubuntu-live-server-over-http",
    installToken,
    seedBaseUrl,
    installerIsoVolid,
    seedFromUrl: `${seedBaseUrl}${seedPaths.basePath}/`,
    userDataUrl: `${seedBaseUrl}${seedPaths.userDataPath}`,
    metaDataUrl: `${seedBaseUrl}${seedPaths.metaDataPath}`,
  };
  const provisionedResource = {
    kind: "proxmox-vm",
    node: vm.node,
    vmid: String(vm.vmid),
    name: vm.vmName,
  };

  await updateSession(sessionId, {
    resolvedRuntimeSpec: {
      ...sanitizeRuntimeSpecForPersistence(runtimeSpec),
      proxmoxAutoinstall: autoinstall,
      provisionedResource,
    },
  });

  try {
    reportBuildProgress?.("Starting Proxmox installer VM...");
    const startTask = await proxmoxRequest(
      provider,
      `/api2/json/nodes/${encodeURIComponent(vm.node)}/qemu/${encodeURIComponent(vm.vmid)}/status/start`,
      { method: "POST" }
    );
    await waitForProxmoxTask(provider, vm.node, startTask);

    reportBuildProgress?.("Checking Proxmox monitor permissions for unattended boot automation...");
    try {
      await runProxmoxMonitorCommand(provider, vm.node, vm.vmid, "info status");
    } catch (error) {
      if (String(error.message || "").includes("Sys.Audit|Sys.Modify")) {
        throw new Error(
          "Proxmox VM creation succeeded, but zero-touch ISO boot automation is blocked. Grant the API token Sys.Audit and Sys.Modify on VM paths so the platform can inject the Ubuntu autoinstall boot parameters."
        );
      }

      throw error;
    }

    reportBuildProgress?.("Injecting Ubuntu autoinstall boot parameters...");
    await automateUbuntuAutoinstallBoot(
      provider,
      vm.node,
      vm.vmid,
      seedBaseUrl,
      seedPaths
    );

    reportBuildProgress?.("Waiting for the installer VM to fetch its unattended install seed...");
    const consoleUrl = buildProxmoxConsoleUrl(provider, vm.vmid);

    return {
      state: "launching",
      statusDetail:
        "Installer VM started and boot automation was injected. Waiting for Ubuntu autoinstall to start on Proxmox.",
      connection: consoleUrl
        ? {
            type: "browser",
            url: consoleUrl,
          }
        : null,
      provisionedResource,
      autoinstall,
    };
  } catch (error) {
    try {
      const deleteTask = await proxmoxRequest(
        provider,
        `/api2/json/nodes/${encodeURIComponent(vm.node)}/qemu/${encodeURIComponent(
          vm.vmid
        )}?purge=1&destroy-unreferenced-disks=1`,
        {
          method: "DELETE",
        }
      );
      await waitForProxmoxTask(provider, vm.node, deleteTask);
    } catch (cleanupError) {
      console.error(
        `failed to clean up provisional Proxmox VM ${vm.vmid}: ${cleanupError.message}`
      );
    }

    throw error;
  }
}

function resolveProviderSelection(catalog, providers, request) {
  const machineTypes = catalog.machineTypes || defaultMachineTypes();
  const machineTypeId =
    request.machineTypeId || catalog.policies?.defaultMachineTypeId || machineTypes[0]?.id || "container";
  const machineType = machineTypes.find((entry) => entry.id === machineTypeId) || null;
  const enabledProviders = (providers || []).filter((entry) => entry.enabled);
  const providerId =
    request.providerId ||
    enabledProviders.find(
      (entry) => entry.kind === machineTypeId && entry.default
    )?.id ||
    enabledProviders.find((entry) => entry.kind === machineTypeId)?.id ||
    null;
  const provider =
    enabledProviders.find((entry) => entry.id === providerId) || null;

  return {
    machineTypes,
    machineTypeId,
    machineType,
    providerId,
    provider,
    providers: enabledProviders,
  };
}

function getBuildCacheKey(runtimeSpec) {
  return runtimeSpec.imageSource?.build?.cacheKey || null;
}

function shouldPreferLocalBuild(imageReference) {
  return String(imageReference || "").endsWith(":local");
}

function resolveSourcePath(relativePath) {
  const resolvedPath = path.resolve(runtimeSourceRoot, relativePath || ".");
  const normalizedRoot = path.resolve(runtimeSourceRoot);

  if (
    resolvedPath !== normalizedRoot &&
    !resolvedPath.startsWith(`${normalizedRoot}${path.sep}`)
  ) {
    throw new Error("Runtime build path escapes the configured source root");
  }

  return resolvedPath;
}

async function imageExists(imageReference) {
  try {
    await execDocker(["image", "inspect", imageReference]);
    return true;
  } catch (error) {
    return false;
  }
}

async function getImageBuildCacheKey(imageReference) {
  try {
    const output = await execDocker([
      "image",
      "inspect",
      imageReference,
      "--format",
      "{{ index .Config.Labels \"virtualworkstation.build-cache-key\" }}",
    ]);

    return output.trim() || null;
  } catch (error) {
    return null;
  }
}

async function pullRuntimeImage(targetImage, pullReferences, onProgress) {
  const errors = [];

  for (const reference of pullReferences || []) {
    try {
      onProgress?.(`Pulling runtime image from ${reference}...`);
      await execDocker(["pull", reference]);

      if (reference !== targetImage) {
        onProgress?.("Tagging pulled runtime image...");
        await execDocker(["tag", reference, targetImage]);
      }

      return {
        strategy: "pull",
        source: reference,
      };
    } catch (error) {
      errors.push(`${reference}: ${error.message}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join(" | "));
  }

  return null;
}

async function buildRuntimeImageOnce(targetImage, buildSpec, onProgress) {
  if (!buildSpec || !buildSpec.dockerfile) {
    throw new Error("No build definition is available for this runtime profile");
  }

  const useBuildKit = await isBuildxAvailable();
  const buildArgs = useBuildKit
    ? ["buildx", "build", "--load", "--progress", "plain", "--pull", "-t", targetImage]
    : ["build", "--pull", "-t", targetImage];
  const dockerfilePath = resolveSourcePath(buildSpec.dockerfile);
  const contextPath = resolveSourcePath(buildSpec.context || ".");
  const cacheKey = buildSpec.cacheKey || null;

  buildArgs.push("-f", dockerfilePath);

  if (cacheKey) {
    buildArgs.push(
      "--label",
      `virtualworkstation.build-cache-key=${cacheKey}`
    );
  }

  buildArgs.push("--label", "virtualworkstation.runtime-image=true");

  for (const [key, value] of Object.entries(buildSpec.buildArgs || {})) {
    buildArgs.push("--build-arg", `${key}=${value}`);
  }

  buildArgs.push(contextPath);

  onProgress?.(
    useBuildKit
      ? "Preparing runtime image with BuildKit..."
      : "Preparing runtime image with the standard Docker builder..."
  );

  await runDocker(buildArgs, {
    env: useBuildKit ? {} : { DOCKER_BUILDKIT: "0" },
    onLine: (line) => {
      const nextStatus = mapBuildOutputToStatus(line);
      if (nextStatus) {
        onProgress?.(nextStatus);
      }
    },
  });

  return {
    strategy: "build",
    source: buildSpec.dockerfile,
  };
}

async function buildRuntimeImage(targetImage, buildSpec, onProgress) {
  const existingBuild = imageBuildOperations.get(targetImage);

  if (existingBuild) {
    return existingBuild;
  }

  const buildOperation = (async () => {
    const maxAttempts = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        onProgress?.(
          attempt === 1
            ? "Preparing runtime image..."
            : `Retrying runtime image build (${attempt}/${maxAttempts})...`
        );
        return await buildRuntimeImageOnce(targetImage, buildSpec, onProgress);
      } catch (error) {
        lastError = error;
        console.error(
          `runtime image build failed for ${targetImage} on attempt ${attempt}/${maxAttempts}: ${error.message}`
        );

        try {
          await execDocker(["image", "rm", "-f", targetImage]);
        } catch (removeError) {
          if (
            !removeError.message.includes("No such image") &&
            !removeError.message.includes("reference does not exist")
          ) {
            console.error(
              `runtime image cleanup failed for ${targetImage}: ${removeError.message}`
            );
          }
        }

        await pruneDanglingRuntimeImages();

        if (attempt < maxAttempts) {
          await sleep(1000 * attempt);
        }
      }
    }

    throw lastError;
  })();

  imageBuildOperations.set(targetImage, buildOperation);

  try {
    return await buildOperation;
  } finally {
    imageBuildOperations.delete(targetImage);
  }
}

async function ensureRuntimeImage(runtimeSpec, onProgress) {
  if (!runtimeSpec.image) {
    throw new Error("Runtime profile is missing an image reference");
  }

  const buildCacheKey = getBuildCacheKey(runtimeSpec);
  const imageSource = runtimeSpec.imageSource || {};
  const hasLocalImage = await imageExists(runtimeSpec.image);
  const preferLocalBuild =
    shouldPreferLocalBuild(runtimeSpec.image) && Boolean(imageSource.build);

  if (hasLocalImage) {
    const existingBuildCacheKey = await getImageBuildCacheKey(runtimeSpec.image);

    if (
      !buildCacheKey ||
      existingBuildCacheKey === buildCacheKey
    ) {
      return {
        strategy: "cache",
        source: runtimeSpec.image,
      };
    }

    if (imageSource.build) {
      return buildRuntimeImage(runtimeSpec.image, imageSource.build, onProgress);
    }
  }

  if (preferLocalBuild) {
    return buildRuntimeImage(runtimeSpec.image, imageSource.build, onProgress);
  }

  try {
    const pulledImage = await pullRuntimeImage(
      runtimeSpec.image,
      imageSource.pullReferences || [],
      onProgress
    );

    if (pulledImage) {
      return pulledImage;
    }
  } catch (error) {
    if (!imageSource.build) {
      throw error;
    }
  }

  return buildRuntimeImage(runtimeSpec.image, imageSource.build, onProgress);
}

async function launchRuntimeContainer(sessionId, userId, runtimeSpec) {
  const safeUserId = userId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "user";
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
  const containerName = `vws-${safeUserId}-${safeSessionId}`;
  const cpus = String(runtimeSpec.resources.cpus);
  const memory = `${runtimeSpec.resources.memoryMiB}m`;

  const containerId = await execDocker([
    "run",
    "-d",
    "--rm",
    "--shm-size=1g",
    "--cpus",
    cpus,
    "--memory",
    memory,
    "--name",
    containerName,
    "--label",
    "app=virtualworkstation-session",
    "--label",
    `session-id=${sessionId}`,
    "--label",
    `user-id=${userId}`,
    "-p",
    `127.0.0.1::${runtimeSpec.runtime.exposedPort}`,
    runtimeSpec.image,
  ]);

  const inspectOutput = await execDocker([
    "inspect",
    containerId,
    "--format",
    `{{ (index (index .NetworkSettings.Ports "${runtimeSpec.runtime.exposedPort}/tcp") 0).HostPort }}`,
  ]);

  return {
    containerId,
    containerName,
    hostPort: Number(inspectOutput),
  };
}

async function isContainerRunning(containerId) {
  try {
    const output = await execDocker([
      "inspect",
      containerId,
      "--format",
      "{{.State.Running}}",
    ]);
    return output.trim() === "true";
  } catch (error) {
    return false;
  }
}

async function verifyRuntimeHealth(runtime, runtimeSpec) {
  if (!(await isContainerRunning(runtime.containerId))) {
    return false;
  }

  if (runtimeSpec.protocol === "novnc") {
    try {
      await execDocker([
        "exec",
        runtime.containerId,
        "sh",
        "-lc",
        "pgrep Xtigervnc >/dev/null",
      ]);
      return true;
    } catch (error) {
      return false;
    }
  }

  if (runtimeSpec.protocol === "shellinabox") {
    try {
      await execDocker([
        "exec",
        runtime.containerId,
        "sh",
        "-lc",
        "pgrep shellinaboxd >/dev/null",
      ]);
      return true;
    } catch (error) {
      return false;
    }
  }

  return true;
}

async function waitForRuntimeReady(runtime, runtimeSpec) {
  const attempts = runtimeSpec.protocol === "novnc" ? 30 : 12;
  const delayMs = 1000;
  const requiredConsecutiveHealthyChecks =
    runtimeSpec.protocol === "novnc" ? 5 : 2;
  let consecutiveHealthyChecks = 0;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await verifyRuntimeHealth(runtime, runtimeSpec)) {
      consecutiveHealthyChecks += 1;

      if (consecutiveHealthyChecks >= requiredConsecutiveHealthyChecks) {
        return;
      }
    } else {
      consecutiveHealthyChecks = 0;
    }

    await sleep(delayMs);
  }

  throw new Error("Runtime failed health verification after startup");
}

async function updateSession(sessionId, patch) {
  return forwardJson(
    `/v1/sessions/${sessionId}`,
    "PATCH",
    JSON.stringify(patch)
  );
}

async function getSession(sessionId) {
  return forwardJson(`/v1/sessions/${sessionId}`, "GET");
}

async function listAllSessions() {
  return forwardJson("/v1/sessions", "GET");
}

async function deleteSessionRecord(sessionId) {
  return forwardJson(`/v1/sessions/${sessionId}`, "DELETE");
}

async function removeRuntimeContainer(containerIdOrName) {
  if (!containerIdOrName) {
    return false;
  }

  try {
    await execDocker(["rm", "-f", containerIdOrName]);
    return true;
  } catch (error) {
    if (
      error.message.includes("No such container") ||
      error.message.includes("No such object")
    ) {
      return false;
    }
    throw error;
  }
}

async function listSessionContainerIds(sessionId) {
  const output = await execDocker([
    "ps",
    "-a",
    "--filter",
    `label=session-id=${sessionId}`,
    "--format",
    "{{.ID}}",
  ]);

  return output
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function listManagedContainers() {
  const output = await execDocker([
    "ps",
    "-a",
    "--filter",
    "label=app=virtualworkstation-session",
    "--format",
    "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Label \"session-id\"}}",
  ]);

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, name, image, sessionId] = line.split("\t");
      return {
        id,
        name,
        image,
        sessionId: sessionId || null,
      };
    });
}

async function pruneDanglingRuntimeImages() {
  try {
    await execDocker(["image", "prune", "-f"]);
  } catch (error) {
    console.error("runtime image prune failed", error.message);
  }
}

async function removeSessionContainers(session) {
  const candidates = new Set(
    [
      session.containerId,
      session.containerName,
      ...(await listSessionContainerIds(session.id)),
    ].filter(Boolean)
  );

  for (const candidate of candidates) {
    await removeRuntimeContainer(candidate);
  }
}

async function stopProxmoxVirtualMachine(session) {
  const resource = getSessionRuntimeResource(session);
  const provider = await getProviderRecordForSession(session);

  if (!resource || resource.kind !== "proxmox-vm" || !provider) {
    return;
  }

  const task = await proxmoxRequest(
    provider,
    `/api2/json/nodes/${encodeURIComponent(resource.node)}/qemu/${encodeURIComponent(resource.vmid)}/status/stop`,
    { method: "POST" }
  );
  await waitForProxmoxTask(provider, resource.node, task);
}

async function deleteProxmoxVirtualMachine(session) {
  const resource = getSessionRuntimeResource(session);
  const provider = await getProviderRecordForSession(session);

  if (!resource || resource.kind !== "proxmox-vm" || !provider) {
    return;
  }

  try {
    await stopProxmoxVirtualMachine(session);
  } catch (error) {
    if (!String(error.message || "").includes("VM is not running")) {
      throw error;
    }
  }

  const task = await proxmoxRequest(
    provider,
    `/api2/json/nodes/${encodeURIComponent(resource.node)}/qemu/${encodeURIComponent(
      resource.vmid
    )}?purge=1&destroy-unreferenced-disks=1`,
    {
      method: "DELETE",
    }
  );
  await waitForProxmoxTask(provider, resource.node, task);
}

async function stopRuntimeResource(session) {
  const providerDriver = session?.resolvedRuntimeSpec?.provider?.driver;

  if (providerDriver === "proxmox") {
    await stopProxmoxVirtualMachine(session);
    return;
  }

  await removeSessionContainers(session);
}

async function deleteRuntimeResource(session) {
  const providerDriver = session?.resolvedRuntimeSpec?.provider?.driver;

  if (providerDriver === "proxmox") {
    await deleteProxmoxVirtualMachine(session);
    return;
  }

  await removeSessionContainers(session);
}

function isActiveSessionState(state) {
  return ["ready", "running", "launching", "building"].includes(state);
}

function isInactiveSessionState(state) {
  return ["stopped", "error"].includes(state);
}

function getSessionAgeHours(session) {
  const createdAt = Date.parse(session.createdAt || "");

  if (Number.isNaN(createdAt)) {
    return null;
  }

  return (Date.now() - createdAt) / (1000 * 60 * 60);
}

function isStaleProvisioningSession(session) {
  if (!["building", "launching"].includes(session.state)) {
    return false;
  }

  const updatedAt = Date.parse(session.updatedAt || session.createdAt || "");

  if (Number.isNaN(updatedAt)) {
    return false;
  }

  return Date.now() - updatedAt >= staleProvisioningSessionMs;
}

async function stopSessionRecord(session) {
  await updateSession(session.id, {
    state: "stopping",
    statusDetail: "Stopping workstation runtime...",
  });

  await stopRuntimeResource(session);

  const patched = await updateSession(session.id, {
    state: "stopped",
    statusDetail: "Session stopped.",
    containerId: null,
    containerName: null,
    connection: null,
  });

  return patched.payload.session || null;
}

async function deleteSessionWithContainers(session) {
  await deleteRuntimeResource(session);
  const deleted = await deleteSessionRecord(session.id);
  return deleted.payload.session || null;
}

async function reconcileSessionContainers() {
  if (cleanupInProgress) {
    return {
      skipped: true,
      reason: "cleanup already in progress",
    };
  }

  cleanupInProgress = true;

  try {
    const [sessionResponse, managedContainers] = await Promise.all([
      listAllSessions(),
      listManagedContainers(),
    ]);

    const sessions = sessionResponse.payload.sessions || [];
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    let removedOrphanedContainers = 0;
    let normalizedSessions = 0;
    let activeTrackedContainers = 0;

    for (const session of sessions) {
      if (!isStaleProvisioningSession(session)) {
        continue;
      }

      await deleteRuntimeResource(session);
      await updateSession(session.id, {
        state: "error",
        statusDetail:
          "Provisioning timed out. Remove this session and launch a new one.",
        containerId: null,
        containerName: null,
        connection: null,
      });
      normalizedSessions += 1;
    }

    for (const container of managedContainers) {
      const session = container.sessionId
        ? sessionsById.get(container.sessionId)
        : null;

      if (!session) {
        await removeRuntimeContainer(container.id);
        removedOrphanedContainers += 1;
        continue;
      }

      if (["stopped", "error"].includes(session.state)) {
        await removeRuntimeContainer(container.id);
        removedOrphanedContainers += 1;

        await updateSession(session.id, {
          containerId: null,
          containerName: null,
          connection: null,
          statusDetail:
            session.state === "stopped"
              ? session.statusDetail || "Session stopped."
              : session.statusDetail || "Session failed.",
        });
        normalizedSessions += 1;
        continue;
      }

      activeTrackedContainers += 1;
    }

    await pruneDanglingRuntimeImages();

    const summary = {
      skipped: false,
      totalSessions: sessions.length,
      totalManagedContainers: managedContainers.length,
      activeTrackedContainers,
      removedOrphanedContainers,
      normalizedSessions,
    };

    if (removedOrphanedContainers > 0 || normalizedSessions > 0) {
      console.log(
        `workspace cleanup removed ${removedOrphanedContainers} containers and normalized ${normalizedSessions} sessions`
      );
    }

    return summary;
  } catch (error) {
    console.error("workspace cleanup failed", error.message);
    throw error;
  } finally {
    cleanupInProgress = false;
  }
}

async function provisionSession(sessionId, userId, runtimeSpec) {
  try {
    let lastProgressMessage = "";
    let lastProgressAt = 0;
    const reportBuildProgress = async (message) => {
      const nextMessage = String(message || "").trim();

      if (!nextMessage) {
        return;
      }

      const now = Date.now();
      if (
        nextMessage === lastProgressMessage ||
        now - lastProgressAt < 1500
      ) {
        return;
      }

      lastProgressMessage = nextMessage;
      lastProgressAt = now;

      await updateSession(sessionId, {
        state: "building",
        statusDetail: nextMessage,
      });
    };

    if (runtimeSpec.provider?.driver === "proxmox") {
      await updateSession(sessionId, {
        state: "building",
        statusDetail: "Preparing Proxmox virtual machine...",
      });

      const vmRuntime = await provisionProxmoxVirtualMachine(
        sessionId,
        userId,
        runtimeSpec,
        reportBuildProgress
      );

      await updateSession(sessionId, {
        state: vmRuntime.state,
        statusDetail: vmRuntime.statusDetail,
        connection: vmRuntime.connection,
        resolvedRuntimeSpec: {
          ...sanitizeRuntimeSpecForPersistence(runtimeSpec),
          proxmoxAutoinstall: vmRuntime.autoinstall || runtimeSpec.proxmoxAutoinstall || null,
          provisionedResource: vmRuntime.provisionedResource,
        },
        lifecycleCapabilities: {
          stop: true,
          restart: false,
          hibernate: true,
          resume: false,
        },
      });
      return;
    }

    await updateSession(sessionId, {
      state: "building",
      statusDetail: "Preparing runtime image...",
    });

    const preparedImage = await ensureRuntimeImage(runtimeSpec, reportBuildProgress);

    await updateSession(sessionId, {
      state: "launching",
      statusDetail:
        preparedImage.strategy === "build"
          ? "Launching workstation from freshly built image..."
          : "Launching workstation container...",
    });

    const runtime = await launchRuntimeContainer(sessionId, userId, runtimeSpec);
    await waitForRuntimeReady(runtime, runtimeSpec);
    const connectionUrl = `http://localhost:${runtime.hostPort}${runtimeSpec.runtime.connectionPath}`;

    await updateSession(sessionId, {
      state: "ready",
      statusDetail: "Session is ready.",
      containerId: runtime.containerId,
      containerName: runtime.containerName,
      connection: {
        type: "browser",
        url: connectionUrl,
      },
      resolvedRuntimeSpec: sanitizeRuntimeSpecForPersistence(runtimeSpec),
      lifecycleCapabilities: {
        stop: true,
        restart: false,
        hibernate: false,
        resume: false,
      },
    });
  } catch (error) {
    await updateSession(sessionId, {
      state: "error",
      statusDetail: error.message,
    });
  }
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    json(res, 400, { error: "Invalid request" });
    return;
  }

  const requestUrl = getLocalRequestUrl(req);
  const pathname = requestUrl.pathname;

  if (req.method === "GET" && pathname === "/health") {
    json(res, 200, {
      service: "workspace-service",
      status: "ok",
      dependencies: {
        dataServiceUrl,
        runtimeSourceRoot,
      },
    });
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/v1/install-seeds/")) {
    const parts = pathname.split("/").filter(Boolean);
    const sessionId = parts[2];
    const token = parts[3];
    const kind = parts[4];

    if (!sessionId || !["meta-data", "user-data"].includes(kind)) {
      text(res, 404, "Not found\n");
      return;
    }

    try {
      const session = await getSessionById(sessionId);
      const autoinstall = session?.resolvedRuntimeSpec?.proxmoxAutoinstall || null;
      const provider = session?.resolvedRuntimeSpec?.providerRecord || null;

      if (!session || !autoinstall || !provider || token !== autoinstall.installToken) {
        text(res, 404, "Not found\n");
        return;
      }

      console.log(`served install seed ${kind} for session ${sessionId}`);

      if (kind === "meta-data") {
        text(res, 200, buildAutoinstallMetaData(sessionId, session.resolvedRuntimeSpec));
        return;
      }

      text(
        res,
        200,
        buildAutoinstallUserData(sessionId, session.resolvedRuntimeSpec, provider),
        "text/yaml; charset=utf-8"
      );
    } catch (error) {
      text(res, 500, `${error.message}\n`);
    }
    return;
  }

  if (req.method === "GET" && pathname === "/v1/workspaces/catalog") {
    try {
      const catalog = loadCatalog();
      const providers = await listProviders();
      json(res, 200, {
        version: catalog.version || 1,
        machineTypes: catalog.machineTypes || defaultMachineTypes(),
        machineProviders: providers
          .filter((entry) => entry.enabled)
          .map((entry) => sanitizeProviderRecord(entry)),
        distributions: catalog.distributions || [],
        interfaces: catalog.interfaces || [],
        instanceSizes: catalog.instanceSizes || [],
        installOptions: catalog.installOptions || {},
        runtimeProfiles: catalog.runtimeProfiles || [],
        policies: {
          defaultMachineTypeId:
            catalog.policies?.defaultMachineTypeId || "container",
          ...catalog.policies,
        },
      });
    } catch (error) {
      json(res, 502, {
        error: "Unable to load workspace catalog",
        detail: error.message,
      });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/v1/admin/cleanup") {
    const authorization = req.headers.authorization || "";
    const identity = verifyToken(authorization);

    if (!identity) {
      json(res, 401, { error: "Missing bearer token" });
      return;
    }

    if (!isAdminIdentity(identity)) {
      json(res, 403, { error: "Admin access required" });
      return;
    }

    try {
      const summary = await reconcileSessionContainers();
      json(res, 200, {
        cleanup: {
          requestedBy: identity.username,
          requestedAt: new Date().toISOString(),
          ...summary,
        },
      });
    } catch (error) {
      json(res, 502, {
        error: "Unable to run cleanup",
        detail: error.message,
      });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/v1/admin/sessions") {
    const authorization = req.headers.authorization || "";
    const identity = verifyToken(authorization);

    if (!identity) {
      json(res, 401, { error: "Missing bearer token" });
      return;
    }

    if (!isAdminIdentity(identity)) {
      json(res, 403, { error: "Admin access required" });
      return;
    }

    try {
      const response = await listAllSessions();
      json(res, response.statusCode, response.payload);
    } catch (error) {
      json(res, 502, {
        error: "Unable to load admin sessions",
        detail: error.message,
      });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/v1/admin/sessions/stop-all") {
    const authorization = req.headers.authorization || "";
    const identity = verifyToken(authorization);

    if (!identity) {
      json(res, 401, { error: "Missing bearer token" });
      return;
    }

    if (!isAdminIdentity(identity)) {
      json(res, 403, { error: "Admin access required" });
      return;
    }

    try {
      const body = await readRequestBody(req);
      const request = body ? JSON.parse(body) : {};
      const dryRun = Boolean(request.dryRun);
      const response = await listAllSessions();
      const sessions = response.payload.sessions || [];
      const candidates = sessions.filter((session) => isActiveSessionState(session.state));
      let stoppedCount = 0;

      if (!dryRun) {
        for (const session of candidates) {
          await stopSessionRecord(session);
          stoppedCount += 1;
        }
      }

      const cleanupSummary = dryRun
        ? null
        : await reconcileSessionContainers();

      json(res, 200, {
        result: {
          action: "stop-all",
          requestedBy: identity.username,
          requestedAt: new Date().toISOString(),
          dryRun,
          candidateCount: candidates.length,
          stoppedCount,
          cleanup: cleanupSummary,
        },
      });
    } catch (error) {
      json(res, 502, {
        error: "Unable to stop active sessions",
        detail: error.message,
      });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/v1/admin/sessions/remove-inactive") {
    const authorization = req.headers.authorization || "";
    const identity = verifyToken(authorization);

    if (!identity) {
      json(res, 401, { error: "Missing bearer token" });
      return;
    }

    if (!isAdminIdentity(identity)) {
      json(res, 403, { error: "Admin access required" });
      return;
    }

    try {
      const body = await readRequestBody(req);
      const request = body ? JSON.parse(body) : {};
      const dryRun = Boolean(request.dryRun);
      const olderThanHours =
        request.olderThanHours === undefined || request.olderThanHours === null
          ? null
          : Number(request.olderThanHours);
      const response = await listAllSessions();
      const sessions = response.payload.sessions || [];
      const candidates = sessions.filter((session) => {
        if (!isInactiveSessionState(session.state)) {
          return false;
        }

        if (olderThanHours === null || Number.isNaN(olderThanHours)) {
          return true;
        }

        const ageHours = getSessionAgeHours(session);
        return ageHours !== null && ageHours >= olderThanHours;
      });
      let removedCount = 0;

      if (!dryRun) {
        for (const session of candidates) {
          await deleteSessionWithContainers(session);
          removedCount += 1;
        }
      }

      const cleanupSummary = dryRun
        ? null
        : await reconcileSessionContainers();

      json(res, 200, {
        result: {
          action: "remove-inactive",
          requestedBy: identity.username,
          requestedAt: new Date().toISOString(),
          dryRun,
          olderThanHours,
          candidateCount: candidates.length,
          removedCount,
          cleanup: cleanupSummary,
        },
      });
    } catch (error) {
      json(res, 502, {
        error: "Unable to remove inactive sessions",
        detail: error.message,
      });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/v1/workspaces/launch") {
    const authorization = req.headers.authorization || "";
    const identity = verifyToken(authorization);

    if (!identity) {
      json(res, 401, { error: "Missing bearer token" });
      return;
    }

    const body = await readRequestBody(req);
    const request = body ? JSON.parse(body) : {};
    const catalog = loadCatalog();
    const providers = await listProviders();
    const selection = resolveCatalogSelections(catalog, request);
    const providerSelection = resolveProviderSelection(catalog, providers, request);

    if (!providerSelection.machineType || !providerSelection.provider) {
      json(res, 400, {
        error: "Unsupported machine provider selection",
        requested: {
          machineTypeId: providerSelection.machineTypeId,
          providerId: providerSelection.providerId,
        },
      });
      return;
    }

    if (
      !selection.distribution ||
      !selection.runtimeInterface ||
      !selection.instanceSize ||
      !selection.runtimeProfile
    ) {
      json(res, 400, {
        error: "Unsupported runtime selection",
        requested: {
          distributionId: selection.distributionId,
          interfaceId: selection.interfaceId,
          instanceSizeId: selection.instanceSizeId,
          machineTypeId: providerSelection.machineTypeId,
          providerId: providerSelection.providerId,
        },
      });
      return;
    }

    try {
      const sessionId = crypto.randomUUID();
      const installConfig = resolveInstallConfig(catalog, request, identity);
      const runtimeSpec = buildRuntimeSpec(selection, installConfig);
      const internalRuntimeSpec = buildRuntimeSpec(selection, installConfig);
      const initialStatusDetail =
        providerSelection.provider.driver === "proxmox"
          ? "Preparing Proxmox virtual machine..."
          : "Preparing runtime image...";
      for (const spec of [runtimeSpec, internalRuntimeSpec]) {
        spec.machineTypeId = providerSelection.machineType.id;
        spec.provider = {
          id: providerSelection.provider.id,
          name: providerSelection.provider.name,
          driver: providerSelection.provider.driver,
          kind: providerSelection.provider.kind,
          scope: providerSelection.provider.scope,
        };
      }
      internalRuntimeSpec.providerRecord = providerSelection.provider;
      runtimeSpec.providerRecord = sanitizeProviderRecord(providerSelection.provider);
      const createSessionResponse = await forwardJson(
        "/v1/sessions",
        "POST",
        JSON.stringify({
          id: sessionId,
          userId: identity.sub,
          desktopEnvironment: selection.runtimeInterface.id,
          distributionId: selection.distribution.id,
          interfaceId: selection.runtimeInterface.id,
          instanceSizeId: selection.instanceSize.id,
          machineTypeId: providerSelection.machineType.id,
          providerId: providerSelection.provider.id,
          installConfig,
          profileId: selection.runtimeProfile.id,
          state: "building",
          statusDetail: initialStatusDetail,
          resolvedRuntimeSpec: runtimeSpec,
          lifecycleCapabilities: {
            stop: true,
            restart: false,
            hibernate: providerSelection.machineType.id === "virtual-machine",
            resume: false,
          },
        })
      );

      if (createSessionResponse.statusCode !== 201) {
        json(res, 502, {
          error: "Unable to persist session",
          detail: createSessionResponse.payload,
        });
        return;
      }

      if (
        providerSelection.provider.driver === "docker" &&
        providerSelection.machineType.id === "container"
      ) {
        provisionSession(sessionId, identity.sub, internalRuntimeSpec);
      } else if (
        providerSelection.provider.driver === "proxmox" &&
        providerSelection.machineType.id === "virtual-machine"
      ) {
        provisionSession(sessionId, identity.sub, internalRuntimeSpec);
      } else {
        updateSession(sessionId, {
          state: "error",
          statusDetail:
            `Provider plugin '${providerSelection.provider.name}' is configured, but VM provisioning is not implemented yet in this runtime.`,
        }).catch(() => {});
      }

      json(res, 202, {
        sessionId,
        state: "building",
        statusDetail: initialStatusDetail,
        distributionId: selection.distribution.id,
        interfaceId: selection.runtimeInterface.id,
        instanceSizeId: selection.instanceSize.id,
        machineTypeId: providerSelection.machineType.id,
        providerId: providerSelection.provider.id,
        installConfig,
        desktopEnvironment: selection.runtimeInterface.id,
        connection: null,
        runtimePlan: {
          profileId: selection.runtimeProfile.id,
          image: runtimeSpec.image,
          protocol: runtimeSpec.protocol,
          resources: runtimeSpec.resources,
          machineType: providerSelection.machineType,
          provider: runtimeSpec.provider,
          launchOrigin: publicBaseUrl,
        },
      });
    } catch (error) {
      json(res, 502, {
        error: "Unable to create workstation runtime",
        detail: error.message,
      });
    }
    return;
  }

  if (
    req.method === "POST" &&
    pathname.startsWith("/v1/workspaces/") &&
    pathname.endsWith("/stop")
  ) {
    const authorization = req.headers.authorization || "";
    const identity = verifyToken(authorization);

    if (!identity) {
      json(res, 401, { error: "Missing bearer token" });
      return;
    }

    const sessionId = pathname.split("/").filter(Boolean)[2];

    try {
      const response = await getSession(sessionId);
      const session = response.payload.session;

      if (response.statusCode !== 200 || !session) {
        json(res, 404, { error: "Session not found" });
        return;
      }

      if (session.userId !== identity.sub) {
        json(res, 403, { error: "Forbidden" });
        return;
      }

      const stoppedSession = await stopSessionRecord(session);
      json(res, 200, { session: stoppedSession });
    } catch (error) {
      json(res, 502, {
        error: "Unable to stop workstation",
        detail: error.message,
      });
    }
    return;
  }

  if (
    req.method === "DELETE" &&
    pathname.startsWith("/v1/workspaces/")
  ) {
    const authorization = req.headers.authorization || "";
    const identity = verifyToken(authorization);

    if (!identity) {
      json(res, 401, { error: "Missing bearer token" });
      return;
    }

    const sessionId = pathname.split("/").filter(Boolean)[2];

    try {
      const response = await getSession(sessionId);
      const session = response.payload.session;

      if (response.statusCode !== 200 || !session) {
        json(res, 404, { error: "Session not found" });
        return;
      }

      if (session.userId !== identity.sub) {
        json(res, 403, { error: "Forbidden" });
        return;
      }

      const deletedSession = await deleteSessionWithContainers(session);
      json(res, 200, { session: deletedSession });
    } catch (error) {
      json(res, 502, {
        error: "Unable to remove workstation",
        detail: error.message,
      });
    }
    return;
  }

  json(res, 404, { error: "Not found" });
});

server.listen(port, () => {
  console.log(`workspace-service listening on ${port}`);
  reconcileSessionContainers();

  if (cleanupIntervalMs > 0) {
    setInterval(reconcileSessionContainers, cleanupIntervalMs);
  }
});
