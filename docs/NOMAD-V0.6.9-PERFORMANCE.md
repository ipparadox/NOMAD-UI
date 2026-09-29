# NOMAD V0.6.9 — performance and fluidity

## Scope and provenance

Continued commit `25f1d3e` (V0.6.8). The original implementation report recorded a clean starting tree. On the subsequent continuation review, the V0.6.9 production changes, diagnostics, tests and this report were already uncommitted in the working tree; they were preserved. No reset, commit, dependency, manifest, lockfile, theme or security bridge change. The implementation request supersedes the old V0.1 read-only AGENTS.md instruction.

### Continuation verification and evidence provenance

The before/after tables and GUI/soak results below are inherited records of the earlier implementation run. Their referenced `/tmp/nomad-v069` and `/tmp/nomad-v068` artifacts were absent during the continuation review. The historical measurements therefore could not be independently recalculated or verified in this review; they are not fresh measurements. In particular, the recorded ten-minute soak was not repeated, respecting the requested single-soak stop condition.

The continuation review inspected the entire uncommitted diff and the production cache, live validation and adaptive-cadence lifecycle. No further runtime edits were made. A fresh local regression pass was justified by the missing validation artifacts: all **63** suites passed, with **61** passing inside the sandbox and the two remaining suites passing when rerun with permission (`launchDoctor.test.js` needs a loopback listener; `repositoryProcessManager.test.js` exercises supervised child output). The initial sandbox pass is recorded in `/tmp/nomad-v069-review-tests.{json,log}`; its two failures are retained there rather than rewritten as successes. Permission-enabled rerun results were recorded in the tool output.

Fresh static checks passed for **156** first-party JavaScript files (154 under `src` excluding assets/dependencies and under `test`, plus the two root build utilities), Python AST parsing, `git diff --check`, unchanged root/src manifests and lockfiles, and the production `shell: true` scan. No shell scripts changed. Secure renderer and security-boundary suites are included in the 63. The historical count of 157 below is retained as originally reported, not asserted as this review's count. No fresh GUI acceptance or physical-display verification was performed in this continuation.

This is a measured, limited performance change, not a claim of universal 60 FPS. The production changes are confined to derived project inspection and decorative chart/globe cadence. Other reviewed subsystems retain their existing implementation when measurements did not justify changing them.

## Methodology

`python3 test/run-secure-i3-gui.py --performance before` / `--performance after` runs the real production bootstrap in private authenticated Xwayland/i3 with disposable fixture repositories and application registry. Production isolation and disabled DevTools remain enabled; the main-process test harness attaches CDP, not a renderer-accessible debug API. Temporary metrics and CPU profiles are under `/tmp/nomad-v069/{before,after}`. These are ephemeral diagnostics, not committed artifacts.

Each run observes explicit login for 20 seconds, enters the HUD, measures 15 seconds idle with V8 sampling plus RAF/long-task/method counters, then ten repetitions of Control Plane open/close, repository selection, launcher, terminal tab switching and keyboard toggling. Both 1920×1080 and 1366×768 logical viewports use identical emulation settings. Work latency includes awaited work; frame latency waits two RAF callbacks and is a rendering proxy, not physical click-to-photon latency. First-visible timing is the BrowserWindow show event; login ready is polled; entry timing includes the harness screenshot and the approved 2.1-second reveal. These are not exact first-paint or critical-path spans.

A second baseline added an attribution experiment: eight seconds each of normal painting, globe paused, charts paused, both paused. These temporary method replacements exist only in the test, are restored, and are never shipped as a quality mode. The first exploratory baseline is not used for the final paired comparison. Its 28 FPS at 1920 versus the paired baseline's 21 FPS demonstrates VM variability.

`node test/performance-project.js` measures 30 Launch Doctor preflights of the same disposable Node fixture with a 957,814-byte lockfile, real runtime resolution and no declared dependencies. The fixture is synthetic; it does not measure every installed dependency tree or a real project RUN. Input `readSync` counts cover the timed calls. The adapter is warmed while obtaining the profile, so `coldMs` is the first Doctor call, not a cold adapter benchmark.

## Measured hotspots and changes

### Rendering

