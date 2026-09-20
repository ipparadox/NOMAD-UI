# NOMAD V0.6.7 — Launch Doctor and login atmosphere

This continuation extends the current working tree without committing or reverting prior work. It implements the trusted preflight, runtime-selection, diagnosis and authorized repair-and-run path. It is not a general source-code repair system. Limitations below are deliberate and must not be mistaken for implemented coverage.

## Already present

The V0.6 secure renderer/preload boundary, terminal and virtual keyboard, telemetry/globe, application/window supervision and Control Plane were already implemented. V0.6.5 supplied `AutomationEngine`, Node/Python/Rust adapters, typed setup plans, explicit lifecycle authorization, fingerprint verification, Bubblewrap setup, process-group supervision, desktop discovery and the existing WM_CLASS learner. The initial dirty tree additionally contained the persistent run-profile selector/store, fingerprint invalidation and tactical login/HUD redesign. Those changes were retained.

`AGENTS.md` describes an older read-only analysis task. The current explicit implementation request supersedes that task; the original eDEX visual identity remains intact.

## Architecture and rule model

Production boot creates one `LaunchDoctor`, shared by `RepositoryActionService` and `AutomationEngine`. No new process supervisor or package installer exists.

```
RUN / PROJECT_RUN / "corre este repo"
  -> existing selected profile and run authorization
  -> LaunchDoctor.preflight
  -> installed project runtime + static dependency/platform checks
  -> ready: existing RepositoryProcessManager + isolation
  -> setup needed: repair plan in the existing Control Plane
  -> existing AutomationEngine authorization + supervised setup
  -> verify dependencies, inputs and security profile
  -> at most one explicitly authorized final launch
```

`RepairRuleRegistry` contains immutable `RepairRule` definitions with ID, severity, repair class, detection, diagnosis, typed plan construction, auto-repair eligibility and verification. Findings carry no executable or arbitrary arguments. Runtime binding remains main-side. `REPAIR_LIMITS` caps setup plans at eight steps and final launches at one.

Implemented diagnoses include invalid/missing run-profile selection, incompatible/unknown Node requirements, missing package-manager executable/identity, missing/incomplete/unknown Node dependencies, static Windows-only profile conflicts, Python runtime mismatch/unknown constraints, absent local Python environment, Python/Rust setup requirements, missing Python/Cargo executable, unsupported adapter state and independently confirmed occupied ports. A STALE rule is reserved, but comprehensive stale-lock/version detection is not implemented.

Class A behavior selects an already installed compatible Node runtime without changing global Node, and refreshes an unavailable application's existing registry entry. Class B uses existing `PROJECT_SETUP` authorization; `PROJECT_REPAIR` is a typed alias. `PROJECT_REPAIR_AND_RUN` explicitly authorizes the setup effects and one selected repository launch. It seals the run-profile fingerprint and security profile, verifies them again after setup, and does not persist new run trust. Class C stops for manual review. Classes cannot promote themselves.

## Node runtime resolution and OSIRIS

`ProjectRuntimeResolver` reads the adapter's bounded, regular, non-symlink inputs: `package.json`, `.nvmrc` and `.node-version`. Both hint files now participate in fingerprints and invalidate stale run selections and setup plans. Node engines and runtime hints must all be satisfied. Existing transitive `semver` is reused; absent semver or unsupported syntax fails closed. NVM aliases such as `lts/*` are UNKNOWN rather than guessed.

The resolver inventories `/usr`, `/usr/local` and at most 32 installations under the fixed `~/.nvm/versions/node/vX.Y.Z` root. It validates canonical containment, executable regular files, ownership and ancestor permissions. World-writable and shared-group-writable paths are refused. The conventional user-owned group-writable NVM layout is accepted only when `/etc/group` and `/etc/passwd` establish that the group is private to the current user. Symlinks must resolve within the expected runtime root. Direct `--version` probes have a two-second timeout, 1 KiB output bound, `shell:false`, and a minimal environment. File identity is checked across probing and again before runtime binding.

Compatible stable even-major installed versions are preferred, newest first, then other stable versions. This is a deterministic installed-version policy, not a claim about current upstream support dates. There is no automatic download, `nvm` shell invocation, shell startup sourcing or global runtime switch.

