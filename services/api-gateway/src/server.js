const http = require("http");
const fs = require("fs");
const path = require("path");

const port = Number(process.env.PORT || 8080);
const authServiceUrl = process.env.AUTH_SERVICE_URL || "http://localhost:8081";
const dataServiceUrl = process.env.DATA_SERVICE_URL || "http://localhost:8083";
const workspaceServiceUrl =
  process.env.WORKSPACE_SERVICE_URL || "http://localhost:8082";
const publicBaseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:8080";
const clientDir = path.resolve(__dirname, "../../../web/client");

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function text(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, { "Content-Type": contentType });
  res.end(body);
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

function readRequestBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function forwardJson(targetBaseUrl, route, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(route, targetBaseUrl);
    const req = http.request(
      target,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          try {
            resolve({
              statusCode: res.statusCode || 500,
              payload: responseBody ? JSON.parse(responseBody) : {},
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on("error", reject);

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

function forwardRaw(targetBaseUrl, route, method, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(route, targetBaseUrl);
    const request = http.request(
      target,
      {
        method,
        headers,
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode || 500,
            headers: response.headers,
            body: responseBody,
          });
        });
      }
    );

    request.on("error", reject);
    request.end();
  });
}

function forwardBuffer(targetBaseUrl, route, method, buffer, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(route, targetBaseUrl);
    const request = http.request(
      target,
      {
        method,
        headers,
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          try {
            resolve({
              statusCode: response.statusCode || 500,
              payload: responseBody ? JSON.parse(responseBody) : {},
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.on("error", reject);
    if (buffer?.length) {
      request.write(buffer);
    }
    request.end();
  });
}

function serveStaticFile(filePath, res) {
  const extension = path.extname(filePath);
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  };

  fs.readFile(filePath, (error, contents) => {
    if (error) {
      json(res, 404, { error: "Not found" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentTypes[extension] || "text/plain; charset=utf-8",
    });
    res.end(contents);
  });
}

function decodeBearerPayload(authorization) {
  if (!authorization.startsWith("Bearer ")) {
    return null;
  }

  try {
    return JSON.parse(
      Buffer.from(
        authorization.slice("Bearer ".length).split(".")[0],
        "base64url"
      ).toString("utf8")
    );
  } catch (error) {
    return null;
  }
}

function isAdminPayload(payload) {
  return Boolean(
    payload &&
      (payload.isAdmin || payload.role === "admin" || payload.username === "demo")
  );
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    json(res, 400, { error: "Invalid request" });
    return;
  }

  if (req.method === "GET" && req.url === "/api/health") {
    json(res, 200, {
      service: "api-gateway",
      status: "ok",
      dependencies: {
        authServiceUrl,
        dataServiceUrl,
        workspaceServiceUrl,
        publicBaseUrl,
      },
    });
    return;
  }

  if (req.method === "GET" && req.url === "/api/catalog") {
    try {
      const response = await forwardJson(
        workspaceServiceUrl,
        "/v1/workspaces/catalog",
        "GET"
      );
      json(res, response.statusCode, response.payload);
    } catch (error) {
      json(res, 502, {
        error: "Workspace catalog unavailable",
        detail: error.message,
      });
    }
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/install-seeds/")) {
    try {
      const response = await forwardRaw(
        workspaceServiceUrl,
        req.url.replace("/api", "/v1"),
        "GET"
      );
      res.writeHead(response.statusCode, {
        "Content-Type": response.headers["content-type"] || "text/plain; charset=utf-8",
      });
      res.end(response.body);
    } catch (error) {
      text(res, 502, `Workspace service unavailable: ${error.message}\n`);
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/login") {
    try {
      const body = await readRequestBody(req);
      const response = await forwardJson(
        authServiceUrl,
        "/v1/auth/login",
        "POST",
        body
      );
      json(res, response.statusCode, response.payload);
    } catch (error) {
      json(res, 502, {
        error: "Auth service unavailable",
        detail: error.message,
      });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/register") {
    try {
      const body = await readRequestBody(req);
      const response = await forwardJson(
        authServiceUrl,
        "/v1/auth/register",
        "POST",
        body
      );
      json(res, response.statusCode, response.payload);
    } catch (error) {
      json(res, 502, {
        error: "Auth service unavailable",
        detail: error.message,
      });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/me") {
    const authorization = req.headers.authorization || "";
    const payload = authorization.startsWith("Bearer ")
      ? JSON.parse(
          Buffer.from(
            authorization.slice("Bearer ".length).split(".")[0],
            "base64url"
          ).toString("utf8")
        )
      : null;

    if (!payload || !payload.sub) {
      json(res, 401, { error: "Missing bearer token" });
      return;
    }

    try {
      const response = await forwardJson(
        dataServiceUrl,
        `/v1/users/${payload.sub}/profile`,
        "GET"
      );
      json(res, response.statusCode, response.payload);
    } catch (error) {
      json(res, 502, {
        error: "Data service unavailable",
        detail: error.message,
      });
    }
    return;
  }

  if (req.method === "PATCH" && req.url === "/api/me") {
    const authorization = req.headers.authorization || "";
    const payload = authorization.startsWith("Bearer ")
      ? JSON.parse(
          Buffer.from(
            authorization.slice("Bearer ".length).split(".")[0],
            "base64url"
          ).toString("utf8")
        )
      : null;

    if (!payload || !payload.sub) {
      json(res, 401, { error: "Missing bearer token" });
      return;
    }

    try {
      const body = await readRequestBody(req);
      const response = await forwardJson(
        dataServiceUrl,
        `/v1/users/${payload.sub}/profile`,
        "PATCH",
        body
      );
      json(res, response.statusCode, response.payload);
    } catch (error) {
      json(res, 502, {
        error: "Data service unavailable",
        detail: error.message,
      });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/sessions") {
    const authorization = req.headers.authorization || "";
    const payload = authorization.startsWith("Bearer ")
      ? JSON.parse(
          Buffer.from(
            authorization.slice("Bearer ".length).split(".")[0],
            "base64url"
          ).toString("utf8")
        )
      : null;

    if (!payload || !payload.sub) {
      json(res, 401, { error: "Missing bearer token" });
      return;
    }

    try {
      const response = await forwardJson(
        dataServiceUrl,
        `/v1/users/${payload.sub}/sessions`,
        "GET"
      );
      json(res, response.statusCode, response.payload);
    } catch (error) {
      json(res, 502, {
        error: "Data service unavailable",
        detail: error.message,
      });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/admin/sessions") {
    const payload = decodeBearerPayload(req.headers.authorization || "");

    if (!isAdminPayload(payload)) {
      json(res, 403, { error: "Admin access required" });
      return;
    }

    try {
      const response = await forwardJson(
        workspaceServiceUrl,
        "/v1/admin/sessions",
        "GET",
        "",
        { Authorization: req.headers.authorization || "" }
      );
      json(res, response.statusCode, response.payload);
    } catch (error) {
      json(res, 502, {
        error: "Workspace service unavailable",
        detail: error.message,
      });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/workspaces/launch") {
    try {
      const body = await readRequestBody(req);
      const response = await forwardJson(
        workspaceServiceUrl,
        "/v1/workspaces/launch",
        "POST",
        body,
        { Authorization: req.headers.authorization || "" }
      );
      json(res, response.statusCode, response.payload);
    } catch (error) {
      json(res, 502, {
        error: "Workspace service unavailable",
        detail: error.message,
      });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/admin/cleanup") {
    const payload = decodeBearerPayload(req.headers.authorization || "");

    if (!isAdminPayload(payload)) {
      json(res, 403, { error: "Admin access required" });
      return;
    }

    try {
      const response = await forwardJson(
        workspaceServiceUrl,
        "/v1/admin/cleanup",
        "POST",
        "",
        { Authorization: req.headers.authorization || "" }
      );
      json(res, response.statusCode, response.payload);
    } catch (error) {
      json(res, 502, {
        error: "Workspace service unavailable",
        detail: error.message,
      });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/admin/sessions/stop-all") {
    const payload = decodeBearerPayload(req.headers.authorization || "");

    if (!isAdminPayload(payload)) {
      json(res, 403, { error: "Admin access required" });
      return;
    }

    try {
      const body = await readRequestBody(req);
      const response = await forwardJson(
        workspaceServiceUrl,
        "/v1/admin/sessions/stop-all",
        "POST",
        body,
        { Authorization: req.headers.authorization || "" }
      );
      json(res, response.statusCode, response.payload);
    } catch (error) {
      json(res, 502, {
        error: "Workspace service unavailable",
        detail: error.message,
      });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/admin/sessions/remove-inactive") {
    const payload = decodeBearerPayload(req.headers.authorization || "");

    if (!isAdminPayload(payload)) {
      json(res, 403, { error: "Admin access required" });
      return;
    }

    try {
      const body = await readRequestBody(req);
      const response = await forwardJson(
        workspaceServiceUrl,
        "/v1/admin/sessions/remove-inactive",
        "POST",
        body,
        { Authorization: req.headers.authorization || "" }
      );
      json(res, response.statusCode, response.payload);
    } catch (error) {
      json(res, 502, {
        error: "Workspace service unavailable",
        detail: error.message,
      });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/admin/providers") {
    const payload = decodeBearerPayload(req.headers.authorization || "");

    if (!isAdminPayload(payload)) {
      json(res, 403, { error: "Admin access required" });
      return;
    }

    try {
      const response = await forwardJson(
        dataServiceUrl,
        "/v1/platform/providers",
        "GET"
      );
      json(res, response.statusCode, response.payload);
    } catch (error) {
      json(res, 502, {
        error: "Data service unavailable",
        detail: error.message,
      });
    }
    return;
  }

  if (req.method === "PATCH" && req.url.startsWith("/api/admin/providers/")) {
    const payload = decodeBearerPayload(req.headers.authorization || "");

    if (!isAdminPayload(payload)) {
      json(res, 403, { error: "Admin access required" });
      return;
    }

    try {
      const body = await readRequestBody(req);
      const response = await forwardJson(
        dataServiceUrl,
        req.url.replace("/api/admin", "/v1/platform"),
        "PATCH",
        body
      );
      json(res, response.statusCode, response.payload);
    } catch (error) {
      json(res, 502, {
        error: "Data service unavailable",
        detail: error.message,
      });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/admin/image-profiles") {
    const payload = decodeBearerPayload(req.headers.authorization || "");

    if (!isAdminPayload(payload)) {
      json(res, 403, { error: "Admin access required" });
      return;
    }

    try {
      const response = await forwardJson(
        dataServiceUrl,
        "/v1/platform/image-profiles",
        "GET"
      );
      json(res, response.statusCode, response.payload);
    } catch (error) {
      json(res, 502, {
        error: "Data service unavailable",
        detail: error.message,
      });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/admin/image-profiles") {
    const payload = decodeBearerPayload(req.headers.authorization || "");

    if (!isAdminPayload(payload)) {
      json(res, 403, { error: "Admin access required" });
      return;
    }

    try {
      const body = await readRequestBody(req);
      const response = await forwardJson(
        dataServiceUrl,
        "/v1/platform/image-profiles",
        "POST",
        body
      );
      json(res, response.statusCode, response.payload);
    } catch (error) {
      json(res, 502, {
        error: "Data service unavailable",
        detail: error.message,
      });
    }
    return;
  }

  if (
    (req.method === "PATCH" || req.method === "DELETE") &&
    req.url.startsWith("/api/admin/image-profiles/")
  ) {
    const payload = decodeBearerPayload(req.headers.authorization || "");

    if (!isAdminPayload(payload)) {
      json(res, 403, { error: "Admin access required" });
      return;
    }

    try {
      const body = req.method === "PATCH" ? await readRequestBody(req) : "";
      const response = await forwardJson(
        dataServiceUrl,
        req.url.replace("/api/admin", "/v1/platform"),
        req.method,
        body
      );
      json(res, response.statusCode, response.payload);
    } catch (error) {
      json(res, 502, {
        error: "Data service unavailable",
        detail: error.message,
      });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/admin/proxmox/images") {
    const payload = decodeBearerPayload(req.headers.authorization || "");

    if (!isAdminPayload(payload)) {
      json(res, 403, { error: "Admin access required" });
      return;
    }

    try {
      const response = await forwardJson(
        workspaceServiceUrl,
        "/v1/admin/proxmox/images",
        "GET",
        "",
        { Authorization: req.headers.authorization || "" }
      );
      json(res, response.statusCode, response.payload);
    } catch (error) {
      json(res, 502, {
        error: "Workspace service unavailable",
        detail: error.message,
      });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/admin/proxmox/images/import-url") {
    const payload = decodeBearerPayload(req.headers.authorization || "");

    if (!isAdminPayload(payload)) {
      json(res, 403, { error: "Admin access required" });
      return;
    }

    try {
      const body = await readRequestBody(req);
      const response = await forwardJson(
        workspaceServiceUrl,
        "/v1/admin/proxmox/images/import-url",
        "POST",
        body,
        { Authorization: req.headers.authorization || "" }
      );
      json(res, response.statusCode, response.payload);
    } catch (error) {
      json(res, 502, {
        error: "Workspace service unavailable",
        detail: error.message,
      });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/admin/proxmox/images/upload") {
    const payload = decodeBearerPayload(req.headers.authorization || "");

    if (!isAdminPayload(payload)) {
      json(res, 403, { error: "Admin access required" });
      return;
    }

    try {
      const buffer = await readRequestBuffer(req);
      const response = await forwardBuffer(
        workspaceServiceUrl,
        "/v1/admin/proxmox/images/upload",
        "POST",
        buffer,
        {
          Authorization: req.headers.authorization || "",
          "Content-Type": req.headers["content-type"] || "application/octet-stream",
          "Content-Length": String(buffer.length),
          "X-Upload-Filename": req.headers["x-upload-filename"] || "",
        }
      );
      json(res, response.statusCode, response.payload);
    } catch (error) {
      json(res, 502, {
        error: "Workspace service unavailable",
        detail: error.message,
      });
    }
    return;
  }

  if (
    req.method === "DELETE" &&
    req.url.startsWith("/api/admin/proxmox/images/")
  ) {
    const payload = decodeBearerPayload(req.headers.authorization || "");

    if (!isAdminPayload(payload)) {
      json(res, 403, { error: "Admin access required" });
      return;
    }

    try {
      const response = await forwardJson(
        workspaceServiceUrl,
        req.url.replace("/api", "/v1"),
        "DELETE",
        "",
        { Authorization: req.headers.authorization || "" }
      );
      json(res, response.statusCode, response.payload);
    } catch (error) {
      json(res, 502, {
        error: "Workspace service unavailable",
        detail: error.message,
      });
    }
    return;
  }

  if (
    req.method === "POST" &&
    req.url.startsWith("/api/workspaces/") &&
    req.url.endsWith("/stop")
  ) {
    try {
      const response = await forwardJson(
        workspaceServiceUrl,
        req.url.replace("/api", "/v1"),
        "POST",
        "",
        { Authorization: req.headers.authorization || "" }
      );
      json(res, response.statusCode, response.payload);
    } catch (error) {
      json(res, 502, {
        error: "Workspace service unavailable",
        detail: error.message,
      });
    }
    return;
  }

  if (
    req.method === "DELETE" &&
    req.url.startsWith("/api/workspaces/")
  ) {
    try {
      const response = await forwardJson(
        workspaceServiceUrl,
        req.url.replace("/api", "/v1"),
        "DELETE",
        "",
        { Authorization: req.headers.authorization || "" }
      );
      json(res, response.statusCode, response.payload);
    } catch (error) {
      json(res, 502, {
        error: "Workspace service unavailable",
        detail: error.message,
      });
    }
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/sessions/")) {
    const sessionId = req.url.split("/").pop();
    const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Session ${sessionId}</title>
    <style>
      body {
        margin: 0;
        font-family: sans-serif;
        background: #0d1b2a;
        color: #e0e1dd;
        display: grid;
        place-items: center;
        min-height: 100vh;
      }
      main {
        max-width: 640px;
        padding: 2rem;
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(255, 255, 255, 0.04);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Linux Session</h1>
      <p>Session <strong>${sessionId}</strong> was created successfully.</p>
      <p>Return to the management interface at <a href="${publicBaseUrl}">${publicBaseUrl}</a> to open the session once it is ready.</p>
    </main>
  </body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  const requestedPath =
    req.url === "/"
      ? "/index.html"
      : req.url === "/admin" || req.url === "/admin/"
        ? "/admin/index.html"
        : req.url === "/images" || req.url === "/images/"
          ? "/images/index.html"
        : req.url;
  const filePath = path.join(clientDir, requestedPath);

  if (!filePath.startsWith(clientDir)) {
    json(res, 403, { error: "Forbidden" });
    return;
  }

  serveStaticFile(filePath, res);
});

server.listen(port, () => {
  console.log(`api-gateway listening on ${port}`);
});
