# Backlog

Backlog items are grouped by horizon rather than commitment. Promote items into `TODO.md` when they are ready to be actively worked.

## Platform reliability

- Add lifecycle management for workspace containers, quotas, idle timeout, and cleanup.
- Persist data in a durable database instead of ad-hoc local state if the platform grows.
- Add structured logs and request correlation across services.

## Provider model

- Finish the provider/plugin control plane for Docker first, then VM-backed providers.
- Add Proxmox image inventory and VM profile workflows behind explicit admin controls.
- Document provider security boundaries and network isolation.

## User experience

- Improve admin console visibility into images, sessions, users, and failures.
- Add richer runtime catalog metadata and screenshots.
- Add backup/restore for user profiles and workspace definitions.