Package-manager execution uses the selected absolute Node binary plus a canonical, known npm/pnpm/yarn CLI entrypoint within that installation. Unknown wrappers and Corepack shims stop for manual setup. The child's PATH begins with that runtime's bin directory followed by fixed system directories. Existing isolation binds the NVM runtime read-only. Electron's own Node remains untouched.

Unit fixtures select 24.19.0 for `>=18`, `>=18.12`, and `^18.18.0 || ^20.9.0 || >=21.1.0`; exact valid runtime hints select their matching installed version. Real Electron/i3 acceptance uses a disposable project requiring Node >=18, records the launched runtime in a marker, and asserts Electron remains on its internal Node 14.16.0. GUI runs selected Node 24.19.0 and measured preflight at 42 ms and 97 ms. No OSIRIS repository or host project was modified.

## Dependency repair and authorization

Direct dependencies and devDependencies are checked by filesystem presence of package manifests inside canonical `node_modules`. Missing directories are MISSING; absent direct packages are INCOMPLETE; unsafe/unreadable structures are UNKNOWN. A project declaring no dependencies needs no `node_modules` directory. No module is imported or executed to establish readiness.

The existing adapter chooses npm ci for package-lock, or its existing trusted pnpm/yarn plan when that manager is available in the selected runtime. PREPARE still works. Repair does not add another npm implementation. Default lifecycle suppression remains, and existing PREPARE + HOOKS remains a separate explicit authorization. Plans explain that manager configuration/plugins and dependency/build hooks can execute repository code.

The exact setup token, repository identity, fingerprints and security profile are checked by AutomationEngine. Repairs do not treat old run trust as setup authorization. After Node setup, direct dependency presence is verified before READY. The combined repair-and-run challenge grants one launch only; a changed profile or a newly generated lockfile changing the run fingerprint requires fresh run authorization.

## Python, Rust, ports and environment

Python diagnosis checks the existing trusted Python executable and the project-local `.venv/bin/python`. Conservative single-line `[project] requires-python` constraints using simple numeric comparisons are checked by a direct version probe, without imports. Unsupported PEP 440 expressions remain UNKNOWN. This does not discover or select alternate Python installations. Existing project-local venv/pip setup and pip-check verification remain supervised and authorized; system Python and system pip are never mutated. Pyproject build-hook risk remains visible.

Rust uses existing Cargo discovery, setup and the fixed CARGO RUN profile. Missing Cargo is manual. Builds remain Class B and may execute build.rs, procedural macros and Cargo-configured tools. No rustup download or shell installer is added.

A failed process reporting EADDRINUSE yields PORT_CONFLICT only if an independent loopback bind probe confirms the reported unprivileged port is occupied. Nothing kills or signals the unrelated owner. There is no generic port rewrite: current adapters lack a trusted port-override contract. IPv6-specific conflicts, owner inspection and alternate ports are limitations.

No environment requirement is invented from README text or arbitrary output. Existing credential warnings and minimal environment policy remain. Host secrets, dotfiles and shell history are not harvested. General required-variable/secret diagnosis needs an explicit adapter metadata contract and is not implemented here.

## Failure capture, bounded retry and history

Doctor-managed runs still use existing process groups, STOP and isolation. Their stdout and stderr are separately bounded to 32 KiB in memory. Existing log access remains; doctor-managed log writes use the supervisor's existing bounded-output mode (64 KiB), rather than retaining unlimited raw output. Main-side launch context records profile, project type, runtime, fingerprint and setup state.

At process close, preflight state is rechecked for classification. Output alone cannot establish missing dependencies; ready state plus fabricated ENOENT remains UNKNOWN. Unknown failures report manual review. Process summaries now include a cause.

There are zero unattended post-failure retries. An explicitly authorized repair transaction performs bounded setup and one final launch. A second failure is surfaced and does not trigger another installation/launch loop. This is more conservative than the proposed automatic one-retry policy; unattended reuse of setup authorization is not implemented.

History is a bounded, session-only latest diagnostic record for up to 64 projects, with fingerprint, runtime, dependency findings, elapsed time and resolved-finding count. The public repository projection suppresses history after fingerprint changes. No output blobs or new persistent files are written. Persistent multi-launch repair timelines and complete runtime-transition accounting remain future work.

