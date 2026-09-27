# NOMAD V0.6.8 — system polish and resilience

This phase continues the dirty working tree; no commit, reset, dependency update, manifest change, or architectural replacement was performed. The newer implementation request supersedes the original read-only V0.1 instructions in AGENTS.md. The existing eDEX palette, typography, tactical frames, terminal, ASCII animation and trusted execution model remain the foundation.

## Existing functionality retained

V0.6 already provided the isolated production renderer, frozen preload bridge, authenticated terminal, main-side telemetry, keyboard, repository actions, workspace/i3 integration and security profiles. V0.6.5 provided explicit login, deterministic Control Plane intents, supervised project setup and trusted application discovery/registration. V0.6.7 provided Launch Doctor, runtime selection, dependency diagnosis, explicit repair-and-run authorization, bounded diagnostic output and UNKNOWN classification. These paths were exercised rather than reimplemented.

The incoming uncommitted tree also contained initial V0.6.8 CSS, health checks, intent history/help, terminal reconnect, telemetry recovery, cleanup, log limits and GUI tests. This continuation reviewed those changes, fixed additional failures, extended regressions and added this report.

## Component ownership

| Area | Production owner |
| --- | --- |
| Bootstrap, layout mounting, settings, focus routing | `src/_renderer_secure.js`, `src/ui-secure.html` |
| Terminal | `SecureTerminalClient`, xterm, existing main-side terminal service and authenticated WebSocket transport |
| Virtual keyboard | `SecureKeyboard`, `assets/css/keyboard.css`, trusted keyboard JSON projection |
| Repository browser/actions/run selector | `RepositoryLauncher`, `repository.css`, main-side repository/run-selection services |
| Left system panel | `SecureClock`, `SecureSystemTelemetry` in `secureTelemetry.class.js`; main-side `RendererTelemetryService` |
| Right network/globe panel | `SecureNetworkTelemetry`, `SecureLocationGlobe`, existing ENCOM renderer |
| Workspaces/app launcher | `WorkspaceManager`, `ApplicationLauncher`, `I3WorkspaceClient`, main-side `I3WindowManager` and application registry |
| Control Plane/Doctor/security | `ControlPlaneView`, `ControlPlaneService`, deterministic parser, trusted action registry, automation engine and Launch Doctor |
| Login | `LoginExperience`, `AsciiWaveBackground`, `login.css` |
| Layout/themes | Existing module CSS, `workspace.css`, `extra_ratios.css`, trusted theme projection; final secure-only `system_polish.css` invariants |
| Settings | Existing settings bridge/service; renderer settings form in `_renderer_secure.js` |

Legacy Node-enabled eDEX components are not the production secure renderer. No renderer filesystem/process access or generic IPC was added.

## Visual fixes and invariants

* The upper HUD retains 17% / 66% / 17% column references. A real 1920×1200 failure exposed an old 16:10 rule widening side columns to 17.5%; the secure override removes that overlap.
* Workspace and bottom panels have independent anchors. Keyboard visibility changes repository width without moving the terminal. The repository heading/container follows its actual width throughout the transition.
* A real 1920×1080-at-150% failure exposed the security strip extending into the keyboard. A shared, responsive globe placeholder/canvas height reserves room for the security strip at small CSS viewport heights.
* Globe initialization reserves its eventual display rectangle. Hidden telemetry status lines retain space. CPU summary columns use equal grid tracks; long values ellipsize rather than collide.
* Repository actions are clamped to the viewport and scroll vertically when necessary. Form controls can shrink; help text wraps; field labels and values use consistent grid tracks.
* Low-height login rules preserve the centered card, confirmation and seven status cells. The ASCII renderer, character ramp, noise, colors and reveal animation are unchanged.
* Shared tokens: 1 CSS-pixel line, 4px spacing unit, 24px minimum action height; fast 110ms, normal 170ms, slow 240ms; one technical easing. Interactive colors/borders use fast timing and keyboard/repository transitions use normal timing. Reduced-motion sets these timings to zero. The approved login reveal remains unchanged.

