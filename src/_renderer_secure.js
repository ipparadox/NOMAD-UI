"use strict";

let secureBootstrapStage = "PRELOAD";
const secureFailureReferences = Object.freeze({
    PRELOAD: "NMD-PRE-001",
    BRIDGE: "NMD-BRG-001",
    DOM: "NMD-DOM-001",
    TERMINAL: "NMD-TRM-001",
    UI: "NMD-UI-001"
});

function renderSecureBootstrapFailure(stage) {
    const safeStage = Object.prototype.hasOwnProperty.call(secureFailureReferences, stage) ? stage : "UI";
    let screen = document.getElementById("boot_screen");
    if (!screen) {
        screen = document.createElement("section");
        screen.id = "boot_screen";
    }
    screen.className = "nomad_secure_boot_screen";
    const panel = document.createElement("div");
    panel.id = "nomad_secure_bootstrap_status";
    panel.setAttribute("role", "alert");
    const title = document.createElement("h1");
    title.textContent = "NOMAD // SECURE RENDERER FAILURE";
    panel.appendChild(title);
    [
        ["STAGE", safeStage],
        ["STATUS", "INITIALIZATION FAILED"],
        ["REFERENCE", secureFailureReferences[safeStage]]
    ].forEach(([label, value]) => {
        const row = document.createElement("p");
        const name = document.createElement("span");
        const content = document.createElement("span");
        name.textContent = label;
        content.textContent = value;
        row.append(name, content);
        panel.appendChild(row);
    });
    const footer = document.createElement("footer");
    footer.textContent = "RETURN TO SAFE SESSION";
    panel.appendChild(footer);
    screen.replaceChildren(panel);
    document.body.className = "solidBackground nomad_secure_failure";
    document.body.replaceChildren(screen);
}

function reportSecureBootstrapFailure(stage, error) {
    const name = error && error.name ? String(error.name).slice(0, 64) : "Error";
    const description = error && error.message ? String(error.message).slice(0, 512) : "secure bootstrap unavailable";
    console.error(`NOMAD secure renderer bootstrap failure stage=${stage} code=${name} description=${description}`);
    renderSecureBootstrapFailure(stage);
}

