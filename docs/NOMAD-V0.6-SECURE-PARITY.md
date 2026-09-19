# NOMAD V0.6 secure renderer parity and acceptance report

## Current-tree continuation (2026-09-19)

The continuation inspected `AGENTS.md`, status, diffs, changed/new implementations and tests before editing. The migration described below was already present and was preserved. Nothing was committed; dependencies were unchanged.

Remaining work found and completed:

- Fixed an observed workspace race: an old native ACTIVE observation could undo a newer tab selection while its launch/focus request was pending. Runtime state still updates, and later native focus observations still work. A behavioral regression test covers both cases.
- Repaired the unfinished private GUI harness: match the production product name/WM_CLASS, declare the nested session as X11, remove an unsupported VLC flag, and wait for native mapping/resize debounce before testing geometry. Test-only native stderr and failure window identities make failures diagnosable.
- Expanded real runtime acceptance beyond advancing timestamps: foreground-stop X, actual CPU/RAM/traffic values, actual Smoothie render calls and changing globe camera coordinates.

Only these five files were changed by this continuation: `src/classes/i3WorkspaceClient.class.js`, `test/i3WorkspaceClient.test.js`, `test/secureProduction.gui.js`, `test/run-secure-i3-gui.py`, and this report. Other dirty-tree changes predate it.

The final private authenticated Xwayland/i3 run passed using the real production boot, isolated renderer, real OS probes, authenticated PTYs, real xmessage and VLC. During 30 observations spaced at least one second apart it recorded **25 distinct CPU readings, 25 RAM readings, 22 network counter pairs, 30 globe camera positions, 1,366 CPU chart paints and 1,366 network chart paints**. The fixed main-side 30-second progression diagnostic passed twice. No screenshots, mock production data or synthetic changing values were used.

| Acceptance area | Current evidence |
| --- | --- |
| System | CPU/RAM changes, clock, system samples and chart paints passed; unsupported/timed-out sensors remain factually unavailable without freezing other modules |
| Network/globe | Network counter changes, traffic paints, GeoIP initialization and actual camera motion passed |
| Repositories | One repository populated; selection survived refresh; action/authorization/context suites passed; real CODE/GITHUB/RUN/STOP/PULL workflows remain VM acceptance items |
| Workspace/apps | Real generic app and VLC passed launch, native focus, geometry, minimize/restore, fullscreen, MRU, terminal return and close; actual CODE/BROWSER profiles need VM checks |
| Keyboard/Control Plane | Pointer feedback, terminal routing, native Ctrl+Space and Ctrl+A/C/V, captured virtual Enter and read-only security intent passed; contextual Spanish run/stop and application intents pass service/parser tests |
| Terminal | Authenticated input/output, extra-tab close/reopen, duplicate activation and foreground-stop X passed |
| Security | Actual production isolation/absent globals/disabled DevTools passed; named frozen bridge, CSP and forbidden-renderer dependency tests passed; no security settings changed in this continuation |

Validation: **56/56 test suites**, **133 first-party JavaScript syntax checks**, changed-shell `bash -n`, and `git diff --check` pass. All four root/src package manifests and lockfiles equal HEAD byte-for-byte (SHA-256 checked). The 11 first-party scripts loaded by production HTML pass the forbidden API scan. Broader source matches belong to privileged main/preload code, unloaded development renderer code, or conservative security-audit defaults—not production BrowserWindow settings. No `shell: true` or sandbox-bypass flag was found in first-party source/scripts.

This establishes live production behavior in the available nested GUI environment. It does **not** certify dedicated GDM login, the VM's CODE/BROWSER profiles, every real repository action, or pixel-identical legacy presentation. V0.6 release acceptance remains pending those explicit VM checks below.

The following architecture and earlier repair notes are retained for context; current evidence above supersedes their earlier test counts and native-i3 limitations.

This repair was performed on an already dirty working tree. At the beginning of this turn, the secure telemetry service/dashboard, secure keyboard, repository bridge integration, workspace integration and associated tests were already present as uncommitted work. The initial production run initialized them successfully. The earlier reported static shell cannot therefore be attributed to a reproduced failure of this exact starting tree. This report distinguishes that existing migration from the additional regressions fixed and validations performed here. No dependencies or manifests were changed; nothing was committed.

## 1–3. Legacy-to-secure parity map

All paths below are relative to the repository. Legacy entrypoint: `src/ui.html` → `src/_renderer.js`. Production entrypoint: `src/ui-secure.html` → `src/_renderer_secure.js`. The production renderer uses browser scripts and a frozen `window.nomad` bridge, not legacy Node classes.

