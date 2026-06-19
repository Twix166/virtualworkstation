# Provider-Scoped Image Builder Design

## Goal

The platform needs a first-class image builder experience that works across multiple execution
providers without forcing them into one generic workflow.

This design defines a provider-scoped image management model where:

- each provider plugin owns its own asset ingestion workflow
- each provider plugin owns its own profile builder workflow
- the session launcher consumes only published launch profiles
- end users do not need to reason about raw ISOs, Dockerfiles, registries, or unattended installer internals

## Problem Statement

The current image management experience is Proxmox-oriented and ISO-centric. That works for
Proxmox VM provisioning, but it does not generalize well to:

- Docker providers using registry images or Dockerfile build recipes
- future libvirt providers using templates or local install media
- cloud providers using images, snapshots, or templates

If the UI treats every provider as though it builds from the same asset type, the workflow becomes
confusing, leaky, and difficult to extend.

## Design Principles

- Keep the user-facing Sessions screen simple
- Keep raw provider asset handling out of the end-user launch flow
- Let each provider plugin define its own builder steps, validation, and test model
- Reuse a shared application shell while allowing provider-specific builder modules
- Make profile publishing explicit so only validated offerings appear to users

## Core UX Model

The platform should use three layers:

1. `Provider Plugin`
2. `Provider Asset`
3. `Launchable Profile`

### 1. Provider Plugin

The provider plugin defines:

- supported asset types
- supported build/test strategies
- supported install/runtime configuration fields
- validation rules
- launch adapter behavior

Examples:

- `docker-local`
- `proxmox-primary`
- future `libvirt-local`

### 2. Provider Asset

A provider asset is the raw input used by a provider.

Examples:

- Proxmox: installer ISO
- Docker: registry image reference
- Docker: Dockerfile or build recipe
- libvirt: template, qcow2 image, or installer media

One asset may back multiple profiles.

### 3. Launchable Profile

A launchable profile is what appears in the Sessions screen.

It encapsulates:

- provider choice
- asset selection
- install/build defaults
- runtime defaults
- publish state

The Sessions screen should launch published profiles, not raw assets.

## Recommended Product Surface

The product should have three distinct areas:

### Sessions

Audience:

- end users

Responsibilities:

- launch sessions
- open sessions
- stop/remove sessions
- view session state

The user should choose from published offerings only:

- provider
- operating system
- interface
- size
- published profile name

The user should not choose raw ISOs or raw build recipes here.

### Image Management

Audience:

- admins
- builders

Responsibilities:

- ingest provider assets
- create and edit launchable profiles
- validate profile compatibility
- run disposable tests
- publish or deprecate profiles

This page should start with provider selection.

### Admin Console

Audience:

- platform administrators

Responsibilities:

- provider configuration
- cleanup and housekeeping
- quotas and platform policy
- plugin enablement

## Recommended Image Management UX

The Image Management page should be a shared shell with a provider switcher at the top.

### Top-level layout

1. Provider switcher
2. Provider workspace
3. Status / test feedback

Provider switcher examples:

- `Docker`
- `Proxmox`
- `Libvirt`

Once the provider is selected, the rest of the page loads the provider-specific builder workflow.

### Shared provider workspace tabs

Each provider workspace should expose the same high-level tabs, even if the contents differ:

- `Assets`
- `Profiles`
- `Tests`

This keeps the product coherent while still allowing provider-specific detail.

## Provider-Specific UX

### Proxmox Builder

The Proxmox builder should be ISO-driven.

#### Assets tab

Responsibilities:

- upload ISO from local disk
- import ISO from URL
- list current ISO inventory from Proxmox storage
- delete ISO assets
- show metadata:
  - detected distribution
  - size
  - upload time
  - `New` state for 24 hours

#### Detection behavior

On ISO ingest, the platform should:

1. inspect the filename
2. match it against a distro detection catalog
3. infer:
   - distro family
   - version
   - likely unattended install strategy
   - likely desktop/server family
4. show:
   - detected distro
   - confidence
   - override control

If confidence is low, the asset should require explicit confirmation before it can be used in a
profile.

#### Profiles tab

Profile creation should follow this flow:

1. select ISO asset
2. confirm or override detected distro
3. choose install strategy
4. configure unattended install defaults
5. configure package set and runtime defaults
6. save as draft

Suggested fields:

- profile name
- provider
- assigned ISO
- distribution
- interface
- locale
- keyboard layout
- timezone
- hostname pattern
- default username
- package list
- optional post-install commands
- published state

#### Tests tab

Testing should launch a disposable VM using:

- the chosen ISO asset
- the chosen profile
- the chosen instance size

The test run should show:

- current state
- console link
- timeline/events
- pass/fail/cleanup controls

Only profiles that have passed validation and at least one successful test should be publishable by
default.

### Docker Builder

The Docker builder should be image/build-recipe-driven rather than ISO-driven.

#### Assets tab

Supported sources:

- registry image
- local build recipe
- cloned existing profile

Suggested asset types:

- `registry-image`
- `dockerfile-recipe`
- `local-build-context`

#### Profiles tab

Profile creation should focus on runtime behavior rather than unattended installation.

Suggested fields:

- profile name
- source image or build recipe
- distribution
- interface
- exposed protocol
- browser connection path
- package layer or setup commands
- environment variables
- runtime defaults

#### Tests tab

Testing should launch a disposable container and validate:

- image starts
- protocol endpoint becomes reachable
- desktop or CLI behavior is correct

### Future Libvirt Builder

The libvirt builder should eventually support:

- template or image selection
- installer media or qcow2 ingestion
- local console/VNC testing

