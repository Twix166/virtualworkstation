# Provider Plugin Design

## Goal

The platform needs to support two execution classes:

- container-backed workstations
- virtual-machine-backed workstations

The current implementation now exposes a provider/plugin control plane so the UI and API can
distinguish:

- `machineTypeId`
- `providerId`
- runtime selection (`distributionId`, `interfaceId`, `instanceSizeId`)

## Current Provider Model

Providers are persisted in the platform data store and managed from the admin console.

Seeded providers:

- `docker-local`
  - kind: `container`
  - driver: `docker`
  - status: implemented
- `libvirt-local`
  - kind: `virtual-machine`
  - driver: `libvirt`
  - status: configuration scaffold only
- `proxmox-primary`
  - kind: `virtual-machine`
  - driver: `proxmox`
  - status: configuration scaffold only

Each provider record contains:

- identity: `id`, `name`, `kind`, `driver`, `scope`
- enablement: `enabled`, `default`
- description
- capabilities
- driver-specific `config`

Sensitive values such as a Proxmox token secret are stored in the platform database but are not
returned in cleartext to the admin UI.

## User-Facing Launch Model

The launch form now includes:

- machine type
- execution provider
- distribution
- interface
- instance size

This allows the catalog to evolve without hard-coding Docker as the only backend.

## Runtime Behavior

### Docker provider

When:

- `machineTypeId = container`
- provider driver is `docker`

the existing Docker runtime path is used.

### Proxmox VM provider

When:

- `machineTypeId = virtual-machine`
- provider driver is `proxmox`

the runtime service now:

1. requests the next VM ID from the Proxmox cluster
2. clones the configured template VM
3. applies CPU and memory sizing from the selected instance size
4. starts the cloned VM
5. persists the resulting `node` and `vmid` into the session record

Required provider configuration:

- `apiUrl`
- `node`
- `templateVmid`
- `tokenId`
- `tokenSecret`

Optional provider configuration:

- `storage`
- `networkBridge`
- `validateTls`

Current limitation:

- the browser `Open` action currently links to the Proxmox web origin rather than a fully proxied
  noVNC/SPICE console path
- hibernate/resume and restart are not yet implemented for the VM path

### Local libvirt VM provider

When:

- `machineTypeId = virtual-machine`
- provider driver is `libvirt`

the provider selection is persisted into the session record, but the execution adapter is still a
scaffold. The admin configuration path is present, but local KVM/libvirt VM provisioning is not yet
implemented.

## Next Execution Step

Implement provider adapters in `workspace-service`:

1. `docker`
   - existing implementation
2. `proxmox`
   - improve browser console handoff beyond the current Proxmox web-origin link
   - size storage and network explicitly from provider/runtime selections
   - add restart, hibernate, and resume lifecycle support
3. `libvirt`
   - define or clone a libvirt domain
   - attach storage/network resources
   - return local console/VNC connection details

## Admin Surface

The admin console is now a separate page at `/admin`.

It owns:

- provider configuration
- cleanup operations
- admin session inventory

The end-user application remains focused on launching and managing the user’s own sessions.
