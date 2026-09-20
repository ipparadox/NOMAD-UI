# NOMAD V0.6.5-A — production login / session entry

This change replaces the normal secure-renderer placeholder and timed boot log with a live, full-screen ASCII-wave session-confirmation scene. It preserves the eDEX/NOMAD HUD and the actual secure-renderer failure screen. No dependencies, package metadata, lockfiles or commits are changed.

## Files

| File | Responsibility |
| --- | --- |
| `src/classes/asciiWaveBackground.class.js` (new) | Supplied seeded simplex wave implementation; canvas lifecycle |
| `src/classes/loginExperience.class.js` (new) | Explicit login state machine, confirmation input, status projection, dissolve and cleanup |
| `src/classes/sessionAuthProvider.js` (new) | Main-process OS identity/session metadata and credential-free confirmation provider; two strict IPC handlers |
| `src/assets/css/login.css` (new) | Scoped first-frame layout, typography, brackets, calibration tick and transition |
| `src/ui-secure.html` | Local login assets and initial markup; CSP unchanged |
| `src/_renderer_secure.js` | Login orchestration, real initialization signals, covered HUD creation, reveal; fatal fallback retained |
| `src/_boot.js` | Provider registration, matching window background, show on `ready-to-show` |
| `src/preload.js` | Frozen `auth.getSession()` and `auth.confirmSession()` projections |
| `src/classes/rendererDiagnostics.js` | Exact expected bridge-key inventory includes `auth` |
| `test/loginExperience.test.js` (new) | Canvas golden output, lifecycle, state machine, provider and IPC rejection tests |
| `test/secureRendererRegression.test.js` | Initial login expectation and actual fatal fallback coverage |
| `test/secureProduction.gui.js` | Real login observation, transition and cleanup, existing production parity acceptance |
| This document (new) | Implementation report, evidence, acceptance procedure and debt |

## Exact animation extraction

The supplied implementation is the source of the wave renderer, not inspiration for a different effect. The code is reformatted into a class with closure-owned canvas state. These values and computations are retained:

- Ramp `" nomad-UI"`; 14 × 16 grid; 13px original monospace font stack.
- Seed 1337, original LCG, permutation tables, 12 gradients and four-corner 3D simplex calculation.
- Original scale .055, speed .18, warp 1.35, contrast 1.25 and mouse .35.
- Original domain warp, .45 secondary noise layer, .35 broad sine swell, pointer ripple and .08 pointer smoothing.
- Original 24 grayscale buckets, brightness .18–1.0 and exponent 1.4.
- Opaque canvas, `#050505` clear, DPR cap 2, responsive viewport sizing and RAF scheduling with the original 30 FPS cap.

Visual differences are limited to the login overlay: a central dark radial veil to make the identity/action readable; small dark backings for peripheral text; cyan technical lines and moving calibration mark. The full-resolution wave field continues behind them. The first frame is drawn synchronously with a one-frame time offset so the first window paint has characters. Subsequent timing/math follows the supplied renderer. No image/video asset, CDN, new font download or CSS approximation is involved.

`start()` is idempotent; `stop()` cancels RAF and removes resize/pointer listeners; `destroy()` additionally drops canvas/context references and prevents restart. Destruction runs after the dissolve, on fatal failure, and on page exit. The class's frame counter is diagnostic only and never controls authentication.

## Visual architecture and input

The initial HTML contains the complete login, styled by a local stylesheet before renderer initialization. The BrowserWindow background matches the canvas and production waits for `ready-to-show`. No terminal DOM is created before confirmation. The original HUD is appended behind the opaque login after confirmation; its direct body children remain visually hidden and pointer-disabled until the dissolve starts. Existing HUD layout/components remain in place.

The center uses aligned typography, open brackets and a single angular action rather than a rounded card. Metadata includes the real OS account and hostname, local time, observed authentication channel, security profile and initialization statuses. Unknown observations remain `UNKNOWN`; unavailable modules are identified as such.

There is no credential field because there is no credential authenticator. Enter confirms; Escape returns focus to the confirmation button without entering NOMAD; Tab retains focus on the only action. An early capture listener blocks terminal/Control Plane keyboard handlers while the scene is active. The existing input-capture controller also owns `nomad-login` while HUD components initialize. Native input shortcuts in the original HUD remain unchanged and are GUI-tested after reveal.

## Authentication semantics and trust boundary

The dedicated session launcher starts i3 and then NOMAD within an existing OS session. This repository has no PAM helper suitable for a safe password challenge. V0.6.5-A therefore implements **session confirmation, not password authentication and not a security lock**. The button acknowledges entry to the existing session; it adds no protection against another person using an already logged-in computer.

`SessionAuthProvider` provides `getIdentity()`, `getAuthenticationState()`, `authenticate()` and `getRateLimitState()`. Identity comes from `os.userInfo()` and `os.hostname()`, not editable NOMAD settings. Session evidence comes from a fixed `/usr/bin/loginctl show-session self` invocation with fixed properties, a two-second timeout, a 4096-byte output limit and a minimal environment. No renderer text becomes an executable, argument or path. Metadata polling is coalesced for one second.