The baseline idle samples recorded no >50 ms renderer long tasks. The renderer spent most V8 profile samples idle. GPU-process CPU was much higher than renderer CPU. In the paired baseline's attribution windows, normal painting yielded 30.1 FPS; globe paused 50.5; charts paused 58.6; both paused 59.1. Normalized GPU CPU fell from 40.4% to 5.83% with both paused. This implicates combined decorative canvas/WebGL/compositor work, not slow Control Plane JavaScript. Sequential short windows are diagnostic evidence, not independent randomized trials.

`NomadVisualCadence` in `secureTelemetry.class.js` observes the existing globe RAF. It creates no loop, interval, subscription or bridge call. Five seconds below 45 FPS reduces globe cadence from a nominal 30 FPS to at most 20 and chart paint limits from 30 to 12. Restoration requires consecutive healthy five-second windows at >=55 FPS spanning at least 30 seconds. Visibility changes reset observation/recovery windows; login/hidden views retain V0.6.8's paint pause. Disposal removes the observer callback along with the existing globe loop. New CPU chart instances inherit the selected cadence.

No resolution, geometry, palette, line thickness, data sampling or terminal cadence is reduced. Telemetry remains the existing single-flight 1 Hz system/network collection, with slow sensor caches and truthful unavailable states. Series remain bounded at 600 samples. Smoothie structures and ENCOM geometry are reused. Charts already skip paints at pixel granularity; reported wrapper counts are render *attempts*, not actual canvas paints.

### Project inspection and Launch Doctor

The baseline made 120 file-content reads in 30 preflights of a two-file fixture: Doctor read the inputs, then `inspectProject` read them again. Doctor now passes its securely read operation snapshot to `inspectProjectInputs`. This avoids duplicate I/O and inconsistent input snapshots within that operation.

A bounded 64-entry cache holds serialized derived adapter results, keyed by canonical path, freshly computed content fingerprint and freshly observed adapter readiness marker. Every external inspection still reads current bytes through existing lstat/realpath/no-follow/opened-file identity checks. Cache hits return independent objects so AutomationEngine cannot mutate cached plans. Changed bytes invalidate the result even if a file timestamp is preserved; changed setup-directory state also changes the key. Raw input contents are not retained.

Runtime discovery/binding, dependency presence, execution identity, run-profile trust, security policy, isolation and final launch checks remain live. This cache is not permission to RUN. Repositories outside the bounded cache are inspected normally. Node/Python/Rust inspection stays read-only.

## Architecture review: retained paths

* Startup: bootstrap, fonts, security profile and explicit session confirmation remain ordered. System/network initialization already runs concurrently. The reveal still waits for existing readiness checks; no speculative terminal before confirmation, no black/empty-frame shortcut, no newly deferred startup service. Measured entry timing alone did not identify an independent startup chain worth changing.
* Control Plane: lightweight view/index already mounts before ready; assistant opening performs no filesystem scan. Open/close lifecycle and input capture remain unchanged. RUN/STOP already set busy UI before awaiting service results; no fake progress added.
* Renderer DOM/CSS: no design changes or speculative selector/animation rewrites. The sampled common controls did not have slow synchronous handlers. Keyboard is built once, toggled using V0.6.8's layout-safe transitions. Existing terminal xterm/AttachAddon buffering and authenticated WebSocket transport remain intact.
* Repositories: selecting a rendered repository sets context and opens its menu, without global discovery. Explicit refresh, process-state refresh and security-sensitive metadata inspection remain. Derived inspection benefits from the new cache; directory discovery and trust decisions are not cached.
* Applications: existing nonrecursive validated directory watchers plus three-second fixed-path metadata signatures trigger a debounced refresh. This is not continuous recursive desktop scanning. Launcher opening uses workspace state. No additional watcher or reconciliation loop.
* i3: the existing two-second safety reconciliation coalesces concurrent observations and checks trusted window identities. No skipped identity validation or timing change.
* IPC: frozen named bridge unchanged. Existing sequence rejection, same-text suppression and semantic i3 state emission retained. No new runtime IPC traffic. No measured IPC bottleneck justified a bridge rewrite.
* Logging: existing bounded log rotation and supervised output limits retained. No per-frame/per-sample production logging.