## UI and applications

The existing RUN authorization and profile selector remain. When preflight finds repairable setup conditions, the existing Control Plane displays LAUNCH, runtime/dependency facts, REPAIR & RUN, VIEW PLAN and CANCEL. Diagnosis has its own compact view; project INFO was replaced by DIAGNOSE in that view, while repository information remains available elsewhere. Assistant phrases include `corre este repo`, `diagnostica este repo`, `por qué no arranca`, `repara este repo`, `arregla este repo`, `diagnose this repo` and `repair this repo`.

The current setup progress UI continues to display real execution steps and logs. CHECKING is immediate and there are no artificial preflight delays. The full proposed launch dashboard, OPEN auto-detection and all phase-specific transitions are not implemented.

An unavailable registered application is refreshed through existing registry reload before OPEN. Unknown IDs are never auto-registered or trusted. Missing executable and unknown WM_CLASS receive factual causes. APPLICATION_REPAIR and REPAIR IDENTITY reuse existing authorized discovery/registration and the existing WM_CLASS learner. There is no silent reinstall, arbitrary executable adoption or new learner. Detection of a stale but still populated WM_CLASS after a window timeout remains manual.

## Security profiles and refusal boundary

NORMAL retains existing execution and setup authorization. PUBLIC retains its verified volatile-path gate and strong setup isolation. Repairs cannot fall back from required strong isolation. LOCKDOWN blocks setup, repair-and-run and new external/project execution; read-only PROJECT_DIAGNOSE remains available. Existing internal UI access remains governed separately.

No renderer filesystem, process API, executable path or arbitrary argument IPC was added. Renderer requests are fixed action IDs and opaque targets; setup/run details are built and sealed main-side. Sensitive environment stripping, preload isolation and process supervision are unchanged in authority. Source code, scripts, requirements, Cargo manifests, system configuration and security controls are not edited by the doctor. No sudo, arbitrary shell scripts, README commands, stderr commands, curl pipeline or forced audit fixes are generated.

## Login adjustment

Only the existing `.nomad-login-shade` background changed: a roughly 50% blue-black global darkening layer and a subtle center-focused radial layer at z-index 1, above canvas and below HUD/card at z-index 2. Pointer events remain none. There is no blur, canvas-opacity change, extra DOM or layout-dependent animation. The login card, authentication, ASCII renderer/ramp/speed/noise/DPR/pointer handling/lifecycle and reveal implementation are untouched by this phase.

The real GUI harness captures the previous shade and new shade with compositor settling between captures. It checks first visible frame, 20 seconds of live canvas output, exact character ramp, mouse input, keyboard focus, explicit confirmation, 100%/125% layout and reveal. The first run had a transient login-state assertion failure; subsequent complete runs passed. The darker result preserves crisp, visible characters while the NOMAD title and card lead the composition.

## Files attributable to this continuation

New: `src/classes/launchDoctor.js`, `src/classes/projectRuntimeResolver.js`, `src/classes/repairRuleRegistry.js`, `test/launchDoctor.test.js`, and this report.

Extended: `src/_boot.js`, `src/_renderer.js`, `src/_renderer_secure.js`, `src/assets/css/login.css`, `src/classes/automationEngine.js`, `src/classes/controlPlaneService.js`, `src/classes/controlPlaneView.class.js`, `src/classes/intentParser.js`, `src/classes/projectAdapters.js`, `src/classes/repositoryIsolationService.js`, `src/classes/repositoryLauncher.class.js`, `src/classes/repositoryProcessManager.js`, `src/classes/repositoryService.js`, `test/automation.gui.js`, and `test/secureProduction.gui.js`.

Pre-existing changes retained include `src/assets/css/repository.css`, `src/preload.js`, `src/ui-secure.html`, `src/classes/repositoryRunSelectionStore.js`, `test/repositoryRunSelection.test.js`, and prior edits in several extended files. No package manifest/lockfile or shell/Python script changed.

## Validation and exact manual VM checklist

All 61 Node test suites pass: the 60 existing suites plus 48 assertions in the new Launch Doctor suite. Existing tests retain coverage of setup authorization, PUBLIC/LOCKDOWN, process groups, environment sanitization, Git/clone, run selection, renderer/preload boundaries, keyboard, terminal, Control Plane and applications. This is not a claim that every proposed rule has a dedicated regression.