The invariants use CSS pixels. Fractional device-pixel rasterization at 125%/150% is not claimed to disappear; geometry assertions use 2px tolerance. Legacy theme variants with their own injected geometry are outside this default-production-theme matrix.

## Performance and lifecycle

Main-side system/network publication remains once per second, with existing single-flight collection, slower sensor caches and timeouts. No accuracy reduction or new sampler loop was introduced. CPU/traffic charts remain capped at their existing useful paint cadence; history is explicitly limited to 600 samples even while paints are stopped. Text writes skip identical content.

Hidden/minimized documents and login stop chart/globe painting. Resume reuses the current globe and one animation loop. The globe is also initially paused during login. A five-second watchdog marks channels stale after ten seconds and permits one resubscription/read recovery per channel per dashboard lifetime. A failed resubscription is caught, stays unavailable, and exhausts the retry budget. No service or application restart loop is introduced.

Keyboard cleanup removes document/blur handlers and key timers. Terminal cleanup removes wheel/state handlers and reconnect timers. Workspace cleanup disconnects ResizeObserver, resize and bridge subscriptions; initialization is idempotent and outstanding request bookkeeping is bounded to 128 entries with expiry. Control Plane initialization/destruction is idempotent and closing/reopening invalidates late responses, including health results. Dashboard disposal stops charts, clock, watchdog, staggered panel timers and globe resources; late telemetry cannot revive a disposed view.

The existing login teardown already stops its RAF, clock and listeners and releases canvas resources. Real GUI acceptance checks that its frame counter stops after entry. No hidden login loop was added.

## State, recovery and health

i3 observations coalesce concurrent tree reads and emit/log changes rather than every unchanged poll. A remembered container must still match the trusted window identity; disappearance or identity replacement clears stale state. Known trusted classes can be rediscovered. No identity is inferred from titles or arbitrary executable paths.

Repository refreshes coalesce. Removing the selected repository clears selection/context and closes its menu. Existing manifest/runtime fingerprints invalidate stale run profiles and trust; the GUI exercises this. Unexpected exits retain existing supervised STOPPED/FAILED transitions and Launch Doctor classification.

Terminal abnormal disconnects permit at most two reconnect attempts per client lifetime. Each attempt requests a fresh capability through the existing port-scoped bridge; failed recovery gives a factual unavailable message. Normal shell exits do not reconnect.

`SYSTEM CHECK` in the Control Plane, `system check`, and `comprueba el sistema` use existing read-only bridge probes. Renderer isolation, Control Plane, terminal transport, system/network telemetry freshness, globe paint/paused state, repositories, application registry, recent WM observation, selected security profile, automation list and selected-repository Doctor diagnosis are reported separately. Probes time out after three seconds. Missing evidence remains UNKNOWN; incomplete/offline data is DEGRADED; failed probes are not fabricated as green. Doctor without a selected repository remains UNKNOWN. A health check does not repair, authorize or launch anything.

## Interaction and errors

The assistant retains up to 50 session-only intents. Up/Down preserves an unfinished draft; Tab completes a unique prefix from the trusted index. `help`, `commands` and `?` show PROJECTS, APPLICATIONS, SECURITY and SYSTEM with supported examples. Index buttons populate the input; execution still requires Enter and the existing trusted parser/authorization flow. There is no shell fallback.

Failure presentation adds CAUSE / STATUS / NEXT ACTION and a supported-command route. Existing diagnostic/setup views and raw log access remain separate. RUN with no profile focuses RUN PROFILE; setup-required RUN retains V0.6.7's repair panel; policy blocks retain their existing explanation. Existing install/discovery/registration and identity repair remain policy-bound. Canonical user-facing selector wording is RUN PROFILE; backend lifecycle states are not renamed.

## Logs and caches

CLI session logs are capped at 2 MiB with two prior archives. Rotation occurs on a logger's first write near its limit; the active session is never truncated to make space. Targets are revalidated for ownership, permissions, links and file type. Existing credential redaction remains. Ordinary supervised run logs now also stop writing at a 2 MiB cumulative budget, while both output pipes keep draining so verbose children cannot stall. Setup/Doctor output retains its 64 KiB budget. Existing raw project log content is not a guarantee of arbitrary-secret detection; projects can print their own secrets, and these files remain private.