| Feature / legacy source | Required DOM | Data and privilege in legacy | Loop / events | Secure implementation and status |
| --- | --- | --- | --- | --- |
| `Clock`, `classes/clock.class.js` | `mod_clock`, `mod_clock_text` | Local wall clock; no OS privileges needed | 1 second | `SecureClock` in `secureTelemetry.class.js`; actual time, twelve-hour mode, verified advancing |
| `Sysinfo`, `sysinfo.class.js` | `mod_sysinfo` date/uptime/type/power children | `os.platform/uptime`, `si.battery` | Legacy uptime 60 s, battery 3 s, midnight date timeout | Trusted runtime/power projection; date and uptime render with system samples |
| `HardwareInspector` | `mod_hardwareInspector`, manufacturer/model/chassis IDs | `si.system/chassis` | 20 s | Trusted, bounded hardware fields; refreshed on the same 20 s cadence |
| `Cpuinfo` | `mod_cpuinfo`, two canvases, counters, temperature/speed/tasks | `si.cpu/currentLoad/cpuTemperature/processes`; Node-loaded Smoothie | Legacy load 500 ms, speed 1 s, temp 2 s, tasks 5 s | Main-side readings; browser Smoothie charts, per-core real samples, unavailable-state handling |
| `RAMwatcher` | `mod_ramwatcher`, 440 points, swap bar/text | `si.mem` | Legacy 1.5 s | Main-side memory projection; original point-grid visualization and swap update every system sample |
| `Toplist`, process-list modal | `mod_toplist_table`, `processContainer`, `processList` | `si.processes`; legacy modal | Top five 2 s, modal 1 s; click/sort/Escape | Read-only sanitized process projection; interactive sortable overlay, restored CSS, bounded 512 entries sorted by activity before truncation |
| `Netstat` | `mod_netstat`, interface/state/IP/ping IDs | `si.networkInterfaces`, Node TCP/HTTPS, GeoLite/MaxMind, remote user-data path | Legacy 2 s status, 1.9 s ping timeout | Main-side fixed-target probe and endpoint lookup; renderer receives selected-interface fields and geographic coordinates |
| `Conninfo` | `mod_conninfo`, two traffic canvases, totals | `si.networkStats`; Node Smoothie/pretty-bytes | 1 s samples and animated graphs | Browser Smoothie, real upload/download samples and byte counters; missing data does not generate zero samples |
| `LocationGlobe` | `mod_globe`, inner container, canvas, coordinate header | Local grid/ENCOM bundle; GeoIP and `si.networkConnections` | ~30 fps, location 1 s, peers 3 s; resize | Original browser ENCOM globe/grid, animation and resize, real endpoint/peer-location pins; no raw peer addresses/ports/PIDs projected |
| `Terminal`, `terminal.class.js` | `terminal0`–`terminal4`, shell tabs | Node/Electron xterm setup, PTY/WebSocket | Socket open/data/close, process events, fit/resize, clipboard | `SecureTerminalClient`, authenticated loopback socket, named lifecycle calls; extra-tab race/close/process labels fixed |
| `Keyboard`, `keyboard.class.js` | Original keyboard rows, key classes, modifier/password datasets, SVG arrows | Layout read with renderer `fs`; direct terminal calls | Pointer/touch, physical keydown/up, hold-repeat, blink, blur | Trusted layout + `SecureKeyboard`; SVG symbols, pointer capture/release, terminal/captured-input routing, virtual assistant Enter; tested native editing |
| Workspace / launcher | `workspace_slots`, `workspace_slot_add`, viewport and views | Shared `WorkspaceManager`, `ApplicationLauncher`, `I3WorkspaceClient`; Electron IPC/bounds | Subscribe/operations, observed state, MRU, resize debounce | Same shared classes with named bridge adapter and main-computed geometry; trusted initial state snapshot, active-first/MRU behavior retained |
| `RepositoryLauncher` | `repository`, add trigger, container/menu | Trusted `RepositoryService` projections/actions in legacy NOMAD | Initial refresh, selection, action clicks, process/Git state | Same component with opaque repository IDs; CODE/TERMINAL/INFO/GITHUB/RUN/STOP, reviewed PULL/CLONE, contextual Control Plane; coalesced refresh |
| Security HUD | Right security strip | Main security services | Status refresh and commands | Control Plane plus compact strip; profile/enforcement/confirmation/intent services retained |
| Theme/layout/audio/intro | Original columns/shell/keyboard/repository geometry | Legacy renderer reads JSON/fonts/audio through Node, injects theme | Boot title/glitch, panel fade, keyboard animation, audio feedback | Bundled original CSS/fonts/audio/augmented-ui; trusted theme projection; font load before canvas/terminal initialization; optional title/glitch/welcome animation |
| Settings and shortcuts | Secure settings overlay | Legacy settings JSON, remote shell/editor/global shortcuts | Save/reload, theme/layout selection, shortcut events | Named allowlisted settings/theme/layout APIs; no arbitrary command shortcuts or generic file APIs |