## Validation and limitations

Deterministic tests cover cache reuse, content invalidation, independent result ownership, live setup readiness and refusal of symlinks even after a cache hit; adaptive hysteresis, visibility reset, no new loops/timers, unchanged functional samples and callback cleanup. Existing suites retain coverage of login RAF destruction, chart bounds, subscriptions, Control Plane ownership, keyboard, terminal transport, adapters, Doctor, policy, automation and i3 reconciliation.

Absolute active timer/listener/RAF ownership counts across Electron, all filesystem calls and renderer↔main IPC rate are not measured by the paired harness. Missing values must not be interpreted as zero. CDP listeners/DOM counters and frame distributions are recorded; source inspection and deterministic lifecycle tests complement them. RUN/STOP visual acknowledgement, security HUD/app focus latency, real GDM startup and a distinct HUD-visible-to-interactive span are not separately benchmarked. Functional acceptance covers those controls.

VirtualBox/host compositor contention and device emulation affect results. Logical viewport tests are not physical resolution/DPI certification. Production V8/Electron remains the existing version; no dependency upgrade or unsafe worker architecture is used. The chart/globe adjustment can reduce background GPU pressure on hardware too, but measured gains here are specific to this VM.

## Before / after results

Values below use the final paired run, not the exploratory run. Percentages describe these observations; one pair on a busy VM does not establish a hardware-independent speedup.

| Startup metric | Before ms | After ms |
| --- | ---: | ---: |
| Process harness → window show | 2368 | 2569 |
| Process harness → login ready | 3202 | 3168 |
| ENTER → ready observation | 6190 | 6011 |

### 1920×1080

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Average RAF cadence | 20.97 FPS | 38.47 FPS | +83.4% |
| Worst frame | 133.33 ms | 100.00 ms | -25.0% |
| 1% low (slowest 1% mean) | 7.83 FPS | 10.00 FPS | +27.8% |
| Control Plane open work | 5.57 ms | 4.72 ms | -15.2% |
| Control Plane open two-frame proxy | 96.65 ms | 87.80 ms | -9.2% |
| Control Plane close work | 4.67 ms | 4.17 ms | -10.6% |
| Control Plane close two-frame proxy | 174.84 ms | 138.08 ms | -21.0% |
| Repository selection work | 8.14 ms | 12.18 ms | +49.7% |
| Repository selection two-frame proxy | 129.43 ms | 120.59 ms | -6.8% |
| Launcher open work | 7.04 ms | 9.22 ms | +30.9% |
| Launcher open two-frame proxy | 143.98 ms | 130.36 ms | -9.5% |
| Terminal tab switch work | 28.78 ms | 36.61 ms | +27.2% |
| Terminal tab switch two-frame proxy | 147.02 ms | 163.03 ms | +10.9% |
| Keyboard toggle work | 0.03 ms | 0.02 ms | -11.1% |
| Keyboard toggle two-frame proxy | 137.70 ms | 118.50 ms | -13.9% |
| Main idle normalized CPU | 2.07% | 1.97% | -4.9% |
| Renderer idle normalized CPU | 4.26% | 4.65% | +9.3% |
| GPU idle normalized CPU | 37.42% | 35.73% | -4.5% |
| Total Electron working set sum | 926.33 MiB | 925.09 MiB | -0.1% |
| Renderer working set | 187.06 MiB | 203.09 MiB | +8.6% |
| Globe ticks/second | 14.67 | 14.02 | -4.4% |
| System telemetry applies/second | 0.60 | 0.53 | -11.0% |
| Network telemetry applies/second | 0.80 | 0.80 | +0.1% |
| Chart render attempts/second per chart | 21.04 | 38.54 | +83.2% |

Before: 316 sampled intervals; 211 >16.7 ms, 211 >33 ms; 0 tasks >50 ms and 0 >100 ms.

After: 579 sampled intervals; 157 >16.7 ms, 157 >33 ms; 0 tasks >50 ms and 0 >100 ms.

