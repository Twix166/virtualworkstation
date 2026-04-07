const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

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
let cleanupInProgress = false;
const imageBuildOperations = new Map();

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
    execFile("docker", args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
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

function buildRuntimeSpec(selection) {
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

async function pullRuntimeImage(targetImage, pullReferences) {
  const errors = [];

  for (const reference of pullReferences || []) {
    try {
      await execDocker(["pull", reference]);

      if (reference !== targetImage) {
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

async function buildRuntimeImageOnce(targetImage, buildSpec) {
  if (!buildSpec || !buildSpec.dockerfile) {
    throw new Error("No build definition is available for this runtime profile");
  }

  const buildArgs = ["build", "--pull", "-t", targetImage];
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

  await execDocker(buildArgs);

  return {
    strategy: "build",
    source: buildSpec.dockerfile,
  };
}

async function buildRuntimeImage(targetImage, buildSpec) {
  const existingBuild = imageBuildOperations.get(targetImage);

  if (existingBuild) {
    return existingBuild;
  }

  const buildOperation = (async () => {
    const maxAttempts = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await buildRuntimeImageOnce(targetImage, buildSpec);
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

async function ensureRuntimeImage(runtimeSpec) {
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
      return buildRuntimeImage(runtimeSpec.image, imageSource.build);
    }
  }

  if (preferLocalBuild) {
    return buildRuntimeImage(runtimeSpec.image, imageSource.build);
  }

  try {
    const pulledImage = await pullRuntimeImage(
      runtimeSpec.image,
      imageSource.pullReferences || []
    );

    if (pulledImage) {
      return pulledImage;
    }
  } catch (error) {
    if (!imageSource.build) {
      throw error;
    }
  }

  return buildRuntimeImage(runtimeSpec.image, imageSource.build);
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

async function stopSessionRecord(session) {
  await updateSession(session.id, {
    state: "stopping",
    statusDetail: "Stopping workstation container...",
  });

  await removeSessionContainers(session);

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
  await removeSessionContainers(session);
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
    await updateSession(sessionId, {
      state: "building",
      statusDetail: "Preparing runtime image...",
    });

    const preparedImage = await ensureRuntimeImage(runtimeSpec);

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
      resolvedRuntimeSpec: runtimeSpec,
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

  if (req.method === "GET" && req.url === "/health") {
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

  if (req.method === "GET" && req.url === "/v1/workspaces/catalog") {
    const catalog = loadCatalog();
    json(res, 200, {
      version: catalog.version || 1,
      distributions: catalog.distributions || [],
      interfaces: catalog.interfaces || [],
      instanceSizes: catalog.instanceSizes || [],
      runtimeProfiles: catalog.runtimeProfiles || [],
      policies: catalog.policies || {},
    });
    return;
  }

  if (req.method === "POST" && req.url === "/v1/admin/cleanup") {
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

  if (req.method === "GET" && req.url === "/v1/admin/sessions") {
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

  if (req.method === "POST" && req.url === "/v1/admin/sessions/stop-all") {
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

  if (req.method === "POST" && req.url === "/v1/admin/sessions/remove-inactive") {
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

  if (req.method === "POST" && req.url === "/v1/workspaces/launch") {
    const authorization = req.headers.authorization || "";
    const identity = verifyToken(authorization);

    if (!identity) {
      json(res, 401, { error: "Missing bearer token" });
      return;
    }

    const body = await readRequestBody(req);
    const request = body ? JSON.parse(body) : {};
    const catalog = loadCatalog();
    const selection = resolveCatalogSelections(catalog, request);

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
        },
      });
      return;
    }

    try {
      const sessionId = crypto.randomUUID();
      const runtimeSpec = buildRuntimeSpec(selection);
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
          profileId: selection.runtimeProfile.id,
          state: "building",
          statusDetail: "Preparing runtime image...",
          resolvedRuntimeSpec: runtimeSpec,
          lifecycleCapabilities: {
            stop: true,
            restart: false,
            hibernate: false,
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

      provisionSession(sessionId, identity.sub, runtimeSpec);

      json(res, 202, {
        sessionId,
        state: "building",
        statusDetail: "Preparing runtime image...",
        distributionId: selection.distribution.id,
        interfaceId: selection.runtimeInterface.id,
        instanceSizeId: selection.instanceSize.id,
        desktopEnvironment: selection.runtimeInterface.id,
        connection: null,
        runtimePlan: {
          profileId: selection.runtimeProfile.id,
          image: runtimeSpec.image,
          protocol: runtimeSpec.protocol,
          resources: runtimeSpec.resources,
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
    req.url.startsWith("/v1/workspaces/") &&
    req.url.endsWith("/stop")
  ) {
    const authorization = req.headers.authorization || "";
    const identity = verifyToken(authorization);

    if (!identity) {
      json(res, 401, { error: "Missing bearer token" });
      return;
    }

    const sessionId = req.url.split("/").filter(Boolean)[2];

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
    req.url.startsWith("/v1/workspaces/")
  ) {
    const authorization = req.headers.authorization || "";
    const identity = verifyToken(authorization);

    if (!identity) {
      json(res, 401, { error: "Missing bearer token" });
      return;
    }

    const sessionId = req.url.split("/").filter(Boolean)[2];

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