`Filesystem`, `DocReader`, `MediaPlayer`, `FuzzyFinder` scripts/CSS are loaded by legacy HTML, but the current NOMAD `initUI()` does not instantiate a filesystem browser. The bottom panel is `RepositoryLauncher`; `window.fsDisp` shortcuts are conditional no-ops. These inactive legacy file readers were not imported into production. VLC is a registered managed application, not that inactive embedded media player.

The shell-only migration omitted or replaced the initializers that create module DOM and start their loops. Simply loading column CSS cannot display these modules: the CSS also waits for column activation and staggered animation state. The migration already in this working tree supplies those initializers, datasets and assets. Remaining defects found here included unbounded sensor waits, stale values after partial failure, missing process-overlay styling, virtual Enter dispatching only `change`, no extra-terminal close cleanup, duplicate tab creation, and tab cycling creating shells instead of visiting open shells.

## 4–5. Trusted system and network services

`src/classes/rendererTelemetryService.js` owns OS/systeminformation, TCP latency, fixed HTTPS external-address lookup and GeoIP database access. Hardware serial numbers, process command lines/paths, raw peer addresses/ports and peer process identities are excluded. Display PIDs in the read-only process table are observations, never accepted as action targets.

Each underlying probe is bounded for consumers and single-flight. A stuck probe stays in-flight rather than spawning more OS probes every interval. A timed-out sensor becomes unavailable; other fields continue. Recovery is possible when the underlying operation settles. Snapshot sequence numbers reject delayed/out-of-order renderer updates. Partial failures clear affected numeric displays, mark partial telemetry, and stop graphs that have no samples. A stale subscription becomes explicitly unavailable after 10 seconds.