No broad cache or secret cache was added. Existing derived inspection/runtime projections and fingerprint invalidation remain; health reads live projections. CLI archives have a count-based retention policy. There is no new global age-based deletion of repository logs or current-session evidence.

## Development diagnostics and reproduction

Run `python3 test/run-secure-i3-gui.py --polish --layout-only` for geometry/screenshots or `python3 test/run-secure-i3-gui.py --polish --soak-seconds 600` for full acceptance and a ten-minute wall-clock soak. Use `--soak-seconds 1800` for the full 30-minute procedure. The private Xwayland/i3 display is authenticated and uses disposable repositories, registries and known fixture applications. It does not edit host projects or kill unrelated applications.

Artifacts go to `/tmp/nomad-v068/`: login/main geometry JSON, scale screenshots, repository-selected screenshots, Control Plane, launcher, startup timing, soak progress and final metrics. The development-only bounds/grid overlay is `test/support/visualAudit.js`, injected only by the test harness; no production command, bridge permission or script import enables it. CDP supplies real DOM/listener, heap, task and process counters. Global production timers/listeners are not monkey-patched; unavailable counts are not presented as zero.

Fault injection is fixture-only: telemetry channel throws/stalls/offline snapshots, WebSocket abnormal close, replaced/disappearing trusted i3 windows, manifest/profile invalidation, unexpected project exit and cancelled setup. No production fault endpoint exists.

The soak cycles Control Plane, repository selection, launcher, keyboard, terminal tabs/activity and a registered app while telemetry/globe continue. Full acceptance before the soak additionally executes real RUN/STOP, failed runs, dependency repair and setup cancellation. Those project setup/run operations are not repeated every soak cycle. For full manual acceptance, also repeat RUN/STOP/Doctor throughout the 30 minutes and record process groups at startup, 5, 15 and 30 minutes.

Budgets are diagnostic warnings: common feedback under 100ms, warm preflight roughly under 150ms, stable post-warmup heap/listener trends, bounded history/logs, no duplicate loops. Hardware-dependent FPS/RSS/CPU are measurements, not brittle CI pass thresholds. Feedback timings measure synchronous UI work, not full IPC completion or end-to-end display latency.

## Validation coverage and limitations

The geometry matrix covers 1920×1080, 1920×1200, 1600×900, 1366×768 and resized 1200×800 at 100%, 125%, 150%. Electron zoom emulates CSS scaling; this does not certify all native compositor/DPI configurations. Assertions cover card centering/footer/status containment, usable workspace, non-overlapping columns, repository/actions inside the viewport, security/keyboard separation and stable workspace height during keyboard transitions.

Regression suites cover stale repository/profile/window state, unexpected exit, bounded terminal/telemetry recovery, idempotent timers/subscriptions, login stop, repeated Control Plane/keyboard ownership, chart bounds, process-group STOP/cancel, help/history/autocomplete, profile focus, repair flow, truthful UNKNOWN, secure preload and LOCKDOWN. The root historical `npm test` performs dependency installation and external Snyk work; repository `test/*.test.js` suites are the regression runner instead.

No before-change performance baseline of an identical clean VM was captured, so no percentage speedup is claimed. First GUI preflight measurements were 47ms and 60ms on subsequent runs; they are repeated observations, not a controlled before/after comparison. Dedicated GDM start/authentication, real user CODE/BROWSER profiles, every theme, physical DPI changes, idle hardware power/CPU and proof of no memory leak remain outside the automated acceptance. Final measurements below record only completed runs.

## Resumed final validation — 2026-09-26

### Handoff and scope

The handoff reported 62 passing suites (60 sandbox-compatible plus two permission-required suites), 150 JS syntax checks, Python/diff checks, 30 login/HUD combinations, RUN/STOP, Doctor repair/cancel, i3, terminal, keyboard and live telemetry/globe acceptance. Those are historical reports, not measurements reconstructed from this session. The working tree already contained the functionality and wall-clock soak correction described above. Old `/tmp` evidence was absent at the start of this continuation, so the interrupted soak's completion could not be established.

