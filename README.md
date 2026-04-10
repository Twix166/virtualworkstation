# Virtual Workstation

Declarative Docker-based scaffold for a microservices virtual workstation platform. The stack now provides:

- A web frontend where users can sign in, register, and launch browser-based Linux sessions
- A dedicated Image Management page for Proxmox installer ISOs and reusable VM image profiles
- An API gateway that serves the frontend and brokers service calls
- An auth service that issues signed bearer tokens for persisted accounts
- A data service that persists users, profiles, and workstation session records
- A workspace service that resolves the selected distro and interface into a real Docker runtime image per session
- A provider/plugin control plane for Docker and future VM-backed execution providers
- Distro-backed XFCE desktop images exposed through noVNC in the browser
- Distro-backed CLI terminal images exposed through `shellinabox` in the browser

## Architecture

### Services

- `web/client`: Browser UI for login and session launch
- `web/client/images`: Browser UI for Proxmox ISO inventory and VM image profiles
- `services/api-gateway`: Entry point for browser traffic and service fan-out
- `services/auth-service`: User authentication and token issuance
- `services/data-service`: User/profile/session persistence
- `services/workspace-service`: Workspace launch orchestration backed by a catalog
- `web/client/admin`: Dedicated admin console for provider configuration and operations
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
- detects an existing install and offers `reuse`, `repair`, or `clean reinstall` behavior
- runs `docker compose up -d --build`

Then open:

- `http://localhost:${API_GATEWAY_PORT}` for the control plane UI
- `http://localhost:${API_GATEWAY_PORT}/images` for image management
- `http://localhost:${API_GATEWAY_PORT}/admin` for the admin console

If `8080` is already in use on your machine, change `API_GATEWAY_PORT` in `.env` before starting the stack.

The first launch of a distro/interface combination may take longer because the workspace service may need to pull or build the runtime image before the session can start.

## Declarative Design

- Docker Compose defines the entire topology.
- `config/workspace-catalog.json` declares which distributions, interfaces, and sizes are available.
- Provider records are persisted separately from the catalog so execution backends can be enabled, disabled, and configured by administrators.
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
- Proxmox-backed provider settings and reusable image profiles are persisted separately from session history.

## Current Admin UX

- The main application handles sign-in, launch, and user session management.
- The admin console at `/admin` is used for provider configuration, cleanup, and platform operations.
- The image management screen at `/images` is used to:
  - review Proxmox ISO inventory
  - upload local ISOs
  - import ISOs from remote URLs
  - delete ISOs from configured Proxmox storage
  - define reusable unattended-install image profiles for VM launches

## Current VM / Proxmox Flow

- Proxmox providers can be configured from the admin console.
- The session launcher supports both container-backed sessions and Proxmox VM-backed sessions.
- VM launches support install-time configuration for locale, keyboard layout, timezone, and hostname.
- Image profiles can be selected during VM launch to apply ISO choice, unattended install defaults, and extra packages.
- ISO uploads now stream through the control plane instead of buffering fully in memory before Proxmox transfer.
- Successful ISO uploads are reported complete only after the ISO is confirmed in Proxmox storage.
- Newly uploaded ISOs are marked as `New` in the image inventory for 24 hours.

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

## Provider Plugins

The provider/plugin model is defined in [docs/provider-plugin-design.md](/home/rbalm/code/virtualworkstation/docs/provider-plugin-design.md).

Current state:

- Docker-backed container providers are implemented
- Proxmox VM providers are configurable from the admin console and now have a working first adapter in `workspace-service`
- Local KVM/libvirt providers are configurable from the admin console
- Proxmox now supports ISO-backed unattended VM provisioning, console access, and ISO lifecycle operations from the Image Management page
- Proxmox still needs environment-specific tuning and further polish around long-running upload/install UX
- Local libvirt provisioning is not yet implemented

## Notes

- Control-plane services use only Node.js built-ins to keep the baseline easy to inspect.
- Authentication is deliberately minimal and not production-safe.
- Current release notes: [v0.4.0](/home/rbalm/code/virtualworkstation/docs/releases/v0.4.0.md)

## License

This project is licensed under the Apache License, Version 2.0. See the `LICENSE` file for details.

## Attribution

Created by Robert Balm.

This project was developed with AI-assisted tooling, including OpenAI Codex and related orchestration/tooling.

If you fork or redistribute this project, please retain existing copyright, license, and notice text.
