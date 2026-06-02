# TODO

This document captures the current working priorities for this repository. It is intentionally lightweight: keep it updated as work lands, and move completed items into release notes or the README when they become permanent behaviour.

## Immediate priorities

- [ ] Add automated integration tests that start the compose stack and exercise login, profile load, and workspace launch.
- [ ] Document production deployment assumptions: TLS, persistence, authentication secrets, and Docker socket risk.
- [ ] Harden service-to-service auth and configuration defaults before any public exposure.
- [ ] Add health endpoints and readiness checks for every service.
- [ ] Document cleanup of stopped workspaces, images, and stale session records.

## Quality checks

- [ ] Run npm tests/linting where present and add missing scripts if absent.
- [ ] Smoke test at least one CLI runtime and one desktop runtime after changes.
