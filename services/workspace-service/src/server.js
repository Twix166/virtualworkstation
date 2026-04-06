const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const port = Number(process.env.PORT || 8082);
const publicBaseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:8080";
const dataServiceUrl = process.env.DATA_SERVICE_URL || "http://localhost:8083";
const authTokenSecret = process.env.AUTH_TOKEN_SECRET || "virtualworkstation-dev-secret";
const desktopImage = process.env.DESKTOP_IMAGE || "virtualworkstation/desktop-xfce:local";
const workspaceCatalogPath =
  process.env.WORKSPACE_CATALOG_PATH ||
  path.resolve(__dirname, "../../../config/workspace-catalog.json");

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
    image: selection.runtimeProfile.image || desktopImage,
    protocol: selection.runtimeInterface.protocol,
    resources: selection.instanceSize.resources,
    runtime: {
      mode: selection.runtimeProfile.launch.mode,
      exposedPort: selection.runtimeProfile.launch.exposedPort,
      connectionPath: selection.runtimeProfile.launch.connectionPath,
    },
  };
}

async function launchDesktopContainer(sessionId, userId, runtimeSpec) {
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

async function deleteSessionRecord(sessionId) {
  return forwardJson(`/v1/sessions/${sessionId}`, "DELETE");
}

async function removeDesktopContainer(containerIdOrName) {
  if (!containerIdOrName) {
    return;
  }

  try {
    await execDocker(["rm", "-f", containerIdOrName]);
  } catch (error) {
    if (!error.message.includes("No such container")) {
      throw error;
    }
  }
}

async function provisionSession(sessionId, userId, runtimeSpec) {
  try {
    await updateSession(sessionId, {
      state: "launching",
      statusDetail: "Launching workstation container...",
    });

    const runtime = await launchDesktopContainer(sessionId, userId, runtimeSpec);
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
        desktopImage,
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
          statusDetail: "Preparing virtual workstation image...",
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
        statusDetail: "Preparing virtual workstation image...",
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
        error: "Unable to create desktop container",
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

      await updateSession(sessionId, {
        state: "stopping",
        statusDetail: "Stopping workstation container...",
      });

      await removeDesktopContainer(session.containerId || session.containerName);

      const patched = await updateSession(sessionId, {
        state: "stopped",
        statusDetail: "Session stopped.",
        connection: null,
      });

      json(res, 200, patched.payload);
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

      await removeDesktopContainer(session.containerId || session.containerName);
      const deleted = await deleteSessionRecord(sessionId);
      json(res, deleted.statusCode, deleted.payload);
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
});
