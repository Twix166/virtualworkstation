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
      sessions: [],
    };
    fs.writeFileSync(dataFilePath, JSON.stringify(database, null, 2));
  }
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
