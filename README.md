# Virtual Workstation

Declarative Docker-based scaffold for a microservices virtual workstation platform. The stack now provides:

- A web frontend where users can sign in, register, and launch desktops
- An API gateway that serves the frontend and brokers service calls
- An auth service that issues signed bearer tokens for persisted accounts
- A data service that persists users, profiles, and workstation session records
- A workspace service that launches a new Docker desktop container per session
- An XFCE desktop image exposed through noVNC in the browser

## Architecture

### Services

- `web/client`: Browser UI for login and desktop launch
- `services/api-gateway`: Entry point for browser traffic and service fan-out
- `services/auth-service`: User authentication and token issuance
- `services/data-service`: User/profile/session persistence
- `services/workspace-service`: Workspace launch orchestration backed by a catalog
- `desktop-images/xfce`: Browser-streamed Linux desktop image definition
- `config/workspace-catalog.json`: Declarative desktop inventory

### Current launch flow

1. The user opens the web app.
2. The frontend posts credentials to the API gateway.
3. The gateway forwards the request to the auth service.
4. The auth service returns a signed bearer token for the persisted user.
5. The frontend loads the user profile and prior desktop sessions from the data service.
6. The frontend requests a Linux desktop launch using that token.
7. The workspace service resolves the desktop from `config/workspace-catalog.json`.
8. The workspace service starts a new Docker container for that session.
9. The workspace service stores the session metadata in the data service.
10. The user receives a unique noVNC URL for that workstation container.

## Run Locally

```bash
cp .env.example .env
docker compose up --build
```

Then open:

- `http://localhost:${API_GATEWAY_PORT}` for the control plane UI
- `http://localhost:${DESKTOP_XFCE_PORT}/vnc.html?autoconnect=true&resize=remote` for the streamed XFCE desktop

If `8080` is already in use on your machine, change `API_GATEWAY_PORT` in `.env` before starting the stack.

## Declarative Design

- Docker Compose defines the entire topology.
- `config/workspace-catalog.json` declares which desktop environments are available.
- Published host ports are declared in `.env`.
- The persistent system record is stored in the `platform-data` volume and served only through `data-service`.
- The XFCE runtime is built from `desktop-images/xfce/Dockerfile`.
- No host packages are required beyond Docker and Compose.

## Current Persistence Model

- `demo` / `demo` is seeded automatically.
- New users are persisted with a profile and default desktop preference.
- Each launched workstation is persisted as a user-owned session record.
- Each launch creates a fresh Docker container with its own published noVNC port.

## Backlog

- Add selection of different Linux distributions per session
- Add selection of different desktop environments per session
- Add CLI-only Linux session support alongside full desktop sessions
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