(async () => {
    const bridge = window.nomad;
    const bootScreen = document.getElementById("boot_screen");
    if (!bridge || !bridge.runtime || !bridge.control || !bridge.assistant || !bridge.system || !bridge.network
        || typeof bridge.system.getTelemetry !== "function" || typeof bridge.system.subscribeTelemetry !== "function"
        || typeof bridge.network.getTelemetry !== "function" || typeof bridge.network.subscribeTelemetry !== "function") {
        reportSecureBootstrapFailure("PRELOAD", new Error("preload bridge unavailable"));
        return;
    }
    secureBootstrapStage = "BRIDGE";
    const bootstrap = await bridge.runtime.bootstrap();
    if (!bootstrap || !bootstrap.settings || !bootstrap.theme || !bootstrap.keyboardLayout) {
        reportSecureBootstrapFailure("BRIDGE", new Error("trusted bootstrap unavailable"));
        return;
    }
    secureBootstrapStage = "DOM";
    window.nomadBootstrap = bootstrap;
    window.settings = bootstrap.settings;
    window.shortcuts = Array.isArray(bootstrap.shortcuts) ? bootstrap.shortcuts : [];
    window.theme = bootstrap.theme;
    window.passwordMode = "false";

    const cleanCssToken = value => String(value || "").replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 128);
    const cleanCssColor = (value, fallback) => /^#[0-9a-f]{3,8}$/i.test(String(value || "")) ? String(value) : fallback;
    const cleanChannel = value => Number.isFinite(Number(value)) ? Math.max(0, Math.min(255, Number(value))) : 0;
    const theme = bootstrap.theme;
    const colors = theme.colors || {};
    theme.r = cleanChannel(colors.r);
    theme.g = cleanChannel(colors.g);
    theme.b = cleanChannel(colors.b);
    const mainFont = cleanCssToken(theme.cssvars && theme.cssvars.font_main) || "Exo 2";
    const lightFont = cleanCssToken(theme.cssvars && theme.cssvars.font_main_light) || mainFont;
    const monoFont = cleanCssToken(theme.terminal && theme.terminal.fontFamily) || "Fira Mono";
    const injectedThemeCss = typeof theme.injectCSS === "string" ? theme.injectCSS.slice(0, 65536) : "";
    const fontFile = name => name.toLowerCase().replace(/ /g, "_") + ".woff2";
    const style = document.createElement("style");
    style.className = "theming secure-theming";
    style.textContent = `
        @font-face { font-family: "${mainFont}"; src: url("assets/fonts/${fontFile(mainFont)}"); }
        @font-face { font-family: "${lightFont}"; src: url("assets/fonts/${fontFile(lightFont)}"); }
        @font-face { font-family: "${monoFont}"; src: url("assets/fonts/${fontFile(monoFont)}"); }
        :root {
            --font_main: "${mainFont}";
            --font_main_light: "${lightFont}";
            --font_mono: "${monoFont}";
            --color_r: ${theme.r};
            --color_g: ${theme.g};
            --color_b: ${theme.b};
            --color_black: ${cleanCssColor(colors.black, "#000000")};
            --color_light_black: ${cleanCssColor(colors.light_black, "#101010")};
            --color_grey: ${cleanCssColor(colors.grey, "#777777")};
            --color_red: ${cleanCssColor(colors.red, "#ff3333")};
            --color_yellow: ${cleanCssColor(colors.yellow, "#ffcc33")};
        }
        body { font-family: var(--font_main), sans-serif; ${bootstrap.argv.nocursor || bootstrap.settings.nocursor ? "cursor:none!important;" : ""} }
        ${injectedThemeCss}
    `;
    document.head.appendChild(style);
    // Canvas text and terminal geometry must use the actual theme fonts.
    if (document.fonts) await Promise.allSettled([mainFont, lightFont, monoFont]
        .map(font => document.fonts.load(`12px "${font}"`)));

    const silentSound = Object.freeze({play: () => true});
    const createSound = name => {
        if (!bootstrap.settings.audio || typeof window.Howl !== "function") return silentSound;
        if (bootstrap.settings.disableFeedbackAudio && ["stdout", "stdin", "folder", "granted"].includes(name)) {
            return silentSound;
        }
        try { return new window.Howl({src: [`assets/audio/${name}.wav`]}); }
        catch (error) { return silentSound; }
    };
    window.audioManager = new Proxy({}, {
        get(target, property) {
            if (!Object.prototype.hasOwnProperty.call(target, property)) target[property] = createSound(String(property));
            return target[property];
        }
    });
    if (window.Howler && typeof window.Howler.volume === "function") {
        window.Howler.volume(bootstrap.settings.audio ? bootstrap.settings.audioVolume : 0);
    }

    window.addEventListener("error", event => {
        bridge.log("error", `${event.message || "RENDERER ERROR"} @ ${event.lineno || 0}:${event.colno || 0}`);
    });
    window.addEventListener("unhandledrejection", event => {
        const reason = event && event.reason && event.reason.message ? event.reason.message : "UNHANDLED RENDERER PROMISE REJECTION";
        bridge.log("error", String(reason).slice(0, 512));
    });

    bootScreen.classList.remove("nomad_secure_boot_screen");
    bootScreen.replaceChildren();

    if (!bootstrap.settings.nointro && !bootstrap.argv.nointro) {
        const lines = String(bootstrap.bootLog || "NOMAD BOOT\nBoot Complete").split(/\r?\n/).slice(0, 96);
        for (const line of lines) {
            const row = document.createElement("div");
            row.textContent = line;
            bootScreen.appendChild(row);
            await new Promise(resolve => setTimeout(resolve, 8));
        }
        await new Promise(resolve => setTimeout(resolve, 120));
        bootScreen.replaceChildren();
        bootScreen.className = "center";
        const title = document.createElement("h1");
        title.textContent = "NOMAD-UI";
        bootScreen.appendChild(title);
        window.audioManager.theme.play();
        await new Promise(resolve => setTimeout(resolve, 200));
        title.style.border = `5px solid rgb(${theme.r},${theme.g},${theme.b})`;
        await new Promise(resolve => setTimeout(resolve, 300));
        title.style.border = "";
        title.className = "glitch";
        await new Promise(resolve => setTimeout(resolve, 500));
        title.className = "";
        title.textContent = bootstrap.displayName ? `Welcome back, ${bootstrap.displayName}` : "Welcome back";
        await new Promise(resolve => setTimeout(resolve, 700));
    }

    document.body.className = bootstrap.settings.virtualKeyboard ? "" : "no-virtual-keyboard";
    document.body.innerHTML = `
        <section class="mod_column" id="mod_column_left">
            <h3 class="title"><p>PANEL</p><p>SYSTEM</p></h3>
        </section>
        <section id="main_shell" augmented-ui="tr-clip exe">
            <h3 class="title"><p>WORKSPACE</p><p>APPLICATIONS</p></h3>
            <ul id="workspace_slots" aria-label="Workspace applications"><li id="workspace_slot_add" class="workspace_add" aria-label="Add application"><p>+</p></li></ul>
            <ul id="main_shell_tabs" aria-label="Terminal tabs">
                <li id="shell_tab0" class="active"><p>MAIN SHELL</p></li>
                <li id="shell_tab1"><p>EMPTY</p></li><li id="shell_tab2"><p>EMPTY</p></li>
                <li id="shell_tab3"><p>EMPTY</p></li><li id="shell_tab4"><p>EMPTY</p></li>
            </ul>
            <div id="workspace_viewport">
                <div id="workspace_view_terminal" class="workspace_view active"><div id="main_shell_innercontainer">
                    <pre id="terminal0" class="active"></pre><pre id="terminal1"></pre><pre id="terminal2"></pre><pre id="terminal3"></pre><pre id="terminal4"></pre>
                </div></div>
                <div id="workspace_view_notes" class="workspace_view workspace_empty_state">APPLICATION NOT INITIALIZED</div>
            </div>
        </section>
        <section class="mod_column" id="mod_column_right">
            <h3 class="title"><p>PANEL</p><p>NETWORK</p></h3>
            <div id="nomad_security_strip" role="button" tabindex="0"><h1>SECURITY //</h1><p><span>PROFILE</span><span id="nomad_security_profile">UNKNOWN</span></p><p><span>COMPLIANCE</span><span id="nomad_security_compliance">UNKNOWN</span></p><p><span>RENDERER</span><span id="nomad_security_renderer">UNKNOWN</span></p><p><span>HOST STORAGE</span><span id="nomad_security_storage">UNKNOWN</span></p></div>
        </section>
        <section id="repository"><h3 class="title"><p>REPOSITORIES</p><p><button id="repository_add" type="button">+ REPOSITORY</button></p></h3><div id="repository_container"></div></section>
        <section id="keyboard"></section>
    `;

    const text = (id, value) => {
        const element = document.getElementById(id);
        if (element) element.textContent = String(value === null || typeof value === "undefined" ? "UNKNOWN" : value).slice(0, 128);
    };
    bridge.log("info", "Secure renderer bridge verified");
    document.body.dataset.nomadBridge = "VERIFIED";
    window.nomadTelemetry = new SecureTelemetryDashboard({
        systemBridge: bridge.system,
        networkBridge: bridge.network,
        bootstrap,
        theme,
        log: (level, message) => bridge.log(level, message)
    });
    const telemetryReady = window.nomadTelemetry.initialize();

    secureBootstrapStage = "UI";
    let registryApplications = publicApplications(MANAGED_APPLICATIONS);
    try {
        const state = await bridge.applications.request("get");
        if (state && state.ok && Array.isArray(state.applications)) registryApplications = state.applications;
    } catch (error) {}
    window.workspaceManager = new WorkspaceManager({applications: registryApplications, initialApplicationIds: ["terminal"]});
    const workspaceSlots = document.getElementById("workspace_slots");
    const addWorkspaceSlot = document.getElementById("workspace_slot_add");
    let controlPlane = null;
    function focusActiveTerminal() {
        if (window.nomadInputCapture && window.nomadInputCapture.active) return false;
        const client = window.term && window.term[window.currentTerm];
        if (!client || !client.term || typeof client.term.focus !== "function") return false;
        client.term.focus();
        return true;
    }

    const createWorkspaceSlot = slot => {
        const element = document.createElement("li");
        element.id = `workspace_slot_${slot.id}`;
        element.dataset.workspaceSlot = slot.id;
        const label = document.createElement("p");
        label.textContent = slot.label;
        element.appendChild(label);
        element.addEventListener("click", event => {
            if (!event.target.closest(".workspace_control")) window.workspaceManager.focus(slot.id);
        });
        if (slot.id === "terminal") {
            const stop = document.createElement("button");
            stop.id = "terminal_stop_foreground";
            stop.className = "workspace_control terminal_foreground_stop";
            stop.type = "button";
            stop.textContent = "X";
            stop.hidden = true;
            stop.addEventListener("click", async event => {
                event.stopPropagation();
                stop.disabled = true;
                await bridge.terminal.stopForeground();
                stop.disabled = false;
                focusActiveTerminal();
            });
            label.appendChild(stop);
        } else if (slot.type === "external") {
            const controls = document.createElement("span");
            controls.className = "workspace_controls";
            [["minimize", "_"], ["fullscreen", "[]"], ["close", "X"]].forEach(([action, caption]) => {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "workspace_control";
                button.textContent = caption;
                button.addEventListener("click", event => {
                    event.stopPropagation();
                    const current = window.workspaceManager.getSlot(slot.id);
                    if (action === "fullscreen") window.workspaceManager.fullscreen(slot.id, !current.fullscreen);
                    else window.workspaceManager[action](slot.id);
                });
                controls.appendChild(button);
            });
            label.appendChild(controls);
        }
        return element;
    };
    window.workspaceManager.subscribe(state => {
        const visible = new Set(state.slots.map(slot => slot.id));
        workspaceSlots.querySelectorAll("[data-workspace-slot]").forEach(element => {
            if (!visible.has(element.dataset.workspaceSlot)) element.remove();
        });
        state.slots.forEach(slot => {
            let element = document.getElementById(`workspace_slot_${slot.id}`);
            if (!element) element = createWorkspaceSlot(slot);
            workspaceSlots.insertBefore(element, addWorkspaceSlot);
            element.className = [slot.active ? "active" : "inactive", slot.available ? "available" : "unavailable"].join(" ");
        });
        document.getElementById("workspace_view_terminal").classList.toggle("active", state.activeSlotId === "terminal");
        document.getElementById("workspace_view_notes").classList.toggle("active", state.activeSlotId === "notes");
        const notes = state.slots.find(slot => slot.id === "notes");
        if (notes && notes.status) document.getElementById("workspace_view_notes").textContent = notes.status;
        if (controlPlane && state.activeSlotId) controlPlane.setActiveApplication(state.activeSlotId);
        if (state.activeSlotId === "terminal" && window.term && window.term[window.currentTerm]) {
            window.term[window.currentTerm].fit();
            focusActiveTerminal();
        }
    });

    const wmIpc = {
        on(channel, callback) {
            if (channel === "window-manager-state") return bridge.windowManager.onState(payload => callback(null, payload));
            if (channel === "window-manager-geometry-changed") return bridge.windowManager.onGeometryChanged(payload => callback(null, payload));
            return () => {};
        },
        send(channel, request) {
            if (channel !== "window-manager-operation" || !request) return false;
            return bridge.windowManager.operate({
                requestId: request.requestId,
                operation: request.operation,
                appId: request.appId
            });
        }
    };
    window.i3WorkspaceClient = new I3WorkspaceClient({
        ipc: wmIpc,
        manager: window.workspaceManager,
        viewport: document.getElementById("workspace_viewport"),
        loadState: () => bridge.windowManager.snapshot(),
        log: (level, message) => bridge.log(["error", "warn", "info", "debug"].includes(level) ? level : "info", message),
        onApplicationError: message => {
            if (window.applicationLauncher) window.applicationLauncher.showError(message);
        }
    });
    await window.i3WorkspaceClient.initialize();
    window.applicationLauncher = new ApplicationLauncher({
        manager: window.workspaceManager,
        trigger: addWorkspaceSlot,
        onResume: id => id === "terminal" ? focusActiveTerminal() : window.i3WorkspaceClient.refocus(id)
    });
    document.body.dataset.nomadWorkspaceManager = "INITIALIZED";
    bridge.log("info", "Workspace manager initialized");

    secureBootstrapStage = "TERMINAL";
    const primaryPort = Number(bootstrap.settings.port || 3000);
    const primaryConnection = await bridge.terminal.connection(primaryPort);
    if (!primaryConnection) throw new Error("Primary terminal capability unavailable");
    window.term = {0: new SecureTerminalClient({
        bridge: bridge.terminal,
        parentId: "terminal0",
        port: primaryConnection.port,
        authToken: primaryConnection.authToken,
        theme,
        fontSize: bootstrap.settings.termFontSize
    })};
    window.currentTerm = 0;
    window.term[0].term.writeln(`\u001b[1mNOMAD-UI v${bootstrap.appVersion} // PRODUCTION SESSION\u001b[0m`);
    window.term[0].onprocesschange = processName => {
        const slot = document.getElementById("workspace_slot_terminal");
        if (slot) slot.title = `MAIN // ${processName || "SHELL"}`;
    };
    await window.term[0].ready;
    document.body.dataset.nomadTerminal = "INITIALIZED";
    bridge.log("info", "Terminal initialized");

    secureBootstrapStage = "UI";

    window.keyboard = new SecureKeyboard({
        container: "keyboard",
        layout: bootstrap.keyboardLayout,
        getTerminal: () => window.term[window.currentTerm],
        onShortcut: action => {
            if (action === "CONTROL_PLANE" && controlPlane) {
                return controlPlane.opened && controlPlane.mode === "assistant"
                    ? controlPlane.close() : controlPlane.open("assistant");
            }
            return typeof window.useAppShortcut === "function" ? window.useAppShortcut(action) : false;
        }
    });
    if (bootstrap.settings.virtualKeyboard) {
        const keyboardElement = document.getElementById("keyboard");
        keyboardElement.classList.add("animation_state_1");
        window.audioManager.keyboard.play();
        requestAnimationFrame(() => keyboardElement.classList.add("animation_state_2"));
        setTimeout(() => keyboardElement.classList.remove("animation_state_1", "animation_state_2"), 1100);
    }
    document.body.dataset.nomadVirtualKeyboard = "INITIALIZED";
    bridge.log("info", "Virtual keyboard initialized");
    window.nomadInputCapture = new InputCaptureController({
        getKeyboard: () => window.keyboard,
        isTerminalActive: () => window.workspaceManager.activeSlotId === "terminal",
        focusTerminal: focusActiveTerminal,
        onchange: active => document.body.classList.toggle("nomad-input-active", active)
    });
    window.addEventListener("mouseup", () => window.nomadInputCapture.handleMouseup());

    bridge.terminal.onForegroundState(state => {
        const stop = document.getElementById("terminal_stop_foreground");
        if (!stop || !state || typeof state.foregroundProcessRunning !== "boolean") return;
        stop.hidden = !state.foregroundProcessRunning;
        stop.disabled = !state.foregroundProcessRunning;
    });
    bridge.terminal.getForegroundState().then(state => {
        const stop = document.getElementById("terminal_stop_foreground");
        if (stop && state && typeof state.foregroundProcessRunning === "boolean") stop.hidden = !state.foregroundProcessRunning;
    });

    const pendingShells = new Map();
    window.focusShellTab = async index => {
        if (!Number.isInteger(index) || index < 0 || index > 4) return false;
        if (pendingShells.has(index)) return pendingShells.get(index);
        const focus = async () => {
            if (!window.term[index]) {
                const created = await bridge.terminal.create();
                if (!created || !created.ok || !Number.isSafeInteger(created.port)) return false;
                const connection = await bridge.terminal.connection(created.port);
                if (!connection) return false;
                window.term[index] = new SecureTerminalClient({
                    bridge: bridge.terminal,
                    parentId: `terminal${index}`,
                    port: connection.port,
                    authToken: connection.authToken,
                    theme,
                    fontSize: bootstrap.settings.termFontSize
                });
                await window.term[index].ready;
                document.querySelector(`#shell_tab${index} p`).textContent = `SHELL ${index + 1}`;
                window.term[index].onprocesschange = name => {
                    document.querySelector(`#shell_tab${index} p`).textContent = `#${index + 1} - ${name || "SHELL"}`;
                };
                window.term[index].onclose = () => {
                    const closed = window.term[index];
                    delete window.term[index];
                    if (closed) closed.dispose();
                    document.getElementById(`terminal${index}`).replaceChildren();
                    document.querySelector(`#shell_tab${index} p`).textContent = "EMPTY";
                    if (window.currentTerm === index) window.focusShellTab(0);
                };
            }
            document.querySelectorAll("#main_shell_tabs li").forEach((tab, tabIndex) => tab.classList.toggle("active", tabIndex === index));
            document.querySelectorAll("#main_shell_innercontainer pre").forEach((terminal, terminalIndex) => terminal.classList.toggle("active", terminalIndex === index));
            window.currentTerm = index;
            window.term[index].fit();
            focusActiveTerminal();
            return true;
        };
        const pending = focus().catch(() => {
            if (window.term[index]) window.term[index].dispose();
            delete window.term[index];
            document.querySelector(`#shell_tab${index} p`).textContent = "UNAVAILABLE";
            return false;
        }).finally(() => pendingShells.delete(index));
        pendingShells.set(index, pending);
        return pending;
    };
    document.querySelectorAll("#main_shell_tabs li").forEach((tab, index) => tab.addEventListener("click", () => window.focusShellTab(index)));

    const folderIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    folderIcon.setAttribute("viewBox", "0 0 24 24");
    const folderPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    folderPath.setAttribute("d", "M9.9994 3.9981h-6c-1.105 0-1.99.896-1.99 2l-.01 12c0 1.104.895 2 2 2h16c1.104 0 2-.896 2-2V7.9981c0-1.104-.896-2-2-2h-8l-1.9996-2z");
    folderIcon.appendChild(folderPath);
    let repositoryLauncher = null;
    let repositoryRefresh = null;
    const refreshRepositories = () => {
        if (!repositoryLauncher) return Promise.resolve(false);
        if (!repositoryRefresh) repositoryRefresh = repositoryLauncher.refresh().finally(() => { repositoryRefresh = null; });
        return repositoryRefresh;
    };
    const runRepositoryAction = async (repositoryId, actionId, details = {}) => {
        if (actionId === "pull" && controlPlane) {
            controlPlane.open("assistant");
            controlPlane.request("REPOSITORY_PULL", repositoryId);
            return {ok: true, status: "REVIEW OPENED"};
        }
        const request = {repositoryId, actionId};
        if (actionId === "run") {
            ["profileId", "authorizationId", "authorization"].forEach(key => {
                if (typeof details[key] === "string") request[key] = details[key];
            });
        }
        const result = await bridge.repositories.action(request);
        if (result && result.application && result.activateAppId) {
            const application = Object.assign({}, result.application, {state: "ACTIVE", running: true});
            window.workspaceManager.synchronize(result.activateAppId, application);
            if (["code", "browser"].includes(result.activateAppId)) window.i3WorkspaceClient.activeExternalId = result.activateAppId;
        }
        if (result && result.activateAppId && window.workspaceManager.activeSlotId !== result.activateAppId) {
            window.workspaceManager.focus(result.activateAppId);
        }
        return result;
    };
    repositoryLauncher = new RepositoryLauncher({
        container: "repository_container",
        addTrigger: "repository_add",
        folderIcon,
        loadRepositories: () => bridge.repositories.refresh(),
        onaction: runRepositoryAction,
        onclone: async repositoryUrl => {
            if (!controlPlane) return {ok: false, status: "NOMAD CONTROL UNAVAILABLE"};
            controlPlane.open("assistant");
            await controlPlane.request("REPOSITORY_CLONE", repositoryUrl);
            return {ok: false, review: true, status: "REVIEW CLONE IN NOMAD CONTROL"};
        },
        oncancelclone: () => bridge.repositories.cancelClone(),
        onInputCaptureChange: active => active
            ? window.nomadInputCapture.acquire("repository-clone") : window.nomadInputCapture.release("repository-clone"),
        getActiveId: () => window.workspaceManager.activeSlotId,
        onResume: id => id === "terminal" ? focusActiveTerminal() : window.i3WorkspaceClient.refocus(id),
        onselect: (repositoryId, repository) => {
            if (controlPlane) controlPlane.setSelectedRepository(repositoryId, repository);
        }
    });
    window.repositoryLauncher = repositoryLauncher;
    const repositoriesAvailable = await repositoryLauncher.render();
    document.getElementById("repository").style.opacity = "1";
    document.body.dataset.nomadRepositories = repositoriesAvailable ? "INITIALIZED" : "UNAVAILABLE";
    bridge.log(repositoriesAvailable ? "info" : "warn", repositoriesAvailable
        ? "Repository projection initialized" : "Repository projection initialized; repository service unavailable");
    bridge.repositories.onProcessState(() => refreshRepositories());
    bridge.repositories.onGitState(state => {
        repositoryLauncher.updateGitState(state);
        if (state && ["COMPLETE", "FAILED", "CANCELLED"].includes(state.state)) refreshRepositories();
    });

    const reloadApplications = async () => {
        const state = await bridge.applications.request("reload").catch(() => null);
        if (!state || !state.ok || !Array.isArray(state.applications)) return false;
        window.workspaceManager.setApplications(state.applications);
        return true;
    };
    bridge.control.onApplicationsChanged(() => reloadApplications());
    const activateApplication = id => {
        if (id === "terminal") {
            window.workspaceManager.focus("terminal");
            window.focusShellTab(window.currentTerm);
            return true;
        }
        if (window.workspaceManager.activeSlotId === id) return true;
        return window.workspaceManager.focus(id);
    };
    const synchronizeApplication = (application, activate) => {
        if (!application || typeof application.id !== "string") return false;
        if (application.state === "CLOSED") {
            return window.workspaceManager.close(application.id, {skipOperation: true});
        }
        const projected = Object.assign({}, application);
        const registered = window.workspaceManager.getApplication(projected.id);
        if (activate && registered && registered.type === "external") {
            projected.state = "ACTIVE";
            projected.running = true;
            window.i3WorkspaceClient.activeExternalId = projected.id;
        }
        return window.workspaceManager.synchronize(projected.id, projected);
    };
    controlPlane = new ControlPlaneView({
        bridge,
        inputCapture: window.nomadInputCapture,
        focusTerminal: () => window.workspaceManager.activeSlotId === "terminal" && focusActiveTerminal(),
        activateApplication,
        synchronizeApplication,
        refreshRepositories,
        refreshApplications: reloadApplications
    }).initialize();
    window.nomadControlPlane = controlPlane;
    document.body.dataset.nomadControlPlane = "INITIALIZED";
    bridge.log("info", "Control Plane initialized");

    const securityStrip = document.getElementById("nomad_security_strip");
    const openSecurity = () => controlPlane.open("security");
    securityStrip.addEventListener("click", openSecurity);
    securityStrip.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openSecurity(); }
    });
    async function refreshSecurityStrip() {
        const result = await bridge.control.request("SECURITY_STATUS").catch(() => null);
        if (!result || !result.ok || !result.security || !result.security.profile) return;
        text("nomad_security_profile", result.security.profile.id);
        text("nomad_security_compliance", result.security.profile.compliance);
        if (result.storage) text("nomad_security_storage", result.storage.observation || result.storage.state);
        (result.security.checks || []).forEach(check => {
            const label = String(check.label || "").toUpperCase();
            if (label.includes("RENDERER")) text("nomad_security_renderer", check.state);
            if (label.includes("HOST STORAGE")) text("nomad_security_storage", check.actual || check.state);
        });
    }
    refreshSecurityStrip();
    setInterval(refreshSecurityStrip, 30000);

    function createSettings() {
        const root = document.createElement("section");
        root.id = "nomad_settings";
        root.hidden = true;
        const header = document.createElement("header");
        const title = document.createElement("h2");
        title.textContent = "SETTINGS //";
        const close = document.createElement("button");
        close.type = "button";
        close.textContent = "X";
        header.append(title, close);
        const form = document.createElement("div");
        const setting = (label, control) => {
            const row = document.createElement("div");
            row.className = "nomad_setting_row";
            const caption = document.createElement("label");
            caption.textContent = label;
            row.append(caption, control);
            form.appendChild(row);
        };
        const themeSelect = document.createElement("select");
        bootstrap.themeIds.forEach(id => { const option = document.createElement("option"); option.value = id; option.textContent = id.toUpperCase(); option.selected = id === bootstrap.settings.theme; themeSelect.appendChild(option); });
        const keyboardSelect = document.createElement("select");
        bootstrap.keyboardIds.forEach(id => { const option = document.createElement("option"); option.value = id; option.textContent = id.toUpperCase(); option.selected = id === bootstrap.settings.keyboard; keyboardSelect.appendChild(option); });
        const fontSize = document.createElement("input"); fontSize.type = "number"; fontSize.min = "8"; fontSize.max = "48"; fontSize.value = String(bootstrap.settings.termFontSize);
        const virtualKeyboard = document.createElement("input"); virtualKeyboard.type = "checkbox"; virtualKeyboard.checked = bootstrap.settings.virtualKeyboard;
        const audio = document.createElement("input"); audio.type = "checkbox"; audio.checked = bootstrap.settings.audio;
        const username = document.createElement("input"); username.type = "text"; username.maxLength = 64; username.value = bootstrap.settings.username || "";
        const audioVolume = document.createElement("input"); audioVolume.type = "number"; audioVolume.min = "0"; audioVolume.max = "1"; audioVolume.step = "0.05"; audioVolume.value = String(bootstrap.settings.audioVolume);
        const disableFeedbackAudio = document.createElement("input"); disableFeedbackAudio.type = "checkbox"; disableFeedbackAudio.checked = bootstrap.settings.disableFeedbackAudio;
        const clock = document.createElement("select"); [24, 12].forEach(value => { const option = document.createElement("option"); option.value = String(value); option.textContent = `${value} HOURS`; option.selected = value === bootstrap.settings.clockHours; clock.appendChild(option); });
        const monitor = document.createElement("input"); monitor.type = "number"; monitor.min = "0"; monitor.max = String(Math.max(0, Number(bootstrap.displayCount || 1) - 1)); monitor.value = String(bootstrap.settings.monitor);
        const checkbox = key => { const input = document.createElement("input"); input.type = "checkbox"; input.checked = bootstrap.settings[key] === true; return input; };
        const nointro = checkbox("nointro");
        const nocursor = checkbox("nocursor");
        const allowWindowed = checkbox("allowWindowed");
        const keepGeometry = checkbox("keepGeometry");
        const excludeThreads = checkbox("excludeThreadsFromToplist");
        const hideDotfiles = checkbox("hideDotfiles");
        const fsListView = checkbox("fsListView");
        const experimentalGlobe = checkbox("experimentalGlobeFeatures");
        setting("USERNAME", username); setting("THEME", themeSelect); setting("KEYBOARD", keyboardSelect);
        setting("TERMINAL FONT", fontSize); setting("VIRTUAL KEYBOARD", virtualKeyboard);
        setting("AUDIO", audio); setting("AUDIO VOLUME", audioVolume); setting("MUTE FEEDBACK", disableFeedbackAudio);
        setting("CLOCK", clock); setting("MONITOR", monitor); setting("SKIP INTRO", nointro);
        setting("HIDE CURSOR", nocursor); setting("ALLOW WINDOWED", allowWindowed); setting("KEEP GEOMETRY", keepGeometry);
        setting("EXCLUDE THREADS", excludeThreads); setting("HIDE DOTFILES", hideDotfiles);
        setting("FILE LIST VIEW", fsListView); setting("GLOBE FEATURES", experimentalGlobe);
        const status = document.createElement("p"); status.id = "nomad_settings_status";
        const actions = document.createElement("div"); actions.className = "nomad_settings_actions";
        const button = (label, action) => { const item = document.createElement("button"); item.type = "button"; item.textContent = label; item.addEventListener("click", action); return item; };
        const closeSettings = () => { root.hidden = true; window.nomadInputCapture.release("nomad-settings"); focusActiveTerminal(); };
        close.addEventListener("click", closeSettings);
        actions.append(
            button("SAVE", async () => {
                const patch = {
                    username: username.value,
                    theme: themeSelect.value,
                    keyboard: keyboardSelect.value,
                    termFontSize: Number(fontSize.value),
                    virtualKeyboard: virtualKeyboard.checked,
                    audio: audio.checked,
                    audioVolume: Number(audioVolume.value),
                    disableFeedbackAudio: disableFeedbackAudio.checked,
                    clockHours: Number(clock.value),
                    monitor: Number(monitor.value),
                    nointro: nointro.checked,
                    nocursor: nocursor.checked,
                    allowWindowed: allowWindowed.checked,
                    keepGeometry: keepGeometry.checked,
                    excludeThreadsFromToplist: excludeThreads.checked,
                    hideDotfiles: hideDotfiles.checked,
                    fsListView: fsListView.checked,
                    experimentalGlobeFeatures: experimentalGlobe.checked
                };
                const result = await bridge.settings.update(patch);
                if (!result || !result.ok) { status.textContent = result && result.status || "SETTINGS REFUSED"; return; }
                await bridge.settings.selectTheme(themeSelect.value);
                await bridge.settings.selectKeyboard(keyboardSelect.value);
                status.textContent = "SETTINGS SAVED // RELOADING";
                setTimeout(() => window.location.reload(), 150);
            }),
            button("SETTINGS FILE", () => bridge.settings.openDocument("settings")),
            button("SHORTCUTS FILE", () => bridge.settings.openDocument("shortcuts")),
            button("CLOSE", closeSettings)
        );
        root.append(header, form, status, actions);
        document.body.appendChild(root);
        return {
            open() { root.hidden = false; window.nomadInputCapture.acquire("nomad-settings"); themeSelect.focus(); },
            close: closeSettings,
            root
        };
    }
    const settingsView = createSettings();
    const settingsTrigger = document.createElement("button");
    settingsTrigger.type = "button";
    settingsTrigger.textContent = "SETTINGS";
    settingsTrigger.addEventListener("click", () => settingsView.open());
    controlPlane.triggers.appendChild(settingsTrigger);

    window.useAppShortcut = action => {
        if (action === "CONTROL_PLANE") return controlPlane.opened && controlPlane.mode === "assistant"
            ? controlPlane.close() : controlPlane.open("assistant");
        if (action === "COPY") return window.term[window.currentTerm].clipboard.copy();
        if (action === "PASTE") return window.term[window.currentTerm].clipboard.paste();
        if (action === "NEXT_TAB" || action === "PREVIOUS_TAB") {
            const tabs = Object.keys(window.term).map(Number).sort((a, b) => a - b);
            const direction = action === "NEXT_TAB" ? 1 : -1;
            return window.focusShellTab(tabs[(tabs.indexOf(window.currentTerm) + direction + tabs.length) % tabs.length]);
        }
        if (action === "SETTINGS") return settingsView.open();
        if (action === "SHORTCUTS") return bridge.settings.openDocument("shortcuts");
        if (action === "KB_PASSMODE") return window.keyboard.togglePasswordMode();
        if (action === "DEV_RELOAD") return window.location.reload();
        if (/^TAB_[1-5]$/.test(action)) return window.focusShellTab(Number(action.slice(4)) - 1);
        return false;
    };
    document.addEventListener("keydown", event => {
        if (window.nomadInputCapture.active) return;
        if (event.key === "Alt") event.preventDefault();
        if (event.key === "F11") {
            event.preventDefault();
            if (bootstrap.settings.allowWindowed) bridge.runtime.windowAction("toggle-fullscreen");
            return;
        }
        let action = null;
        if (event.ctrlKey && event.shiftKey && event.code === "KeyC") action = "COPY";
        else if (event.ctrlKey && event.shiftKey && event.code === "KeyV") action = "PASTE";
        else if (event.ctrlKey && event.shiftKey && event.code === "KeyS") action = "SETTINGS";
        else if (event.ctrlKey && event.shiftKey && event.code === "KeyK") action = "SHORTCUTS";
        else if (event.ctrlKey && event.shiftKey && event.code === "KeyP") action = "KB_PASSMODE";
        else if (event.ctrlKey && event.shiftKey && event.code === "Tab") action = "PREVIOUS_TAB";
        else if (event.ctrlKey && event.code === "Tab") action = "NEXT_TAB";
        else if (event.ctrlKey && /^Digit[1-5]$/.test(event.code)) action = `TAB_${event.code.slice(5)}`;
        if (!action) return;
        event.preventDefault();
        window.useAppShortcut(action);
    }, true);
    bridge.runtime.onResize(() => {
        if (window.term[window.currentTerm]) window.term[window.currentTerm].fit();
        window.i3WorkspaceClient.scheduleGeometry();
    });
    bridge.runtime.onLeaveFullscreen(() => {
        if (window.term[window.currentTerm]) window.term[window.currentTerm].fit();
    });
    const telemetryState = await telemetryReady;
    document.body.dataset.nomadSystemModule = telemetryState.system.available ? "INITIALIZED" : "UNAVAILABLE";
    document.body.dataset.nomadNetworkModule = telemetryState.network.available ? "INITIALIZED" : "UNAVAILABLE";
    bridge.log("info", "System telemetry initialized");
    if (!telemetryState.system.available) bridge.log("warn", "System telemetry unavailable");
    bridge.log("info", "Network telemetry initialized");
    if (!telemetryState.network.available) bridge.log("warn", "Network telemetry unavailable");
    bridge.log(telemetryState.network.globeInitialized ? "info" : "warn",
        telemetryState.network.globeInitialized ? "Globe initialized" : "Globe unavailable");
    bridge.runtime.windowAction("focus");
    secureBootstrapStage = "READY";
    document.body.dataset.nomadRendererReady = "true";
    bridge.log("info", "NOMAD secure renderer UI initialized");
})().catch(error => {
    reportSecureBootstrapFailure(secureBootstrapStage, error);
});