### 1366×768

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Average RAF cadence | 16.08 FPS | 24.76 FPS | +54.0% |
| Worst frame | 100.00 ms | 100.00 ms | +0.0% |
| 1% low (slowest 1% mean) | 10.00 FPS | 11.25 FPS | +12.5% |
| Control Plane open work | 4.19 ms | 3.66 ms | -12.8% |
| Control Plane open two-frame proxy | 99.69 ms | 77.42 ms | -22.3% |
| Control Plane close work | 2.99 ms | 2.55 ms | -14.8% |
| Control Plane close two-frame proxy | 144.02 ms | 130.83 ms | -9.2% |
| Repository selection work | 10.43 ms | 9.79 ms | -6.2% |
| Repository selection two-frame proxy | 131.88 ms | 107.39 ms | -18.6% |
| Launcher open work | 5.43 ms | 5.94 ms | +9.5% |
| Launcher open two-frame proxy | 131.49 ms | 121.22 ms | -7.8% |
| Terminal tab switch work | 3.22 ms | 3.60 ms | +11.8% |
| Terminal tab switch two-frame proxy | 146.63 ms | 121.02 ms | -17.5% |
| Keyboard toggle work | 0.02 ms | 0.04 ms | +87.5% |
| Keyboard toggle two-frame proxy | 120.69 ms | 118.82 ms | -1.5% |
| Main idle normalized CPU | 1.84% | 1.89% | +2.9% |
| Renderer idle normalized CPU | 3.89% | 3.90% | +0.2% |
| GPU idle normalized CPU | 37.00% | 36.25% | -2.0% |
| Total Electron working set sum | 968.71 MiB | 945.97 MiB | -2.3% |
| Renderer working set | 187.47 MiB | 185.16 MiB | -1.2% |
| Globe ticks/second | 15.75 | 11.68 | -25.8% |
| System telemetry applies/second | 0.66 | 0.73 | +10.5% |
| Network telemetry applies/second | 0.86 | 0.80 | -7.3% |
| Chart render attempts/second per chart | 16.15 | 24.83 | +53.8% |

Before: 242 sampled intervals; 236 >16.7 ms, 236 >33 ms; 0 tasks >50 ms and 0 >100 ms.

After: 371 sampled intervals; 267 >16.7 ms, 267 >33 ms; 0 tasks >50 ms and 0 >100 ms.

Frame counts differ because cadence improved; counts must be interpreted against their denominators. CPU is Electron’s normalized process CPU metric, not a single-core percentage. Working-set sums may count shared pages more than once and exclude non-Electron helper processes. They are not unique physical RAM usage. No general memory reduction or renderer CPU reduction is claimed: 1080p renderer working set and CPU increased. Tab-switch latency also worsened at 1080p; its first iteration creates a PTY.

### Project preflight

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Warm mean preflight, 29 calls | 25.44 ms | 9.25 ms | -63.6% |
| First Doctor call (adapter already warmed) | 31.38 ms | 10.39 ms | -66.9% |
| Input content reads, 30 calls | 120 | 60 | -50% |

Startup order and reveal timing were unchanged. The 179 ms entry difference is an observation, not attributed startup improvement. Main-thread blocking over 100 ms was not observed in these idle windows; that does not guarantee none during all actions. Collection can run below 1 Hz while a sensor times out; no fake samples are inserted. Actual chart paints and before/after IPC rate were not captured by this paired harness.

## Final regression verification

* All **63** `test/*.test.js` suites passed in one permission-enabled final pass. Per-suite outcomes: `/tmp/nomad-v069-tests.json`; output: `/tmp/nomad-v069-tests.log`. The historical `npm test` installs dependencies and invokes external Snyk, so it is not the local regression runner and was not executed.
* **157** first-party/non-vendored JavaScript syntax checks passed; Python harness parsed without bytecode output. No shell scripts changed.
* `git diff --check` passed. Root/src package manifests and lockfiles match HEAD. Production first-party source scan found no `shell: true`.
* Secure renderer hardening, frozen bridge, transport, session, permission, isolation, policy and automation tests are included in the 63 suites. Production GUI additionally asserts `contextIsolation: true`, `nodeIntegration: false`, remote disabled, DevTools disabled and no renderer `require`/`process`/`module`.
* Real GUI Doctor preflight was **56 ms**, selecting external Node 24.19.0 rather than Electron’s internal Node 14.16.0. Real Bubblewrap setup, suppressed hooks, explicit authorization, selected RUN profile, RUN/STOP, cancellation, discovery/registration and LOCKDOWN refusal passed.