This should follow the same shell and tab model, but with libvirt-specific assets and validation.

## Recommended Data Model

The platform should add explicit entities for provider-scoped image building.

### `provider_asset`

Represents a raw provider-specific input.

Suggested shape:

```json
{
  "id": "asset-123",
  "providerId": "proxmox-primary",
  "assetType": "installer-iso",
  "name": "Fedora Workstation 42",
  "source": {
    "kind": "upload",
    "filename": "Fedora-Workstation-Live-x86_64-42-1.1.iso",
    "volid": "local:iso/Fedora-Workstation-Live-x86_64-42-1.1.iso"
  },
  "detected": {
    "distributionId": "fedora-42",
    "family": "fedora",
    "strategyId": "kickstart",
    "confidence": "high"
  },
  "state": "ready",
  "createdAt": "2026-04-10T12:00:00.000Z"
}
```

### `image_profile`

Represents a reusable build/install/runtime profile tied to one provider and optionally one asset.

Suggested shape:

```json
{
  "id": "profile-123",
  "providerId": "proxmox-primary",
  "assetId": "asset-123",
  "name": "Fedora 42 Workstation",
  "distributionId": "fedora-42",
  "interfaceId": "gnome",
  "buildConfig": {},
  "installConfig": {},
  "runtimeDefaults": {},
  "state": "draft"
}
```

### `profile_test_run`

Represents a disposable validation run.

Suggested shape:

```json
{
  "id": "test-123",
  "profileId": "profile-123",
  "providerId": "proxmox-primary",
  "state": "running",
  "consoleUrl": "https://...",
  "startedAt": "2026-04-10T12:30:00.000Z"
}
```

### `published_launch_profile`

Represents the published offering shown to end users.

Suggested shape:

```json
{
  "id": "launch-123",
  "providerId": "proxmox-primary",
  "imageProfileId": "profile-123",
  "name": "Fedora 42 GNOME Desktop",
  "distributionId": "fedora-42",
  "interfaceId": "gnome",
  "published": true
}
```

## Profile State Model

Recommended states:

- `draft`
- `testing`
- `tested`
- `published`
- `deprecated`

Rules:

- `draft`: editable, not user-visible
- `testing`: active disposable validation
- `tested`: passed at least one validation run
- `published`: visible in Sessions
- `deprecated`: hidden from new launches but retained for history

## Detection and Strategy Catalog

The image builder should not hardcode filename parsing inside UI logic. It should resolve from a
catalog.

Recommended catalog concepts:

- `distributionDetectors`
- `installStrategies`
- `providerCapabilities`

### `distributionDetectors`

Examples:

- `ubuntu-24.04.*live-server.*.iso` -> `ubuntu-24.04`, strategy `autoinstall`
- `xubuntu-24.04.*.iso` -> `xubuntu-24.04`, strategy `autoinstall`
- `debian-12.*.iso` -> `debian-12`, strategy `preseed`
- `Fedora-Workstation-.*.iso` -> `fedora-workstation`, strategy `kickstart`

### `installStrategies`

Examples:

- `autoinstall`
- `preseed`
- `kickstart`
- `manual`

These should define:

- supported providers
- supported distributions
- required configuration fields
- validation rules

### `providerCapabilities`

Examples:

- `supportsIsoAssets`
- `supportsRegistryImages`
- `supportsDockerBuildRecipes`
- `supportsUnattendedInstall`
- `supportsBuildTests`
- `supportsPublishedProfiles`

The active provider plugin should drive the UI from these capabilities.

## Validation Model

Validation should occur at multiple stages.

### Asset validation

- asset exists on provider
- asset type is supported by provider
- detection has a valid or confirmed distro mapping

### Profile validation

- asset/provider compatibility
- install strategy compatibility
- required fields present
- provider configuration present

### Test validation

- disposable run launched successfully
- console path available
- expected endpoint or install milestone reached

## Recommended User Journey

### Proxmox example

1. Open `Image Management`
2. Select `Proxmox`
3. Upload Fedora ISO
4. System detects `Fedora Workstation`
5. User confirms detection and creates a profile
6. User configures locale, keyboard, timezone, packages
7. User saves as `Draft`
8. User runs `Test Build`
9. User watches the console and install timeline
10. User marks test successful
11. User publishes the profile
12. Profile now appears in the Sessions screen

### Docker example

1. Open `Image Management`
2. Select `Docker`
3. Add a registry image or Dockerfile recipe
4. Create a runtime profile
5. Test it as a disposable container
6. Publish it to the Sessions screen

## Sessions Screen Model

The Sessions screen should consume only published launch profiles.

Recommended session-launch fields:

- provider
- profile
- instance size

Optional advanced fields:

- install/runtime override toggle
- profile notes

The screen should not require raw asset selection.

## Recommended Implementation Order

### Phase 1

- add provider-scoped `provider_asset`
- add explicit asset assignment to `image_profile`
- add provider capability metadata

### Phase 2

- convert `/images` into a provider-switched workspace
- split into `Assets`, `Profiles`, and `Tests` tabs

### Phase 3

- implement ISO detection catalog for Proxmox assets
- implement explicit asset-to-profile assignment
- implement profile state machine

### Phase 4

- add disposable `Test Build`
- add published launch profile projection for Sessions

### Phase 5

- implement Docker-specific image builder module
- add future libvirt builder scaffolding

## Recommendation

Do not build one generic image wizard.

Build:

- one shared Image Management shell
- provider-specific builder modules inside it

That gives the cleanest user experience and the most extensible provider architecture.
