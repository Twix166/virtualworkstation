# Runtime Catalog Design

This document turns the current backlog into a concrete model for how virtual workstation offerings should be declared and resolved.

## Goals

- Let a user choose a Linux distribution
- Let a user choose a desktop environment
- Let a user choose CLI-only instead of a graphical desktop
- Let a user choose an instance size for RAM, CPU, and storage
- Keep the platform declarative so control-plane services resolve from config instead of hardcoded logic

## Design Summary

The catalog should stop being a single list of desktop environments and become a multi-dimensional runtime catalog with these top-level sections:

- `distributions`
- `interfaces`
- `instanceSizes`
- `runtimeProfiles`
- `policies`

The user-facing workflow becomes:

1. Select distribution
2. Select interface
3. Select instance size
4. Launch session

The workspace service should resolve those selections into one `runtimeProfile`, then generate a Docker/VM runtime spec from that profile plus the selected size.

## Catalog Schema

Suggested replacement for `config/workspace-catalog.json`:

```json
{
  "version": 2,
  "distributions": [
    {
      "id": "ubuntu-24.04",
      "name": "Ubuntu 24.04 LTS",
      "family": "ubuntu",
      "baseImage": "virtualworkstation/ubuntu-24.04-base:local",
      "default": true,
      "tags": ["lts", "general-purpose"]
    },
    {
      "id": "debian-12",
      "name": "Debian 12",
      "family": "debian",
      "baseImage": "virtualworkstation/debian-12-base:local",
      "tags": ["stable", "minimal"]
    }
  ],
  "interfaces": [
    {
      "id": "xfce",
      "name": "XFCE Desktop",
      "kind": "desktop",
      "protocol": "novnc",
      "requiresDisplay": true,
      "default": true
    },
    {
      "id": "gnome",
      "name": "GNOME Desktop",
      "kind": "desktop",
      "protocol": "novnc",
      "requiresDisplay": true
    },
    {
      "id": "cli",
      "name": "CLI Only",
      "kind": "cli",
      "protocol": "web-terminal",
      "requiresDisplay": false
    }
  ],
  "instanceSizes": [
    {
      "id": "small",
      "name": "Small",
      "resources": {
        "cpus": 2,
        "memoryMiB": 4096,
        "storageGiB": 20
      },
      "default": true
    },
    {
      "id": "medium",
      "name": "Medium",
      "resources": {
        "cpus": 4,
        "memoryMiB": 8192,
        "storageGiB": 40
      }
    },
    {
      "id": "large",
      "name": "Large",
      "resources": {
        "cpus": 8,
        "memoryMiB": 16384,
        "storageGiB": 80
      }
    }
  ],
  "runtimeProfiles": [
    {
      "id": "ubuntu-24.04-xfce",
      "distributionId": "ubuntu-24.04",
      "interfaceId": "xfce",
      "image": "virtualworkstation/ubuntu-24.04-xfce:local",
      "launch": {
        "mode": "container",
        "exposedPort": 6080,
        "connectionPath": "/vnc.html?autoconnect=true&resize=remote"
      }
    },
    {
      "id": "ubuntu-24.04-cli",
      "distributionId": "ubuntu-24.04",
      "interfaceId": "cli",
      "image": "virtualworkstation/ubuntu-24.04-cli:local",
      "launch": {
        "mode": "container",
        "exposedPort": 3000,
        "connectionPath": "/terminal"
      }
    }
  ],
  "policies": {
    "defaultDistributionId": "ubuntu-24.04",
    "defaultInterfaceId": "xfce",
    "defaultInstanceSizeId": "small"
  }
}
```

## Meaning Of Each Section

### `distributions`

Defines the OS family and base lineage.

Use this to answer:

- Which distro is the user asking for?
- Which base image pipeline should be used?
- Which distro defaults or tags apply?

### `interfaces`

Defines the user interaction model.

Examples:

- `xfce`
- `gnome`
- `kde`
- `cli`

Important distinction:

- Desktop interfaces produce a graphical session and typically use `novnc`
- CLI interfaces produce a terminal-only session and should use a terminal protocol such as `ttyd` or `wetty`

### `instanceSizes`

Defines resource tiers similar to cloud instance families.

This should be the user-facing source of truth for:

- CPU allocation
- RAM allocation
- Storage allocation

These should map directly to runtime constraints in Docker or a future VM backend.

### `runtimeProfiles`

Defines valid combinations of distribution + interface and points to the concrete runnable image.

This is the most important runtime section.

A profile should answer:

- Is this combination supported?
- Which image should be launched?
- Which protocol should be used?
- Which exposed port/path produces the user connection?

This allows the platform to support:

- Ubuntu + XFCE
- Ubuntu + CLI
- Debian + GNOME
- Fedora + KDE

without hardcoding compatibility inside the service.

### `policies`

Defines safe defaults and future catalog-level rules.

This should eventually also hold:

- allowed size overrides
- max storage caps
- hibernation support flags
- restart support flags

## Workspace Request Model

The launch request should evolve from:

```json
{
  "desktopEnvironment": "xfce"
}
```

to:

```json
{
  "distributionId": "ubuntu-24.04",
  "interfaceId": "xfce",
  "instanceSizeId": "medium"
}
```

The workspace service should then:

1. Validate each selected ID against the catalog
2. Resolve one matching `runtimeProfile`
3. Resolve one `instanceSize`
4. Build a runtime spec
5. Launch the runtime
6. Persist the resolved selections on the session record

## Runtime Spec Resolution

The workspace service should derive a normalized runtime spec before launch:

```json
{
  "profileId": "ubuntu-24.04-xfce",
  "distributionId": "ubuntu-24.04",
  "interfaceId": "xfce",
  "instanceSizeId": "medium",
  "image": "virtualworkstation/ubuntu-24.04-xfce:local",
  "protocol": "novnc",
  "resources": {
    "cpus": 4,
    "memoryMiB": 8192,
    "storageGiB": 40
  },
  "runtime": {
    "mode": "container",
    "exposedPort": 6080,
    "connectionPath": "/vnc.html?autoconnect=true&resize=remote"
  }
}
```

That spec should be persisted with the session record so restart, hibernate, scheduling, and auditing all use the same resolved state.

## Docker Mapping

For container mode, instance-size resources should map approximately like this:

- `cpus` -> `docker run --cpus`
- `memoryMiB` -> `docker run --memory`
- `storageGiB` -> mounted writable volume or quota-managed backing storage

Storage note:

- plain Docker does not give strong per-container disk quota semantics by default
- if storage size must be enforced strictly, the platform should move toward volume drivers, loopback-backed volumes, or VM-based runtimes

## Session Record Model

Persist these fields on each session:

```json
{
  "distributionId": "ubuntu-24.04",
  "interfaceId": "xfce",
  "instanceSizeId": "medium",
  "profileId": "ubuntu-24.04-xfce",
  "resolvedRuntimeSpec": {},
  "lifecycleCapabilities": {
    "stop": true,
    "restart": true,
    "hibernate": false,
    "resume": false
  }
}
```

This matters because not every runtime will support hibernation or resume.

## Lifecycle Semantics

The platform should explicitly separate these operations:

- `stop`
  Means terminate runtime and discard memory state.

- `restart`
  Means launch a fresh runtime from the stored session selections and resolved profile, but without restoring in-memory state.

- `hibernate`
  Means preserve full runtime state for later restoration.

- `resume`
  Means rehydrate from hibernated state and return the user to the prior environment.

## Compatibility Rules

Not every distribution should automatically support every interface.

Compatibility should be expressed through `runtimeProfiles`, not inferred at runtime.

Examples:

- Ubuntu may support `xfce`, `gnome`, and `cli`
- Debian may support `xfce` and `cli`
- Alpine may support `cli` only

This keeps the UI honest and prevents impossible combinations.

## Frontend Implications

The frontend should render three selectors:

- Distribution
- Interface
- Instance size

The UI should:

- filter interface options to valid profiles for the selected distribution
- show protocol expectations for the selected interface
- show CPU / RAM / storage for the selected size
- hide hibernate or restart actions if unsupported by the selected runtime

## Recommended Implementation Order

1. Replace the catalog schema with `distributions`, `interfaces`, `instanceSizes`, and `runtimeProfiles`
2. Update workspace-service catalog loading and validation
3. Persist resolved profile and size data on sessions
4. Update the frontend launch form to use the new selectors
5. Add CLI runtime profiles
6. Add restart support
7. Add hibernation only after the runtime backend can truly preserve state

## Immediate Constraint

The current runtime backend is container-only and stateless. That means:

- multiple distros and desktop environments are straightforward if images exist
- CLI-only support is straightforward with a web terminal runtime
- instance sizing is partially straightforward for CPU and RAM
- strict storage sizing is harder
- true hibernation is not credible yet without a different backend or a stateful snapshot mechanism

That should be treated as a platform constraint, not hidden behind UI promises.