The final command is `NOMAD_GUI_RETAINED_AUDIT=1 python3 test/run-secure-i3-gui.py --polish --soak-seconds 600`. One GUI acceptance and one ten-minute soak are combined in this run. Forced garbage collection is limited to retained-object endpoint observations, not continuous timing. The existing harness writes final geometry, screenshots, startup and soak artifacts to `/tmp/nomad-v068/`; its unchanged output directory identifies the reused infrastructure, not the runtime version.

The soak now includes all Electron process metrics, cumulative long-task/frame-stall counts, adaptive state and test-only main-operation counters. IPC counters cover named invoke handlers and outgoing `webContents.send`; synchronous filesystem counters cover the named wrapped methods only. They do not claim complete async filesystem or IPC transport coverage. Directory scan and i3 tree counters count calls, not bytes or nodes. Counters contain no payloads, paths, commands or secrets and have no production import.

### Soak sampler correction

The running soak exposed a test-only sampler mistake: adding all-process metrics alongside the old renderer metric called `app.getAppMetrics()` twice. Its second CPU reading is relative to an almost-zero interval and is invalid for interpretation. The **first** reading in each sample's `process.cpu` is the renderer's valid interval measurement; memory readings remain usable. Main/GPU CPU from this soak's `processes` array is excluded. The harness is corrected to collect once and share that snapshot; this correction was syntax-checked without restarting the single soak. Paired baseline/after CPU measurements use one call per sample and are unaffected. The final 63-suite pass covers the final production changes; the only subsequent code change is this test sampler correction.

### Reproduction details

`--performance before` and `--performance after` are output labels, not automatic source checkouts. The historical baseline was captured before runtime edits. Running both labels on the final source will profile the same optimized implementation. Preserve the JSON/CPU profiles if needed; `/tmp` is not durable storage. No performance option is accepted by the production renderer or exposed through its bridge.

## Changed files

Production:

* `src/classes/projectAdapters.js` — operation-snapshot inspection and bounded content-keyed derived cache.
* `src/classes/launchDoctor.js` — reuse securely read inputs within preflight.
* `src/classes/secureTelemetry.class.js` — conservative adaptive decorative cadence using the existing RAF and lifecycle.

Tests / diagnostics:

* `test/performance.gui.js` — paired frame, latency, process and CPU-profile capture plus paint attribution experiment.
* `test/performance-project.js` — repeatable synthetic Doctor read-count/timing benchmark.
* `test/performance.test.js` — cache/security/readiness/hysteresis regressions.
* `test/secureTelemetry.test.js` — adaptive functional-data and loop/disposal assertions.
* `test/support/performanceCounters.js` — test-only named IPC, filesystem and scan counters.
* `test/secureProduction.gui.js`, `test/run-secure-i3-gui.py` — opt-in profiling dispatch.
* `test/systemPolish.gui.js` — richer bounded soak samples; single-read process sampler correction.
* `docs/NOMAD-V0.6.9-PERFORMANCE.md` — methodology, results and limitations.

## Remaining bottlenecks and manual checks

The VM remains graphics/compositor limited. Both resolutions still miss 60 FPS; Control Plane's two-frame proxy remains above the ideal 75 ms. 1080p tab switching did not improve. Project inspection must still securely read/hash bounded input files and validate live runtime/dependency state; the cache deliberately does not eliminate those costs. No new startup parallelization, terminal batching, keyboard rewrite, app discovery or IPC change is claimed.

Beyond the automated environment:

1. Start through the actual GDM session at native 1920×1080 and 1366×768, then native 125%/150% scaling. Verify login focus, explicit entry, transition without black/empty flashes, full uncropped HUD, keyboard and security strip. The nested screenshot surface can crop larger emulated viewports; automated geometry does not certify native DPI/raster output.
2. On physical GPU hardware, repeat the same profiling protocol with the same visible scene and comparable background load. Record idle CPU/memory and frame distributions before deciding whether further visual tuning is justified.
3. Exercise real trusted CODE/BROWSER profiles, security HUD and NORMAL/PUBLIC/LOCKDOWN, plus a dependency-heavy project through diagnose → authorized RUN → STOP after editing its manifest. Automated fixtures cover the trusted mechanisms but not every user's installed app/project.
4. For a terminal-throughput claim, benchmark a controlled high-output workload and verify complete output separately. This phase preserves xterm transport behavior and passes terminal correctness tests; it does not claim measured throughput improvement.