The UI says `SESSION AUTHENTICATED BY GDM` only when metadata reports all of: matching numeric UID, active session, non-remote session and `Service=gdm-password`. Automatic login, an unknown service, query failure or a nonmatching session remains `AUTH CHANNEL UNKNOWN`. This is an OS-session observation, not proof of a freshly entered password or an unlocked desktop. In the private GUI test the channel was correctly `UNKNOWN`.

The preload exposes only `nomad.auth.session.get` and `nomad.auth.session.confirm`, each with an empty object payload. Main checks owning WebContents and exact empty payloads. Confirmation additionally requires the existing main-side isolation verification. The provider rejects arguments to `authenticate()`. No password is collected, compared, saved, logged, sent over IPC or passed to a shell. No PAM or sudo interface is exposed to the renderer.

Rate limiting of bad passwords and failed-password counts are **not applicable**. There is no fake rejection flow. A failure to obtain confirmation from the service displays `SESSION CONFIRMATION UNAVAILABLE // RETRY`, not `ACCESS DENIED` or a false wrong-password result. A future credential authenticator would require a separately reviewed native/helper boundary, bounded main-owned attempts and backoff, credential handling, and OS lock/unlock semantics.

## State machine and readiness

Normal path:

`BOOTSTRAP → AUTH_INITIALIZING → AUTH_READY → AUTHENTICATING → AUTH_SUCCESS → SESSION_INITIALIZING → NOMAD_READY`

`AUTHENTICATING → AUTH_FAILED → AUTHENTICATING` supports a service retry. Initialization failures reach `FATAL`; invalid transitions throw. Duplicate confirmation is ignored while a request is in flight. Missing bridge/bootstrap or initialization errors still render `NOMAD // SECURE RENDERER FAILURE` with factual stage/status/reference and the safe-session footer.

| Signal | Evidence |
| --- | --- |
| Secure renderer verified | Existing main-process runtime probe: isolated preload, no renderer `require/process/module`, expected URL and exact bridge keys |
| Security profile | Existing named security profile response |
| Terminal ready | Primary terminal capability plus resolved authenticated WebSocket client readiness |
| Control Plane ready | Constructed original view plus accepted named context request |
| Repository service ready | Existing repository render/refresh result |
| Telemetry/network live | Existing telemetry dashboard initialization results; unavailable data is not promoted to ready |
| Identity / node | Main-process OS account / hostname |
| Local time | Local clock |

Runtime verification polling reads the actual main-side result. Fifteen seconds is a failure bound, not a timer that changes status to ready. Service setup runs after confirmation. Once initialization has completed, the confirmation geometry retracts, metadata dims, the original HUD becomes visible behind the same canvas, and the entire login fades over 2.1 seconds. That duration is purely cosmetic; it does not authenticate or fabricate readiness. On completion, the login is removed, animation/listeners are destroyed, input capture is released, and terminal focus is restored. Slow initialization can make confirmation-to-HUD longer than 2.1 seconds; no artificial progress is shown.

## Security preservation and limitation

The existing V0.6 production preferences, authenticated terminal transport, trusted action gates and NORMAL/PUBLIC/LOCKDOWN implementations remain intact. Context isolation is enabled, Node integration and remote are disabled, DevTools remain disabled, and the preload bridge including its auth object is frozen. The exact bridge inventory test was extended. CSP is byte-for-byte unchanged; scripts and styles are local. The new renderer classes contain no `require`, filesystem, process, shell, raw IPC or network access.

**Sandbox qualification:** the baseline Electron 12 BrowserWindow did not explicitly enable Electron's renderer `sandbox` preference. An explicit `sandbox: true` trial crashed the installed renderer before preload with signal 31. That added preference was reverted to baseline; no `sandbox: false`, sandbox bypass argument or dependency change was introduced. Chromium renderer sandboxing is not newly verified or claimed by this phase. Supporting it on this runtime/host is remaining security compatibility work, not a completed property of this login.

## Validation

- 57/57 Node test suites passed. Focused login and secure-renderer tests also passed after the provider's no-argument rejection was added.
- Four root/src manifests and lockfiles were compared byte-for-byte against HEAD and remain unchanged.
- `git diff --check` passed.
- The real production Electron GUI ran in private authenticated Xwayland/i3 without a sandbox-bypass flag. The login stayed responsive for 20 seconds and stayed at `AUTH_READY` until Enter. Drawn characters were captured from actual canvas calls; all belonged to the exact ramp. Actual pixel output changed. Pointer movement and Escape were exercised; pointer influence is also compared deterministically in the canvas unit harness.
- Two full runs measured 292 and 396 rendered frames in 20 seconds (approximately 14.6 and 19.8 FPS). The original 30 FPS cap is preserved; this loaded VirtualBox environment did not achieve 30 FPS. No grid-density or algorithm substitution was made to improve that result.
- The final GUI run explicitly passed the first-window-show check (painted waves, no terminal). Confirmation, shared-scene dissolve, removal of the canvas, and stopped frame counter also passed. Captured login and HUD frames were visually inspected. Screenshot captures are validation artifacts only and are never used by the application.
- Existing GUI acceptance passed: isolation verification; primary/extra terminals; virtual keys; foreground-process stop X; native Ctrl+A/C/V; Ctrl+Space and assistant Enter; repository selection/refresh; workspace launcher; real generic application and VLC geometry/focus/minimize/restore/fullscreen/MRU/close.
- The final thirty-second telemetry observation passed with 24 distinct CPU readings, 24 memory readings, 25 network observations and 30 globe camera positions; CPU and traffic charts each repainted 1182 times. An existing process-sensor timeout was truthfully shown as partial telemetry availability.

