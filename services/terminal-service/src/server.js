const http = require("http");
const crypto = require("crypto");
const { Client } = require("ssh2");
const WebSocket = require("ws");

const port = Number(process.env.PORT || 8084);
const authTokenSecret = process.env.AUTH_TOKEN_SECRET || "virtualworkstation-dev-secret";
const dataServiceUrl = process.env.DATA_SERVICE_URL || "http://localhost:8083";

const terminalSessions = new Map();

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

function verifyToken(tokenValue) {
  const [payload, signature] = String(tokenValue || "").split(".");

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

function sanitizeSession(entry) {
  return {
    id: entry.id,
    userId: entry.userId,
    profileId: entry.profileId,
    host: {
      name: entry.host.name,
      hostname: entry.host.hostname,
      port: entry.host.port,
    },
    username: entry.credential.username,
    state: entry.state,
    createdAt: entry.createdAt,
    lastConnectedAt: entry.lastConnectedAt || null,
  };
}

async function appendEvent(event) {
  await forwardJson("/v1/platform/events", "POST", JSON.stringify(event)).catch(() => {});
}

async function loadPersistedSession(sessionId) {
  const response = await forwardJson(`/v1/sessions/${encodeURIComponent(sessionId)}`, "GET");

  if (response.statusCode !== 200) {
    return null;
  }

  return response.payload.session || null;
}

async function authorizeWebSocket(requestUrl) {
  const token = requestUrl.searchParams.get("token") || "";
  const identity = verifyToken(token);

  if (!identity) {
    return { allowed: false, code: 401, reason: "Missing or invalid token" };
  }

  const sessionId = requestUrl.pathname.split("/").filter(Boolean)[2];
  const terminalSession = terminalSessions.get(sessionId);

  if (!terminalSession) {
    return { allowed: false, code: 404, reason: "Terminal session not found" };
  }

  const persistedSession = await loadPersistedSession(sessionId);

  if (!persistedSession) {
    return { allowed: false, code: 404, reason: "Workspace session not found" };
  }

  if (persistedSession.userId !== identity.sub && !isAdminIdentity(identity)) {
    return { allowed: false, code: 403, reason: "Forbidden" };
  }

  return { allowed: true, identity, terminalSession };
}

function sendText(ws, text) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "output", data: text }));
  }
}

function sendStatus(ws, text) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "status", data: text }));
  }
}

function openSshTerminal(ws, terminalSession, identity) {
  const conn = new Client();
  let stream = null;

  terminalSession.state = "connecting";
  terminalSession.lastConnectedAt = new Date().toISOString();
  sendStatus(ws, `Connecting to ${terminalSession.host.hostname}:${terminalSession.host.port}...`);

  conn.on("ready", () => {
    terminalSession.state = "connected";
    sendStatus(ws, "SSH connection established.");

    conn.shell(
      {
        term: "xterm-256color",
        rows: 32,
        cols: 120,
      },
      (error, nextStream) => {
        if (error) {
          sendStatus(ws, `Unable to open SSH shell: ${error.message}`);
          ws.close();
          conn.end();
          return;
        }

        stream = nextStream;
        stream.on("data", (data) => {
          sendText(ws, data.toString("utf8"));
        });
        stream.stderr?.on("data", (data) => {
          sendText(ws, data.toString("utf8"));
        });
        stream.on("close", () => {
          terminalSession.state = "closed";
          sendStatus(ws, "SSH shell closed.");
          ws.close();
          conn.end();
        });

        if (terminalSession.shell) {
          stream.write(`${terminalSession.shell}\n`);
        }

        appendEvent({
          level: "info",
          code: "ssh.session.connected",
          message: `SSH terminal connected to ${terminalSession.host.name}`,
          scope: "ssh",
          resourceId: terminalSession.id,
          resourceType: "ssh-session",
          metadata: {
            username: identity.username,
            host: terminalSession.host.hostname,
            sshUsername: terminalSession.credential.username,
          },
        });
      }
    );
  });

  conn.on("error", (error) => {
    terminalSession.state = "error";
    sendStatus(ws, `SSH error: ${error.message}`);
    appendEvent({
      level: "error",
      code: "ssh.session.error",
      message: error.message,
      scope: "ssh",
      resourceId: terminalSession.id,
      resourceType: "ssh-session",
    });
    ws.close();
  });

  conn.on("close", () => {
    if (terminalSession.state !== "error") {
      terminalSession.state = "closed";
    }
  });

  ws.on("message", (message) => {
    let payload = null;
    try {
      payload = JSON.parse(message.toString("utf8"));
    } catch (error) {
      return;
    }

    if (payload.type === "input" && stream) {
      stream.write(String(payload.data || ""));
    }

    if (payload.type === "resize" && stream) {
      stream.setWindow(Number(payload.rows || 32), Number(payload.cols || 120), 0, 0);
    }
  });

  ws.on("close", () => {
    if (stream) {
      stream.end();
    }
    conn.end();
  });

  conn.connect({
    host: terminalSession.host.hostname,
    port: Number(terminalSession.host.port || 22),
    username: terminalSession.credential.username,
    privateKey: terminalSession.credential.privateKey,
    passphrase: terminalSession.credential.passphrase || undefined,
    readyTimeout: 20000,
    keepaliveInterval: 15000,
    algorithms: {
      serverHostKey: ["ssh-ed25519", "ecdsa-sha2-nistp256", "rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"],
    },
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    json(res, 400, { error: "Invalid request" });
    return;
  }

  const requestUrl = new URL(req.url, "http://terminal-service.local");

  if (req.method === "GET" && requestUrl.pathname === "/health") {
    json(res, 200, { service: "terminal-service", status: "ok" });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/v1/terminal/sessions") {
    const body = await readRequestBody(req);
    const request = body ? JSON.parse(body) : {};

    if (!request.id || !request.userId || !request.profile?.host || !request.profile?.credential) {
      json(res, 400, { error: "id, userId, profile.host, and profile.credential are required" });
      return;
    }

    const entry = {
      id: request.id,
      userId: request.userId,
      profileId: request.profile.id,
      host: request.profile.host,
      credential: request.profile.credential,
      shell: request.profile.shell || "",
      state: "ready",
      createdAt: new Date().toISOString(),
    };

    terminalSessions.set(entry.id, entry);
    json(res, 201, { terminalSession: sanitizeSession(entry) });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/v1/terminal/sessions") {
    json(res, 200, {
      terminalSessions: Array.from(terminalSessions.values()).map(sanitizeSession),
    });
    return;
  }

  if (
    req.method === "DELETE" &&
    requestUrl.pathname.startsWith("/v1/terminal/sessions/")
  ) {
    const sessionId = requestUrl.pathname.split("/").filter(Boolean)[3];
    const deleted = terminalSessions.delete(sessionId);
    json(res, deleted ? 200 : 404, {
      deleted,
      sessionId,
    });
    return;
  }

  json(res, 404, { error: "Not found" });
});

const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", async (req, socket, head) => {
  const requestUrl = new URL(req.url || "", "http://terminal-service.local");

  if (!requestUrl.pathname.startsWith("/v1/terminal-ws/")) {
    socket.destroy();
    return;
  }

  try {
    const authorization = await authorizeWebSocket(requestUrl);

    if (!authorization.allowed) {
      socket.write(
        `HTTP/1.1 ${authorization.code} ${authorization.reason}\r\nConnection: close\r\n\r\n`
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      openSshTerminal(ws, authorization.terminalSession, authorization.identity);
    });
  } catch (error) {
    socket.write(`HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }
});

server.listen(port, () => {
  console.log(`terminal-service listening on ${port}`);
});