`node --check` passes for 149 JavaScript files outside dependency/build/vendor directories. `git diff --check` passes. Root/source manifests and lockfiles are unchanged. Production source contains no `shell:true`. No changed shell/Python files require syntax checks. The legacy root npm test script installs dependencies and invokes an external Snyk service; it was not used in place of the repository's actual regression suites.

Run automated VM acceptance with `python3 test/run-secure-i3-gui.py`. It uses private authenticated Xwayland/i3 and disposable configuration, repository, tarball dependency, desktop entries and logs. The final expanded GUI run passed the direct RUN-button repair-panel path, missing-dependency diagnosis, incomplete-package restoration, the combined REPAIR & RUN challenge, one supervised final launch, and UNKNOWN classification for fabricated ENOENT output with ready dependencies. Real setup uses Bubblewrap and modern installed Node. Existing GUI checks include application/VLC lifecycle, 30 seconds of advancing telemetry/globe, terminal round trips, clipboard, virtual keys and foreground-stop behavior. Real CODE/BROWSER profiles and dedicated GDM authentication are outside this harness.

Manual VM checks:

1. Start the current checkout with the existing production session entrypoint; retain its required Electron/internal Node environment.
2. At 100% scaling, observe login for 20 seconds. Confirm a live crisp dark ASCII field, dominant NOMAD title, readable side/bottom HUD and focus on ENTER NOMAD. Move the mouse over the background.
3. Repeat at 125% scaling. Confirm card and status strip do not overlap and all text remains readable. Enter NOMAD; confirm unchanged dissolve and live terminal/keyboard/globe.
4. Select a disposable Node project with engines >=18 and a package-lock. With modern Node already installed, request `diagnostica este repo`. Check the reported modern runtime and dependency state.
5. Run a prepared trusted project. Check that it launches directly. Verify the child's runtime and that Electron still reports Node 14.
6. In a disposable fixture only, remove a required package's package.json. Run diagnosis and confirm INCOMPLETE. Open REPAIR & RUN, review risk/isolation/fingerprint, cancel once, and confirm no setup occurred. Reopen and authorize; check restoration and exactly one project launch.
7. STOP the project. Confirm its supervised children stop, and unrelated processes stay alive.
8. Use a disposable source failure with dependencies present. Confirm FAILED / UNKNOWN and separate log access; confirm no install or retry loop.
9. Occupy a disposable unprivileged localhost port with an unrelated process and run a fixture that reports EADDRINUSE for it. Confirm PORT_CONFLICT and that the unrelated process remains alive. Do not expect automatic port reassignment.
10. Change the project runtime hint or manifest. Confirm stale profile selection and authorization are invalidated.
11. In a disposable Python project, diagnose absent .venv, inspect the local venv/pip plan and its build-hook warning. Test unsupported requires-python syntax yields UNKNOWN. Never expect system pip changes.
12. In a disposable Rust project, inspect the fixed Cargo profile and authorized build. In a VM lacking Cargo, confirm manual toolchain requirement with no installer.
13. Switch to LOCKDOWN. Confirm RUN/PREPARE/REPAIR & RUN are denied, while diagnosis remains available. In a dedicated PUBLIC session, confirm required isolation and volatile storage; an unavailable strong backend must block repair.
14. For a registered disposable desktop entry, test stale registry refresh. For unknown WM_CLASS, use REPAIR IDENTITY and review the existing learner's confirmation. Confirm unknown executables are not silently trusted or installed.
15. Verify `git status` still shows the intended uncommitted work and manifests/lockfiles remain unchanged.

## Remaining limitations

No runtime download or system-tool installation; no automatic source patching; no broad cache deletion; no unattended replay of setup authorization; no automatic post-failure retry; no general dependency integrity/transitive/version/lock synchronization validation; no arbitrary workspace-link repair; no general PEP 440 parser or alternate Python selection; no Rust toolchain-version resolver; no general required-environment schema; no trusted adapter port override; no persistent multi-event repair timeline; no automatic stale populated WM_CLASS relearning. System npm layouts or package-manager wrappers outside the recognized runtime-root layout may require manual setup. These cases fail conservatively rather than manufacturing a successful repair.