Network rates below zero (systeminformation's unavailable sentinel) become `null`, not graph samples. Offline/unavailable traffic stops its chart rather than pretending to receive zeros. Missing GeoIP/endpoint results are labeled unavailable; the real globe still rotates. The static world-grid asset is geographic geometry, not a replacement image.

## 6–8. Repository, workspace and keyboard migration

Repositories use existing `RepositoryService` projections and existing named actions; no repository paths cross the bridge. PULL and CLONE retain Control Plane review. RUN retains profile/authorization handling, including Cargo; STOP remains supervised. Selection is preserved across refresh and shared with the Control Plane. Concurrent process/Git refreshes are coalesced.

Application registration, initial snapshots, observed state, launcher `+`, MRU/active-first tabs and external lifecycle remain in the shared workspace classes. No renderer i3 command or shell execution was added. The notes view now reflects its actual projected status. Main-side window management still calculates external geometry.

Virtual keyboard pointer presses use the existing trusted terminal connection or the currently captured native input. Enter now reaches the assistant's key handler. Focus capture cannot invoke terminal COPY/PASTE/tab shortcuts through virtual modifier combinations. Repeated pointer presses clear old repeat timers; lost capture and blur release keys. Arrow icons remain SVG paths, not text labels. The xterm key handler distinguishes keyup from keydown.

## 9–10. Animations and update intervals

| Work | Interval / trigger |
| --- | --- |
| System/network publication | 1 s requested cadence; no overlapping collection or publisher accumulation |
| CPU load/speed and RAM | Per system collection; 1 s target |
| CPU temperature | 2 s cache |
| Battery | 3 s cache |
| Processes/tasks | 5 s cache; process overlay rerenders from the current projection |
| Hardware identity/chassis | 20 s cache |
| Interface selection / latency | 5 s; latency socket timeout 1.9 s |
| External address/location | 60 s; HTTPS timeout 4 s |
| Connection geographic locations | 3 s; at most 64 peer lookups, 24 distinct projected locations |
| OS probe consumer timeout | 2.5 s; hung underlying probe is not duplicated |
| Initial renderer telemetry wait | At most 8 s; optional module failure does not replace the UI |
| CPU/network chart drawing | At most 30 fps; paused for missing/stale data and document hiding |
| Globe | One RAF loop throttled to ~30 fps, skipped while hidden |
| Clock | 1 s |
| Panel reveal / keyboard | Finite CSS transition sequences; original visual styling |
| Subscription watchdog | Every 5 s, stale after 10 s |
| Security strip | 30 s |
| Read-only runtime progression diagnostics | 5 s sampling; reports actual advancement across a 30 s window |

The process display cadence is intentionally less aggressive than the old modal's independent one-second process collection. No duplicate privileged polling is started when the overlay opens. Disposal unsubscribes and stops chart/clock/globe loops.

## 11–12. Bridge and security

The existing migration adds only these read-only telemetry channels:

- `nomad.system.telemetry.get` / `nomad.system.telemetry`
- `nomad.network.telemetry.get` / `nomad.network.telemetry`

Preload exposes `system.getTelemetry/subscribeTelemetry` and `network.getTelemetry/subscribeTelemetry`. Main checks the owning renderer and requires an empty request object. Selected interfaces, hosts, commands, paths and sensors are not renderer parameters. Existing named workspace snapshot and repository/control APIs are reused. This repair adds no new bridge capability.

Production continues to have `contextIsolation: true`, `nodeIntegration: false`, `enableRemoteModule: false`, DevTools disabled, restrictive CSP, web security and authenticated loopback terminal transport. Runtime verification checks absent `require/process/module` and the exact bridge keys. The compatibility renderer now requires explicit `NOMAD_DEVELOPMENT=1`; `NOMAD_PRODUCTION=1` always wins. No sandbox-bypass flag is added.

`TrustedActionRegistry`, NORMAL/PUBLIC/LOCKDOWN, parser-only assistant intents, application plans, repository authorization and single-use confirmation challenges remain intact. The UI ready message follows terminal, telemetry attempts, repository projection, workspace manager, keyboard and Control Plane initialization. Optional module failures are visible and logged without blanking other modules.

## 13. Files edited during this repair

- `src/_boot.js`: explicit development opt-in; attach fixed read-only progression diagnostics.
- `src/_renderer_secure.js`: fonts/intro, terminal tabs, dynamic notes status, coalesced repository refresh.
- `src/ui-secure.html`: process-list stylesheet.
- `src/classes/rendererTelemetryService.js`: bounded, cached, non-overlapping probes; partial failures; sorted bounded processes; negative-rate rejection.
- `src/classes/secureTelemetry.class.js`: isolated optional initialization, stale/partial handling, chart pause/recovery/disposal, process sort, truthful traffic, globe-loop failure state.
- `src/classes/rendererDiagnostics.js`: 30-second live progression reporting without sensitive values.
- `src/classes/secureKeyboard.class.js`: captured Enter, shortcut routing and repeat/capture release.
- `src/classes/secureTerminalClient.class.js`: physical keyup routing.
- `src/assets/css/control_plane.css`: angular process-list overlay styling.
- `test/rendererTelemetryService.test.js`, `test/secureKeyboard.test.js`, `test/secureRendererRegression.test.js`: added regression coverage.
- `test/secureTelemetry.test.js`: new behavioral DOM/subscription/graph/globe/clock/failure tests.
- `test/secureProduction.gui.js`: opt-in real Electron production acceptance harness with temporary configuration.
- This report.

Other already modified/untracked files shown by git status predate this repair and were preserved.

## 14–15. Validation and real GUI evidence

All 55 `test/*.test.js` suites pass. JavaScript syntax checks cover all changed/new JavaScript in the working tree, including pre-existing work. Shell syntax and `git diff --check` pass. Root/source manifests and lockfiles match HEAD byte-for-byte. Renderer dependency checks reject Node/Electron privileged APIs; the isolated runtime independently verifies missing globals. Browserified third-party bundles contain internal module-loader symbols; those are not host Node capabilities.

The actual `electron src --nointro` production UI ran for 55 seconds with its existing configuration. It logged bridge verification, runtime isolation passed, terminal connection and every critical module initialization. Its fixed read-only 30-second probe reported:

```
clock=ADVANCING system=ADVANCING network=ADVANCING cpu=ADVANCING
memory=ADVANCING traffic=ADVANCING globe=ADVANCING
repositories=1 workspace=1 terminal=READY keyboard=READY control=READY
```

A separate real Electron GUI acceptance harness exercised authenticated terminal input/output, pointer key highlighting, native Ctrl+Space, native Ctrl+A/C/V in assistant input, virtual Enter submission, repository selection across a trusted refresh, workspace launcher and 30-second progression. This is behavioral execution, not a DOM-presence-only assertion. Test values are confined to tests; production telemetry is real.

The environment has an X display but no available i3 IPC socket. Consequently this run cannot establish dedicated GDM login behavior, external CODE/BROWSER/VLC positioning, native external focus or fullscreen/minimize/close behavior. Those have unit/integration coverage and require the checklist below in the actual session. Missing Spotify/Obsidian desktop entries were reported factually. Some VM sensors timed out; the remaining UI kept updating.

## 16. Manual acceptance checklist

1. Log into the dedicated NOMAD GDM/i3 session; separately launch `NOMAD_PRODUCTION=1 ./node_modules/.bin/electron src --nointro`. Require the same interface and secure-isolation success log.
2. Wait at least 40 seconds after ready. Require advancing clock/system/network/CPU/memory/traffic/globe diagnostics; watch clock digits, CPU curves, memory points, traffic history and rotating world geometry. A steady measured value need not change numerically.
3. Inspect hardware, task counts, speeds, battery/uptime and temperatures when the host supplies them. Click top processes, sort each column, wait for refresh, then Escape. Missing sensors must show unavailable, not retained old values.
4. Verify network interface/state, byte totals, ping and legitimate geographic pins. Disconnect/reconnect networking; require factual offline/unavailable state and recovery without fabricated traffic or locations.
5. Select a repository. Refresh and check selection/context, INFO, CODE, TERMINAL and GITHUB. Check RUN with an authorized profile (including Cargo where available), supervised STOP, and PULL's review/challenge flow. Cancel PULL/CLONE review when only testing.
6. Use `+` to launch installed CODE, BROWSER, VLC and one generic registered app. Check active-first/MRU order, return to TERMINAL, hidden/restored state, viewport bounds, fullscreen, minimize and close. Check observed external changes update tabs.
7. Click virtual letters, arrows, Enter, modifiers and a held key. Release outside the key/window; ensure nothing repeats. Hide/show the keyboard in settings. Verify no ICON text replaces arrow artwork.
8. Open shell tabs by click/Ctrl+number. Repeated click must create one PTY; Ctrl+Tab visits open tabs. Exit an extra shell; its tab returns to EMPTY and can reopen.
9. Press Ctrl+Space, type a read-only intent such as `security status`, test native Ctrl+A/C/V, click virtual Enter, close with Escape. Input must not reach the terminal while captured; terminal focus must recover. Select a disposable runnable repository, submit `corre este repo`, review/authorize its exact run profile, verify it starts, then submit `para este repo` and verify it stops. Confirm the selected repository remains the command target after refresh. Run `sleep 30` in the main terminal, click its foreground-stop X, and verify the prompt returns and accepts input.
10. Review NORMAL/PUBLIC/LOCKDOWN status and confirmation plans without applying destructive changes. Verify raw shell-command intents are rejected and contextual repository/application targets remain correct.
11. Launch once without `--nointro` with intro enabled. Verify theme fonts, audio (if enabled), title glitch/welcome, panel reveal and keyboard reveal; no legacy renderer or Node-global access should appear.
12. Confirm production DevTools remain unavailable. Run the explicit GUI harness with `./node_modules/.bin/electron test/secureProduction.gui.js --nointro` when desired; it uses a temporary settings directory and performs a harmless terminal printf plus read-only assistant intent.

## 17. Remaining differences and limits

- Native i3/GDM external-window acceptance remains unverified in this desktop environment.
- Legacy random decorative satellite constellations are not reinstated as purported live network data. The world mesh, rotation and real endpoint/connection pins are present. No random live telemetry is used.
- The legacy upstream eDEX release-check popup is not migrated into NOMAD's secure production flow. It is separate from live desktop modules and would require a dedicated trusted update policy.
- Arbitrary shell shortcuts, legacy developer tools, raw file browsing/editing APIs and arbitrary settings paths are intentionally absent. Existing trusted named controls cover the supported workflows.
- Theme/settings changes reload the secure UI rather than using the old renderer's Node-based hot replacement. Intro timing is bounded and shorter; original fonts, geometry, theme colors and animation style are retained.
- Network “ONLINE” reflects an active external interface; ping and geographic availability are independent observations, rather than treating a blocked TCP ping as proof that all networking is down.
- Process output is bounded to 512 records and geographic connections to 24 unique locations. Unsupported sensors cannot be supplied by the renderer.

These limits prevent a claim of identical execution of every legacy utility. The live production desktop, its input paths and real telemetry progression were validated without a security rollback.