The remaining work was the corrected soak, metric interpretation, keyboard/layout investigation, final regressions and documentation. No feature architecture, dependency, security permission, manifest or lockfile was replaced. No commit or reset was performed.

### Concrete findings and changes in this continuation

* Fixed-time screenshot waits were insufficient on this slow VM: repository width could still change after the nominal 350ms delay, and a keyboard-open screenshot could contain an earlier hidden frame. The harness now resolves styles, waits for actual CSS transition completion with a five-second failure bound, compares geometry again after 350ms, checks visibility/opacity and every key's bounds, and waits for two animation frames before keyboard captures. It keeps the 2 CSS-pixel geometry tolerance.
* The stronger assertions found actual key overflow in the additional 1200×800 resize case and the native VM window's near-16:10 usable area: keys crossed the repository boundary and the bottom arrow row extended offscreen. A narrow-aspect CSS rule reduces gaps, adjusts the bottom-row offset and spacebar width, and preserves zero gaps between arrow keys. The 161:100 breakpoint includes integer CSS viewport rounding at 150% scaling and windows slightly narrower than 16:10. It affects 16:10/narrow layouts; 16:9 layouts retain their existing key dimensions and spacing.
* Screenshot review found the globe vertically compressed at small scaled heights. CSS permits a 50px-high reserved canvas, while initialization/resize previously imposed a 120px minimum backing height and 160px width. Rendering dimensions and camera projection now follow the displayed CSS dimensions. A 120×54 regression and GUI aspect assertion guard this mismatch. No new paint loop was added.
* Added an opt-in `NOMAD_GUI_RETAINED_AUDIT=1` development probe using CDP garbage collection before/after a follow-up soak, and a real subsystem health snapshot. This does not instrument or monkey-patch production timers or listeners.

### Completed ten-minute soak: measured results

The fresh full acceptance completed successfully before the narrow keyboard/globe corrections. Its evidence is preserved separately in `/tmp/nomad-v068-600s/` and `/tmp/nomad-v068-gui-final.log`. The run requested 600 seconds, completed **600.041 real seconds**, and executed **457 cycles**, with samples approximately once per minute. The duration includes action work and waits; it is not a cycle count. The final corrections require the separate follow-up acceptance described below; the ten-minute figures must not be represented as a post-fix ten-minute run.

Each cycle exercised Control Plane, repository selection, application launcher and keyboard toggle. Every tenth cycle switched terminal tabs and wrote a harmless command. Every sixtieth cycle opened/closed the registered GUI fixture and returned to the terminal. Telemetry and globe remained active. Real RUN/STOP, failed setup/run, Doctor repair, cancellation, application lifecycle and security refusal ran in broad acceptance before the soak, rather than repeatedly inside its loop. No continuous orphan-process or window-mismatch counter was implemented.

| Measurement | First | Last | Interpretation |
| --- | ---: | ---: | --- |
| Renderer JS heap used | 8,315,000 B | 8,394,224 B | +79,224 B; sampled maximum 9,165,092 B, then reclaimed |
| Renderer working set | 205,600 KiB | 213,732 KiB | +8,132 KiB (7.94 MiB); sampled peak 214,184 KiB |
| Allocated JS heap | 10,403,840 B | 11,452,416 B | +1 MiB capacity; used heap did not track this monotonically |
| Raw DOM listeners | 511 | 1,122 | Not stable; ranged 511–1,122, with intermediate drops to 618 and 576 |
| DOM nodes | 6,287 | 10,063 | Raw allocation counts include objects awaiting collection |
| Documents | 1 | 1 | No extra retained document observed |
| Renderer CPU | initial 0% | 3.22% | Electron process samples after baseline: 3.13–3.29%; not whole-system/idle CPU |

**RAF average: 11.896 FPS; worst frame: 449.982ms.** These are performance warnings, not evidence of fluid 60FPS behavior. Only aggregate FPS/worst frame were captured: falling FPS over time cannot be evaluated from this run. Renderer task duration accumulated 109.52 seconds during the soak. Login's separate observation measured 224 frames in 20 seconds (11.2 FPS), under the existing 30FPS cap.