These are limits on broader claims, not reasons to rerun successful fixture tests or extend this phase indefinitely. No commit was made.

## Completed GUI acceptance and single bounded soak

The combined command exited **0**. All 15 login and 15 HUD resolution/scale combinations passed, including 1920×1080 and 1366×768. Screenshots were reviewed at 1080p and constrained 150% scale; larger captures remain cropped by the physical nested surface as documented. Secure GUI and real i3 generic-app/VLC acceptance passed. This does not certify frame-by-frame absence of flashes on the real GDM compositor.

The **one** soak lasted **600.048 seconds**, executing **464 cycles**. It was not repeated. This is the existing active workload at the native nested-window size, not the paired idle 1080p/768p benchmark.

| Soak metric | Beginning | End |
| --- | ---: | ---: |
| Retained documents after GC | 1 | 1 |
| Retained event listeners after GC | 501 | 492 |
| Retained DOM nodes after GC | 2,285 | 2,248 |
| Terminal instances | 2 | 2 |
| Renderer working set | 194.69 MiB | 204.34 MiB |
| JS used heap, sampled (not both GC endpoints) | 7.60 MiB | 7.90 MiB |
| Renderer normalized CPU, first full vs final interval | 3.087% | 2.979% |
| Control Plane synchronous work, first/last 60 cycles | 5.07 ms | 4.36 ms |
| Repository synchronous work, first/last 60 cycles | 10.38 ms | 9.14 ms |
| Launcher synchronous work, first/last 60 cycles | 7.41 ms | 6.39 ms |
| Keyboard class toggle, first/last 60 cycles | 0.206 ms | 0.015 ms |

RAF averaged **14.90 FPS**, with **366.65 ms** worst frame. The 8,939 intervals included 8,159 >16.7 ms and 8,158 >33 ms. There were **39 tasks >50 ms**, including **19 >100 ms**. Full-minute frame rates were approximately 15.6, 15.1, 14.1, 15.5, 15.1, 14.9, 15.1, 15.0 and 14.8; the final partial interval was 13.7 FPS. No monotonic latency/CPU deterioration or retained-listener growth was demonstrated. Working set rose 9.64 MiB; the test does not prove absence of every native/GPU leak.

The remaining long tasks are a limitation: no action-correlated CPU trace was captured during the soak, so their cause is not assigned to a guessed subsystem. This phase **does not meet a universal no->100-ms-stall or 60-FPS claim**. Reducing decorative load improved the paired idle measurement while preserving appearance/function, but did not eliminate the VM's rendering limits.

Named counters over the run:

| Counter | Calls | Approximate rate |
| --- | ---: | ---: |
| IPC invoke handlers | 512 | 0.85/s |
| Main → renderer sends | 871 | 1.45/s |
| i3 tree requests | 333 | 0.56/s |
| Repository global refresh | 0 | 0/s |
| Desktop discovery scan | 0 | 0/s |
| `readdirSync` | 20 | 0.033/s |
| `readFileSync` | 396 | 0.66/s |
| `readSync` | 976 | 1.63/s |
| `lstatSync` | 3,129 | 5.22/s |
| `realpathSync` | 2,460 | 4.10/s |

These counters include fixture activity and normal service work. Functional telemetry stayed live. End-of-run health: secure renderer, Control Plane, terminal, network, globe, repositories, registry, window sync and AutomationEngine OK; Launch Doctor diagnosis available; profile NORMAL. System telemetry was truthfully DEGRADED because the VM's process sensor intermittently timed out, also observed before optimization.

Stop condition reached: baseline recorded, two measured hotspots addressed, identical comparison obtained, 63 regression suites and static checks passed, one GUI acceptance and one bounded soak completed, and limitations documented. No further performance searches or soak reruns were performed.
