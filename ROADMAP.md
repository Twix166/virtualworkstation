# Roadmap

This roadmap describes a practical path from the current repository state toward a more maintainable, reproducible project. Dates are deliberately omitted; sequence matters more than calendar promises.

## Phase 1 - Local stack confidence

- Add compose-level integration tests and per-service health checks.
- Document Docker socket, auth secret, TLS, and persistence risks.
- Add cleanup paths for stale sessions and containers.

## Phase 2 - Secure multi-runtime platform

- Harden service auth, quotas, lifecycle management, and logs.
- Complete Docker provider workflows before expanding VM providers.
- Improve admin visibility for image and runtime management.

## Phase 3 - Homelab/private cloud readiness

- Add durable persistence, backup/restore, and monitoring.
- Support VM-backed providers with clear isolation guarantees.
- Package install/upgrade flows with migration notes.
