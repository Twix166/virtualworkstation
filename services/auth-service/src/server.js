const http = require("http");
const crypto = require("crypto");

const port = Number(process.env.PORT || 8081);
const dataServiceUrl = process.env.DATA_SERVICE_URL || "http://localhost:8083";
const authTokenSecret = process.env.AUTH_TOKEN_SECRET || "virtualworkstation-dev-secret";

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

function signToken(user) {
  const payload = Buffer.from(
    JSON.stringify({
      sub: user.id,
      username: user.username,
      displayName: user.profile.displayName,
      iat: Date.now(),
    })
  ).toString("base64url");
  const signature = crypto
    .createHmac("sha256", authTokenSecret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    json(res, 400, { error: "Invalid request" });
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    json(res, 200, {
      service: "auth-service",
      status: "ok",
      dependencies: { dataServiceUrl },
    });
    return;
  }

  if (req.method === "POST" && req.url === "/v1/auth/register") {
    try {
      const body = await readRequestBody(req);
      const response = await forwardJson("/v1/users", "POST", body);

      if (response.statusCode !== 201) {
        json(res, response.statusCode, response.payload);
        return;
      }

      const token = signToken(response.payload.user);
      json(res, 201, {
        token,
        user: response.payload.user,
      });
    } catch (error) {
      json(res, 502, { error: "Data service unavailable", detail: error.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/v1/auth/login") {
    try {
      const body = await readRequestBody(req);
      const credentials = body ? JSON.parse(body) : {};

      if (!credentials.username || !credentials.password) {
        json(res, 400, { error: "username and password are required" });
        return;
      }

      const response = await forwardJson(
        "/v1/users/lookup",
        "POST",
        JSON.stringify({ username: credentials.username })
      );

      if (response.statusCode !== 200) {
        json(res, 401, { error: "Invalid username or password" });
        return;
      }

      const passwordHash = crypto
        .createHash("sha256")
        .update(credentials.password)
        .digest("hex");

      if (response.payload.user.passwordHash !== passwordHash) {
        json(res, 401, { error: "Invalid username or password" });
        return;
      }

      const token = signToken(response.payload.user);
      json(res, 200, {
        token,
        user: {
          id: response.payload.user.id,
          username: response.payload.user.username,
          profile: response.payload.user.profile,
        },
      });
    } catch (error) {
      json(res, 502, { error: "Data service unavailable", detail: error.message });
    }
    return;
  }

  json(res, 404, { error: "Not found" });
});

server.listen(port, () => {
  console.log(`auth-service listening on ${port}`);
});
