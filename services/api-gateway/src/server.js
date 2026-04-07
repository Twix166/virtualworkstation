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

  const requestedPath = req.url === "/" ? "/index.html" : req.url;
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