Used heap repeatedly fell and ended within 0.08 MiB of its baseline; this supports no observed unbounded JS-heap growth during this ten-minute workload. Working set rose modestly and mostly levelled in the later samples, but neither that pattern nor a short run proves absence of a native/GPU memory leak. Raw listener counts did **not** reproduce the handoff's stable 870 count; allocation/reclamation must be distinguished from retained ownership. Total live timer counts were not measured; lifecycle regressions use deterministic timer/subscription fakes instead.

| Synchronous feedback | Median | p95 | Maximum | First / last third mean |
| --- | ---: | ---: | ---: | ---: |
| Control Plane | 3.94ms | 11.63ms | 31.10ms | 4.79 / 5.76ms |
| Repository selection | 11.06ms | 24.51ms | 49.13ms | 11.56 / 13.49ms |
| Application launcher | 6.70ms | 16.69ms | 32.99ms | 7.48 / 7.92ms |
| Keyboard class toggle | 0.015ms | 0.030ms | 5.80ms | 0.028 / 0.019ms |

None of these 457-cycle feedback observations exceeded 100ms. Small increases in some averages were not runaway latency; these timings exclude IPC completion, CSS animation and display presentation. RUN feedback was exercised but not independently timed. Doctor preflight measured **32ms** in this run, below the 150ms reference goal.

Startup observations were **4,461ms to first visible**, **5,197ms to login ready**, and **8,248ms from entry request to the harness's interactive checkpoint**. The last interval includes intentional reveal timing, polling, a 300ms frame-stop check and screenshot work; it is not a pure application-interactive latency. The login matrix and explicit 20-second login wait are excluded by measuring entry separately.

There were 13 process-sensor unavailable warnings in the full acceptance/soak log, including timeout/still-unavailable messages, and no logged uncaught/unhandled error or GUI assertion failure. The process sensor was therefore intermittently degraded, not universally healthy. Live acceptance recorded 20 distinct CPU, RAM and network observations and 30 globe observations; later live checks continued advancing. Unit fault tests confirm truthful stale/offline output, recovery and the one-attempt channel recovery budget. No sensor values were fabricated.

### Post-fix acceptance

After the keyboard/globe corrections, full production GUI acceptance passed again, including 15 login and 15 HUD resolution/scale combinations, per-key containment, settled keyboard geometry, globe projection, native-window keyboard captures, RUN/STOP, Doctor repair/cancel, real generic/VLC i3 lifecycle, terminal, input capture and live telemetry. Requested resolutions were 1366×768, 1600×900, 1920×1080 and 1920×1200 at 100%, 125%, 150%; the additional 1200×800 resize was also covered at all three scales.

The first post-fix follow-up completed **120.014 seconds / 94 cycles**, with **13.301 FPS** and **266.656ms worst frame**. Its metrics and health snapshot are preserved in `/tmp/nomad-v068-postfix120/`. This is not a controlled speedup comparison. Its optional retained audit did not run because production boot removed the environment flag; the harness now captures that flag at module load before boot. The separate retained audit warms both terminal tabs before its baseline so creating a second terminal is not mistaken for a listener leak.

The actual health snapshot reported SECURE RENDERER, CONTROL PLANE, TERMINAL, NETWORK, GLOBE, REPOSITORIES, APPLICATION REGISTRY, WINDOW SYNC and AUTOMATION ENGINE as OK; TELEMETRY was DEGRADED; SECURITY PROFILE was NORMAL; LAUNCH DOCTOR was OK — DIAGNOSIS AVAILABLE. UNKNOWN/DEGRADED behavior is additionally exercised by the unit health tests. The UI did not substitute a universal green status for unavailable sensors.

Screenshot review included native keyboard open/closed, small 150% HUD/login, narrow 1200×800 and 16:10 cases. The screenshot surface is limited by the native VM window (1853×1168 in this run); larger emulated viewports can be cropped in captures even though full logical-viewport geometry is checked. Thus the automated matrix is a geometry/emulated-scaling result, not proof of uncropped native screenshots at every physical resolution. The native keyboard-open screenshot now visibly contains the keys after transition completion; small-height globe screenshots preserve circular projection. Actual compositor DPI, full-resolution raster review and frame-by-frame flashing review remain manual.