The canvas unit harness checks the exact ramp and seed, a golden full-frame digest covering noise/domain-warp/palette output, character positions, DPR, resize, skipped early RAF frames, pointer effects, idempotent start, stop, destruction and inability to restart. State-machine tests execute successful, invalid and fatal paths. Provider tests exercise GDM/automatic-login/UID/inactive/remote/unknown cases, unverified renderer, wrong sender and nonempty credential/command/path payload rejection. The existing secure-renderer suite covers local assets, strict CSP, forbidden renderer APIs, frozen bridge and the actual fatal fallback. Existing suites cover repository RUN/STOP, security profiles, workspaces, apps, terminal and keyboard behavior.

## Exact VM acceptance checklist

1. Keep the current manifests/dependencies. Run from the existing supported environment; do not use a sandbox-bypass flag. Run `node test/loginExperience.test.js`, `node test/secureRendererRegression.test.js`, and the remaining `test/*.test.js` suites. Run `python3 test/run-secure-i3-gui.py` in a GUI-capable environment for automated production parity.
2. Log out to GDM. Select the dedicated NOMAD session and authenticate normally. Observe the actual GDM-to-session handoff: the first NOMAD window must be the styled ASCII login, with no old normal-status/failure panel or exposed terminal. Record any desktop/i3 gap separately from the application's first frame.
3. Leave the login untouched for at least 20 seconds. Confirm waves move, characters are from ` nomad-UI`, and pointer motion subtly disturbs the field. Check native resolution and a high-DPI configuration. Check readable labels, complete button caption, keyboard focus and live local time.
4. Confirm the operator equals the OS account and node equals hostname. Independently run `loginctl show-session self -p User -p Service -p Active -p Remote` from that session. GDM wording requires the documented exact conditions; unknown/automatic-login sessions must not claim password authentication.
5. Press Escape and Tab: remain at login with action focus. Ctrl+Space must not open Control Plane or route into a terminal while login is active. There must be no password field or request for secrets.
6. Press Enter once (also test rapid repeats on another startup). Confirm session confirmation appears, real initialization statuses update, then a roughly 2.1-second dissolve reveals the original HUD with no blank frame. Confirm the main HUD is usable afterward. Slow service setup must not invent ready statuses.
7. Repeat entry with the mouse. Reload NOMAD and verify the entry screen returns. Close during login and during transition; no renderer errors or retained animation should result.
8. In an authorized GUI harness, check `window.nomadLogin.state === 'NOMAD_READY'`, `.wave.destroyed === true`, `.wave.running === false`, no `#ascii`, and unchanged wave frame count after another second. These diagnostics do not require enabling production DevTools.
9. Observe CPU/RAM graphs, network graph, local clock and globe for at least 30 seconds. Real values and camera position must change. Unavailable sensor data must remain unavailable.
10. Run a harmless terminal command using physical keys and virtual keyboard. Open/close an extra terminal. Start `sleep 30` and stop it with the foreground X. Test native selection/copy/paste in Control Plane; Ctrl+Space; assistant Enter; settings open/close.
11. Use disposable repositories to test select/refresh, approved RUN/STOP and the existing trust confirmation path. Exercise actual installed CODE and BROWSER profiles, VLC, workspace switching, window geometry, minimize/restore, fullscreen, close and return to terminal.
12. Inspect the existing security HUD in NORMAL, PUBLIC and LOCKDOWN using the existing authorized profile workflow. Verify renderer isolation remains secure and enforcement status remains truthful. Do not infer host firewall/storage compliance from the login renderer label.
13. In a disposable test checkout, remove/mock the preload bridge or fail trusted bootstrap. Verify the actual fatal screen has stage/status/reference and safe-session guidance. Restore the fixture; ordinary startup must never show it.
14. Confirm `git diff -- package.json package-lock.json src/package.json src/package-lock.json` is empty and no commit was created.

## Remaining debt

Actual GDM handoff and successful `gdm-password` detection need acceptance in the dedicated VM session. The nested GUI proves application startup, not the display manager's frame delivery. CODE/BROWSER profiles and repository RUN/STOP were covered by existing unit/integration suites, not launched against user projects in this GUI run. Native credential authentication, an OS-backed lock/unlock flow, and its failure/backoff handling are intentionally absent. Explicit renderer sandbox compatibility and target-machine 30 FPS performance remain unresolved. The exact supplied algorithm and original HUD were preserved instead of silently changing either to mask these limitations.
