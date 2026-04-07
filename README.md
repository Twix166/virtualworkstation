# Virtual Workstation

Declarative Docker-based scaffold for a microservices virtual workstation platform. The stack now provides:

- A web frontend where users can sign in, register, and launch browser-based Linux sessions
- An API gateway that serves the frontend and brokers service calls
- An auth service that issues signed bearer tokens for persisted accounts
- A data service that persists users, profiles, and workstation session records
- A workspace service that resolves the selected distro and interface into a real Docker runtime image per session
- Distro-backed XFCE desktop images exposed through noVNC in the browser
- Distro-backed CLI terminal images exposed through `shellinabox` in the browser

## Architecture

### Services

- `web/client`: Browser UI for login and session launch
- `services/api-gateway`: Entry point for browser traffic and service fan-out
- `services/auth-service`: User authentication and token issuance
- `services/data-service`: User/profile/session persistence
- `services/workspace-service`: Workspace launch orchestration backed by a catalog
- `runtime-images/*/*`: Distro/interface runtime image definitions
- `config/workspace-catalog.json`: Declarative runtime inventory

### Current launch flow

1. The user opens the web app.
2. The frontend posts credentials to the API gateway.
3. The gateway forwards the request to the auth service.
4. The auth service returns a signed bearer token for the persisted user.
5. The frontend loads the user profile and prior session records from the data service.
6. The frontend requests a Linux runtime launch using that token.
7. The workspace service resolves the runtime from `config/workspace-catalog.json`.
8. The workspace service tries to pull the selected runtime image from a registry and falls back to a local build when needed.
9. The workspace service starts a new Docker container for that session.
10. The workspace service stores the session metadata in the data service.
11. The user receives a unique browser URL for that workstation container.

## Run Locally

```bash
cp .env.example .env
docker compose up --build
```

Or install and start it with a single Linux bootstrap command:

```bash
curl -fsSL https://raw.githubusercontent.com/Twix166/virtualworkstation/main/install.sh | bash
```

Useful installer overrides:

```bash
curl -fsSL https://raw.githubusercontent.com/Twix166/virtualworkstation/main/install.sh | \
  INSTALL_DIR=/opt/virtualworkstation API_GATEWAY_PORT=18080 bash
```

The installer:

- downloads the repository into `INSTALL_DIR` (`$HOME/virtualworkstation` by default)
- creates or updates `.env`
- checks Docker and Docker Compose availability
- checks whether the requested control-plane port is already in use and prompts for an alternative when needed
- runs `docker compose up -d --build`

Then open:

- `http://localhost:${API_GATEWAY_PORT}` for the control plane UI

If `8080` is already in use on your machine, change `API_GATEWAY_PORT` in `.env` before starting the stack.

The first launch of a distro/interface combination may take longer because the workspace service may need to pull or build the runtime image before the session can start.

## Declarative Design

- Docker Compose defines the entire topology.
- `config/workspace-catalog.json` declares which distributions, interfaces, and sizes are available.
- Published control-plane host ports are declared in `.env`.
- The persistent system record is stored in the `platform-data` volume and served only through `data-service`.
- Runtime images are declared in `runtime-images/` and resolved from the catalog.
- Each runtime profile can define both registry pull references and a local build fallback.
- No host packages are required beyond Docker and Compose.

## Current Persistence Model

- `demo` / `demo` is seeded automatically.
- New users are persisted with a profile and default interface preference.
- Each launched workstation is persisted as a user-owned session record.
- Each launch creates a fresh Docker container with its own published browser endpoint.
- The resolved runtime spec records which distro/interface image was actually used.

## Backlog

- Add more Linux distributions beyond Ubuntu 24.04 and Debian 12
- Add more desktop environments beyond XFCE
- Add configurable instance sizing for RAM, CPU count, and storage allocation
- Define an instance-size model similar to cloud VM flavors so users can choose from standard workstation profiles
- Add session restart so a stopped session can be started again as a fresh boot without prior in-memory state
- Add session hibernation so a workstation can be resumed with full preserved state
- Define separate lifecycle semantics for `stop`, `restart`, `hibernate`, and `resume`
- Add automatic cleanup policies for abandoned or expired sessions
- Replace SHA-256 password hashing with a stronger password storage scheme
- Add a proper scheduler if you want to spread sessions across multiple hosts
- Persist session metadata and lifecycle state
- Enforce per-user authorization and quotas
- Add websocket-aware reverse proxying in the gateway if you want the desktop to live entirely behind `:8080`

## Runtime Catalog

The backlog above is now translated into a concrete catalog and runtime model in [docs/runtime-catalog-design.md](/home/rbalm/code/virtualworkstation/docs/runtime-catalog-design.md).

That design defines:

- a multi-dimensional catalog for distributions, interfaces, and instance sizes
- runtime profiles for valid distro + interface combinations
- a normalized runtime spec resolved at launch time
- explicit lifecycle semantics for stop, restart, hibernate, and resume

## Notes

- Control-plane services use only Node.js built-ins to keep the baseline easy to inspect.
- Authentication is deliberately minimal and not production-safe.

## License

This project is licensed under the Apache License, Version 2.0. See the `LICENSE` file for details.

## Attribution

Created by Robert Balm.

This project was developed with AI-assisted tooling, including OpenAI Codex and related orchestration/tooling.

If you fork or redistribute this project, please retain existing copyright, license, and notice text.