Reconciliation coverage passed for disappeared/replaced app windows, stale repository/profile selection, unexpected process exit, two-attempt authenticated terminal recovery and one-attempt telemetry recovery. Login cleanup tests and GUI frame-stop assertions confirm cancelled RAF, removed pointer/resize/input listeners, released canvas and no continuing hidden login animation. Launcher/Control Plane lifecycle tests confirm bounded ownership; no duplicate hot loop was demonstrated or added.

The continuation changed exactly these existing working-tree files (several were already untracked/modified at handoff):

* `src/assets/css/system_polish.css`: narrow/near-16:10 keyboard containment.
* `src/classes/secureTelemetry.class.js`: globe dimensions/projection follow the CSS rectangle.
* `test/secureTelemetry.test.js`: small-canvas projection regression.
* `test/systemPolish.gui.js`: transition-aware keyboard assertions/captures, globe aspect assertion, opt-in warmed retained-listener audit and health evidence.
* `docs/NOMAD-V0.6.8-SYSTEM-POLISH.md`: measured results, provenance, limitations and manual checklist.

### Final verification and manual VM acceptance

The first fresh regression pass reproduced 60 sandbox passes and two failures requiring local process/port access. Launch Doctor and process manager both passed outside the sandbox. A subsequent permission-enabled full run passed all 62 suites. Static verification checked 153 first-party/non-vendored JS files, Python parsing without creating bytecode, unchanged root/src manifests and lockfiles, and clean `git diff --check`. There were no changed shell scripts requiring `bash -n`. Production-source scanning found no `shell:true`; all 14 first-party scripts loaded by secure HTML were free of generic execution/IPC APIs. Runtime GUI isolation and policy/transport/automation regressions also passed. These scans supplement the existing security tests, not a new formal security audit.

The following dedicated VM checks remain necessary for claims beyond the automated environment:

1. Start NOMAD through the real GDM session; confirm the approved dark login shade, explicit entry and live ASCII animation. Enter once and verify the login disappears without a continuing animation loop.
2. At native display settings, test 1366×768, 1600×900, 1920×1080 and 1920×1200 at 100%, 125% and 150%. Confirm panel/corner alignment, readable controls and the status strip. Electron zoom/device emulation does not certify compositor DPI behavior.
3. At every size/scale, toggle the keyboard repeatedly through SETTINGS → SAVE, including while a repository is selected. Check keys, repository boundary, workspace controls and settled geometry; also resize to 1200×800. Verify physical and virtual keys, modifiers, repeat/release and password mode.
4. Run `python3 test/run-secure-i3-gui.py --polish --soak-seconds 600` for a post-fix ten-minute baseline; use 1800 for a 30-minute extension. Preserve its JSON/logs. For a retained-object comparison, separately run `NOMAD_GUI_RETAINED_AUDIT=1 python3 test/run-secure-i3-gui.py --polish --soak-seconds 120`; forced collection perturbs timing.
5. During a 30-minute interactive session, repeat RUN → STOP, authorized Doctor repair → cancel, failed setup, terminal tab activity, Control Plane/help/history and application open → close. Use actual trusted CODE/BROWSER profiles as well as the fixture. Compare only tracked PID/session/process groups at start, 5, 15 and 30 minutes; do not kill unrelated processes.
6. Temporarily disconnect/reconnect networking; check factual OFFLINE/DEGRADED output and recovery. Minimize/restore NOMAD and confirm globe/graphs resume without duplicate animation. Check unavailable sensors remain unavailable rather than showing invented values.
7. Run SYSTEM CHECK before/after those actions. Confirm UNKNOWN/DEGRADED where evidence is missing, selected profile accuracy, recent window observations and Doctor's selected-repository requirement. Exercise unsupported commands and NORMAL/PUBLIC/LOCKDOWN without enabling a shell fallback.
8. Measure idle CPU, frame-time distribution and native/GPU memory on the target hardware. Review a longer memory/listener trend and actual compositor rendering before claiming smoothness or absence of leaks. Test additional themes separately.
