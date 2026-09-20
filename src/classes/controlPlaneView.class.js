"use strict";

class ControlPlaneView {
    constructor(opts = {}) {
        if (!opts.bridge || !opts.bridge.control || !opts.bridge.assistant) {
            throw new TypeError("NOMAD control bridge unavailable");
        }
        this.bridge = opts.bridge;
        this.document = opts.document || document;
        this.hostWindow = opts.window || window;
        this.inputCapture = opts.inputCapture || null;
        this.focusTerminal = typeof opts.focusTerminal === "function" ? opts.focusTerminal : (() => {});
        this.activateApplication = typeof opts.activateApplication === "function" ? opts.activateApplication : (() => false);
        this.synchronizeApplication = typeof opts.synchronizeApplication === "function" ? opts.synchronizeApplication : (() => false);
        this.refreshRepositories = typeof opts.refreshRepositories === "function" ? opts.refreshRepositories : (() => Promise.resolve(false));
        this.refreshApplications = typeof opts.refreshApplications === "function" ? opts.refreshApplications : (() => Promise.resolve(false));
        this.mode = "assistant";
        this.opened = false;
        this.currentProfile = "NORMAL";
        this.selectedRepositoryId = null;
        this.selectedRepositoryName = "NO REPOSITORY SELECTED";
        this.pending = false;
        this._onGlobalKeydown = event => this._globalKeydown(event);
        this._mount();
        this.latestAutomation = null;
    }

    initialize() {
        this.hostWindow.addEventListener("keydown", this._onGlobalKeydown, true);
        if (this.bridge.automation) this.unsubscribeAutomation = this.bridge.automation.onState(result => {
            if (result.kind === "application-stage") {
                if (this.opened && this.pending) { this._clear(); this._line(result.status, "muted"); }
                return;
            }
            this.latestAutomation = result;
            this.refreshRepositories();
            if (this.opened && this.operationId === result.operation.id) this._renderAutomation(result);
        });
        return this;
    }

    destroy() {
        this.close();
        if (this.unsubscribeAutomation) this.unsubscribeAutomation();
        this.hostWindow.removeEventListener("keydown", this._onGlobalKeydown, true);
        if (this.root) this.root.remove();
        if (this.triggers) this.triggers.remove();
    }

    setSelectedRepository(repositoryId, repository = null) {
        this.selectedRepositoryId = /^repo_[a-f0-9]{32}$/.test(repositoryId || "") ? repositoryId : null;
        this.selectedRepositoryName = this.selectedRepositoryId && repository && typeof repository.displayName === "string"
            ? repository.displayName.slice(0, 96).toUpperCase() : "NO REPOSITORY SELECTED";
        this.context.textContent = `REPOSITORY // ${this.selectedRepositoryName}`;
        return this.bridge.control.setContext({selectedRepositoryId: this.selectedRepositoryId});
    }

    setActiveApplication(appId) {
        if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(appId || "")) return Promise.resolve(false);
        return this.bridge.control.setContext({activeApplicationId: appId, currentWorkspace: appId});
    }

    open(mode = "assistant") {
        if (!['assistant', 'security', 'applications', 'projects'].includes(mode)) mode = "assistant";
        this.mode = mode;
        this.opened = true;
        this.root.hidden = false;
        this.root.dataset.mode = mode;
        this.title.textContent = mode === "projects" ? "PROJECTS //" : mode === "security" ? "SECURITY //" : (mode === "applications" ? "APPLICATIONS //" : "NOMAD //");
        this.inputRow.hidden = mode !== "assistant";
        this._clear();
        if (this.inputCapture) this.inputCapture.acquire("nomad-control-plane");
        if (mode === "assistant") {
            this.input.value = "";
            this._line("STRUCTURED NOMAD ACTIONS ONLY", "muted");
            this.input.focus({preventScroll: true});
            if (this.latestAutomation) this.controls.append(this._button("SETUP STATUS", () => this._renderAutomation(this.latestAutomation)));
        } else if (mode === "projects") {
            this.request("PROJECT_LIST");
        } else if (mode === "security") {
            this._securityControls();
            this.request("SECURITY_STATUS");
        } else {
            this.request("APPLICATION_LIST");
        }
        return true;
    }

    close() {
        if (!this.opened) return false;
        this.opened = false;
        this.root.hidden = true;
        if (this.inputCapture) this.inputCapture.release("nomad-control-plane");
        this.focusTerminal();
        return true;
    }

    async submit() {
        if (this.pending) return false;
        const input = this.input.value;
        if (!input.trim()) return false;
        this._clear();
        this._line(`> ${input}`, "request");
        this.input.value = "";
        this.pending = true;
        this._setBusy(true);
        let result;
        try { result = await this.bridge.assistant.interpret(input); }
        catch (error) { result = {ok: false, status: "NOMAD CONTROL UNAVAILABLE"}; }
        this.pending = false;
        this._setBusy(false);
        this._renderResult(result);
        if (this.opened && this.mode === "assistant") this.input.focus({preventScroll: true});
        return Boolean(result && result.ok);
    }

    async request(actionId, targetId) {
        if (this.pending) return false;
        this.pending = true;
        this._setBusy(true);
        if (this.mode !== "assistant") this._clear();
        let result;
        try { result = await this.bridge.control.request(actionId, targetId); }
        catch (error) { result = {ok: false, status: "NOMAD CONTROL UNAVAILABLE"}; }
        this.pending = false;
        this._setBusy(false);
        this._renderResult(result);
        return Boolean(result && result.ok);
    }

    _mount() {
        this.triggers = this.document.createElement("nav");
        this.triggers.id = "nomad_control_triggers";
        this.triggers.setAttribute("aria-label", "NOMAD controls");
        this.triggers.append(
            this._button("NOMAD", () => this.open("assistant"), "nomad_assistant_trigger"),
            this._button("SECURITY", () => this.open("security"), "nomad_security_trigger"),
            this._button("PROJECTS", () => this.open("projects"), "nomad_projects_trigger"),
            this._button("APPS", () => this.open("applications"), "nomad_applications_trigger")
        );
        this.root = this.document.createElement("section");
        this.root.id = "nomad_control_plane";
        this.root.hidden = true;
        this.root.setAttribute("role", "dialog");
        this.root.setAttribute("aria-modal", "false");
        const header = this.document.createElement("header");
        this.title = this.document.createElement("h2");
        const close = this._button("X", () => this.close(), "nomad_control_close");
        close.setAttribute("aria-label", "Close NOMAD control plane");
        header.append(this.title, close);
        this.context = this.document.createElement("p");
        this.context.className = "nomad_context";
        this.context.textContent = "REPOSITORY // NO REPOSITORY SELECTED";
        this.inputRow = this.document.createElement("label");
        this.inputRow.className = "nomad_input_row";
        const prompt = this.document.createElement("span");
        prompt.textContent = ">";
        this.input = this.document.createElement("input");
        this.input.id = "nomad_intent_input";
        this.input.type = "text";
        this.input.maxLength = 2048;
        this.input.autocomplete = "off";
        this.input.spellcheck = false;
        this.input.setAttribute("aria-label", "NOMAD structured action");
        this.input.addEventListener("keydown", event => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                this.close();
            } else if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
                this.submit();
            }
        });
        this.inputRow.append(prompt, this.input);
        this.output = this.document.createElement("div");
        this.output.className = "nomad_output";
        this.controls = this.document.createElement("div");
        this.controls.className = "nomad_actions";
        this.root.append(header, this.context, this.inputRow, this.output, this.controls);
        this.document.body.append(this.triggers, this.root);
    }

    _globalKeydown(event) {
        if (event.ctrlKey && !event.altKey && !event.shiftKey && event.code === "Space") {
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
            if (this.opened && this.mode === "assistant") this.close();
            else this.open("assistant");
            return;
        }
        if (!this.opened) return;
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
            this.close();
        }
    }

    _clear() {
        this.output.replaceChildren();
        this.controls.replaceChildren();
    }

    _setBusy(busy) {
        this.root.dataset.busy = busy ? "true" : "false";
        this.input.disabled = busy;
    }

    _line(value, className = "") {
        const line = this.document.createElement("p");
        if (className) line.className = className;
        line.textContent = String(value || "").slice(0, 512);
        this.output.appendChild(line);
        return line;
    }

    _field(label, value, host = this.output) {
        const row = this.document.createElement("p");
        row.className = "nomad_field";
        const key = this.document.createElement("span");
        const data = this.document.createElement("span");
        key.textContent = String(label || "FIELD").slice(0, 40);
        data.textContent = String(value === null || typeof value === "undefined" ? "UNKNOWN" : value).slice(0, 256);
        row.append(key, data);
        host.appendChild(row);
    }

    _renderResult(result) {
        if (!result || typeof result !== "object" || Array.isArray(result)) {
            this._line("NOMAD CONTROL UNAVAILABLE", "error");
            return;
        }
        if (result.kind === "automation") { this._renderAutomation(result); return; }
        if (result.kind === "project" && result.project) { this._renderProject(result.project); return; }
        if (result.kind === "projects") {
            this._clear();
            (result.projects || []).forEach(project => {
                this._line(`${project.displayName} // ${project.type} // ${project.state}`);
                this.output.append(this._button("SELECT", () => {
                    this.setSelectedRepository(project.repositoryId, project);
                    this._renderProject(project);
                }));
            });
            if (!(result.projects || []).length) this._line("NO SUPPORTED PROJECTS DETECTED");
            return;
        }
        if (result.kind === "application-discovery") {
            this._clear(); this._line(result.status);
            (result.applications || []).forEach(app => {
                this._line(`${app.displayName} // ${app.status}`);
                this.output.append(this._button("ADD TO NOMAD", () => this.request("APPLICATION_REGISTER", app.id)),
                    this._button("IGNORE", () => this.request("APPLICATION_IGNORE", app.id)));
            });
            if (!(result.applications || []).length) this._line("NO NEW MANAGEABLE APPLICATIONS");
            return;
        }
        if (result.kind === "plan" && result.plan) {
            this._renderPlan(result);
            return;
        }
        if (result.kind === "security-status" || result.kind === "audit") {
            this._renderSecurity(result.security, result.storage);
            return;
        }
        if (result.kind === "security-plan" && result.plan) {
            this._renderSecurityPlan(result.plan);
            return;
        }
        if (result.kind === "application-list") {
            this._renderApplications(result);
            return;
        }
        if (result.kind === "application-info" && result.application) {
            this._line(result.status || "APPLICATION INFO", result.ok ? "success" : "error");
            this._field("APPLICATION", result.application.displayName || result.application.id);
            this._field("ID", result.application.id);
            this._field("TYPE", result.application.type);
            this._field("STATE", result.application.available === false ? "UNAVAILABLE" : "AVAILABLE");
            this.controls.append(this._button("BACK", () => this.request("APPLICATION_LIST")));
            return;
        }
        if (result.kind === "repository-clone" && result.repository && result.repository.project) {
            this.refreshRepositories();
            this.setSelectedRepository(result.repository.id, result.repository);
            this._renderProject(result.repository.project);
            this._line("CLONE COMPLETE / PROJECT INSPECTED / NO CODE EXECUTED");
            return;
        }
        if (result.kind === "repository-info" && result.repository) {
            this._line(result.status || "REPOSITORY INFO", result.ok ? "success" : "error");
            this._field("REPOSITORY", result.repository.displayName);
            this._field("BRANCH", result.repository.branch);
            this._field("STATE", result.repository.status);
            this._field("REMOTE", result.repository.remoteProvider || result.repository.remote);
            if (result.repository.executionSecurity) {
                this._field("ISOLATION", `${result.repository.executionSecurity.level} // ${result.repository.executionSecurity.authorization}`);
            }
            return;
        }
        if (result.kind === "verification" && result.verification) {
            this._line(result.status || "VERIFICATION COMPLETE", result.ok ? "success" : "error");
            const verification = result.verification;
            this._field("SELECTED PROFILE", verification.selectedProfile || verification.profile || "UNKNOWN");
            this._field("SYSTEM ENFORCEMENT", verification.systemEnforcementPending ? "PENDING" : "OBSERVED");
            if (typeof verification.ambiguous === "boolean") this._field("HOST STORAGE", verification.ambiguous ? "AMBIGUOUS" : "VERIFIED");
            this._securityControls();
            return;
        }
        if (result.kind === "selection") {
            this._line(result.status || "SELECTION REQUIRED", "warning");
            this._line("SELECT THE FIXED RUN PROFILE FROM THE REPOSITORY CONTROL", "muted");
            return;
        }
        this._line(result.status || (result.ok ? "ACTION COMPLETE" : "ACTION REFUSED"), result.ok ? "success" : "error");
        if (result.detail) this._line(result.detail, "muted");
        if (result.kind === "missing-context" && !result.detail) this._line("SELECT A REPOSITORY FIRST", "warning");
        if (result.terminalAvailable) this.controls.append(this._button("OPEN TERMINAL", () => {
            this.activateApplication("terminal");
            this.close();
        }));
        if (result.application) this.synchronizeApplication(result.application, Boolean(result.activateAppId));
        if (result.activateAppId) this.activateApplication(result.activateAppId, result.application || null);
        if (result.kind && result.kind.startsWith("repository-")) this.refreshRepositories();
        if (result.kind && result.kind.startsWith("application-")) this.refreshApplications();
        if (result.kind === "security-profile" && result.profile && result.profile.profile) {
            this.currentProfile = result.profile.profile;
        }
        if (this.mode === "security" && result.kind && result.kind.startsWith("security-")) this._securityControls();
        if (this.mode === "applications" && result.kind && result.kind.startsWith("application-")) {
            this.controls.append(this._button("BACK", () => this.request("APPLICATION_LIST")));
        }
    }

    _renderProject(project) {
        this._clear();
        this._line(project.displayName || "PROJECT //");
        ["type", "runtime", "manager", "state", "isolation"].forEach(key => this._field(key.toUpperCase(), project[key]));
        if (project.notice) this._line(project.notice, "warning");
        (project.profiles || []).forEach(p => this._field("PROFILE", p.displayName));
        if (project.type === "NODE") this.controls.append(this._button("PREPARE + HOOKS", () => this.request("PROJECT_SETUP_WITH_HOOKS", project.repositoryId)));
        this.controls.append(this._button("PREPARE", () => this.request("PROJECT_PREPARE", project.repositoryId)),
            this._button("RUN", () => this.request("PROJECT_RUN", project.repositoryId)),
            this._button("STOP", () => this.request("PROJECT_STOP", project.repositoryId)),
            this._button("CODE", () => this.request("REPOSITORY_CODE", project.repositoryId)),
            this._button("INFO", () => this.request("PROJECT_INSPECT", project.repositoryId)));
    }

    _renderAutomation(result) {
        this._clear();
        this.latestAutomation = result;
        this.operationId = result.operation.id;
        this._line(result.status, result.ok ? "muted" : "error");
        result.operation.steps.forEach((step, index) => this._field(`${index + 1}. ${step.type.replace(/_/g, " ")}`, step.state));
        if (result.operation.state === "RUNNING") this.controls.append(this._button("CANCEL", () => this.bridge.automation.cancel(result.operation.id)));
        this.controls.append(this._button("VIEW LOG", async () => {
            const log = await this.bridge.automation.log(result.operation.id);
            this.operationId = null;
            this._clear();
            this._line("REPOSITORY EXECUTION OUTPUT / LAST 65536 CHARACTERS");
            const output = this.document.createElement("pre");
            output.textContent = log.output || "NO OUTPUT";
            this.output.appendChild(output);
            this.controls.append(this._button("STATUS", async () => this._renderAutomation(await this.bridge.automation.status(result.operation.id))));
        }));
        if (result.operation.state !== "RUNNING") this.controls.append(this._button("PROJECT", () => this.request("PROJECT_INSPECT", result.operation.repositoryId)));
    }

    _renderPlan(result) {
        const plan = result.plan;
        this._line(result.status || "ACTION PLAN", result.confirmationRequired ? "warning" : "error");
        this._field("REQUEST", plan.request);
        this._field("ACTION", plan.action);
        this._field("TARGET", plan.target);
        this._field("SECURITY PROFILE", plan.securityProfile);
        this._field("PRIVILEGE", plan.privilege);
        (plan.fields || []).forEach(field => this._field(field.label, field.value));
        (plan.effects || []).forEach(effect => this._line(`- ${effect}`, "effect"));
        if (!result.confirmationRequired || !result.challengeId) {
            if (this.mode === "security") this._securityControls();
            if (this.mode === "applications") this.controls.append(
                this._button("BACK", () => this.request("APPLICATION_LIST"))
            );
            return;
        }
        this.controls.append(
            this._button("AUTHORIZE", async () => {
                if (this.pending) return;
                this.pending = true;
                this._setBusy(true);
                const confirmed = await this.bridge.control.confirm(result.challengeId).catch(() => ({ok: false, status: "CONFIRMATION FAILED"}));
                this.pending = false;
                this._setBusy(false);
                this._clear();
                this._renderResult(confirmed);
            }, "nomad_execute"),
            this._button("CANCEL", async () => {
                await this.bridge.control.cancel(result.challengeId).catch(() => null);
                this._clear();
                this._line("CANCELLED", "muted");
                if (this.mode === "security") this._securityControls();
                if (this.mode === "applications") this.controls.append(
                    this._button("BACK", () => this.request("APPLICATION_LIST"))
                );
            }, "nomad_cancel")
        );
    }

    _renderSecurity(security, storage = null) {
        if (this.mode === "assistant") this.controls.replaceChildren();
        else this._clear();
        if (!security || !security.profile) {
            this._line("SECURITY STATUS UNAVAILABLE", "error");
            return;
        }
        this.currentProfile = security.profile.id || "NORMAL";
        this._field("PROFILE", security.profile.id);
        this._field("COMPLIANCE", security.profile.compliance);
        this._field("ENFORCED", `${security.profile.enforced || "NONE"} // ${security.profile.enforcementState || "UNKNOWN"}`);
        const wanted = ["REPOSITORY ISOLATION", "FIREWALL", "HOST STORAGE", "AUTOMOUNT", "RENDERER", "SECRETS", "EPHEMERAL"];
        (security.checks || []).forEach(check => {
            const label = String(check.label || "").toUpperCase();
            if (wanted.some(value => label.includes(value))) this._field(check.label, `${check.actual || "UNKNOWN"} // ${check.state || "UNKNOWN"}`);
        });
        if (storage) {
            this._field("STORAGE OBSERVATION", storage.observation || storage.state);
            this._field("ROOT BACKING", storage.rootBacking);
            this._field("REPOSITORY BACKING", storage.repositoryBacking);
            this._field("SAFE UNMOUNT CANDIDATES", storage.safeUnmountCandidates ?? storage.eligibleCount ?? 0);
            if (storage.reason) this._field("STORAGE REASON", storage.reason);
        }
        if (security.profile.systemEnforcementPending) this._line("SYSTEM ENFORCEMENT PENDING", "warning");
        if (security.profile.sessionRestartRequired) this._line("SESSION RESTART REQUIRED", "warning");
        this._securityControls();
    }

    _securityControls() {
        const profileRow = this.document.createElement("div");
        profileRow.className = "nomad_profile_buttons";
        ["NORMAL", "PUBLIC", "LOCKDOWN"].forEach(profile => profileRow.append(
            this._button(profile, () => this.request("SECURITY_PROFILE_SET", profile))
        ));
        const actionRow = this.document.createElement("div");
        actionRow.className = "nomad_security_buttons";
        actionRow.append(
            this._button("STATUS", () => this.request("SECURITY_STATUS")),
            this._button("AUDIT", () => this.request("SECURITY_AUDIT")),
            this._button("PLAN", () => this.request("SECURITY_PLAN", this.currentProfile)),
            this._button("VERIFY", () => this.request("SECURITY_VERIFY")),
            this._button("APPLY POLICY", () => this.request("SECURITY_APPLY_POLICY", this.currentProfile)),
            this._button("RESTORE", () => this.request("SECURITY_RESTORE"))
        );
        this.controls.append(profileRow, actionRow);
    }

    _renderSecurityPlan(plan) {
        this._clear();
        this._field("TARGET PROFILE", plan.targetProfile);
        this._field("SELECTED PROFILE", plan.selectedProfile);
        this._field("STATUS", plan.status);
        this._field("SAFE TO APPLY", plan.safeToApply ? "YES" : "NO");
        if (plan.helper) {
            this._field("PRIVILEGED HELPER", plan.helper.status);
            this._field("HELPER RUNTIME", `${plan.helper.runtime || "/usr/bin/node"} // ${plan.helper.runtimeTrusted ? "TRUSTED" : "UNAVAILABLE"}`);
        }
        if (plan.storage) {
            this._field("HOST STORAGE", plan.storage.observation || plan.storage.state);
            this._field("ROOT BACKING", plan.storage.rootBacking);
            this._field("REPOSITORY BACKING", plan.storage.repositoryBacking);
            this._field("SAFE UNMOUNT CANDIDATES", plan.storage.safeUnmountCandidates ?? plan.storage.eligibleCount ?? 0);
            if (plan.storage.reason) this._field("REASON", plan.storage.reason);
        }
        (plan.categories || []).forEach(category => this._field(category.label, `${category.current} -> ${category.desired}`));
        this._securityControls();
    }

    _renderApplications(result) {
        this._clear();
        const applications = Array.isArray(result.applications) ? result.applications : [];
        const byId = new Map(applications.map(application => [application.id, application]));
        const catalog = Array.isArray(result.catalog) ? result.catalog : [];
        const ids = Array.from(new Set(applications.map(item => item.id).concat(catalog.map(item => item.id)))).sort();
        ids.forEach(id => {
            const application = byId.get(id) || null;
            const catalogEntry = catalog.find(item => item.id === id) || null;
            const row = this.document.createElement("section");
            row.className = "nomad_application_row";
            const label = this.document.createElement("p");
            label.textContent = `${application ? application.displayName : catalogEntry.displayName} // ${application
                ? (application.available === false ? "UNAVAILABLE" : "INSTALLED") : (catalogEntry.available ? "AVAILABLE" : "UNAVAILABLE")}`;
            const actions = this.document.createElement("div");
            if (application) {
                actions.append(this._button("INFO", () => this.request("APPLICATION_INFO", id)));
                if (application.available !== false) actions.append(this._button("OPEN", () => this.request("APPLICATION_OPEN", id)));
                if (application.type === "external") actions.append(this._button("CLOSE", () => this.request("APPLICATION_CLOSE", id)));
                if (!application.permanent) actions.append(this._button("REMOVE", () => this.request("APPLICATION_REMOVE", id)));
            } else if (catalogEntry && catalogEntry.available) actions.append(this._button("INSTALL", () => this.request("APPLICATION_INSTALL", id)));
            row.append(label, actions);
            this.output.appendChild(row);
        });
        this.controls.append(this._button("DISCOVER NEW", () => this.request("APPLICATION_SCAN")));
        (result.discovered || []).forEach(app => {
            this._line(`NEW APPLICATION DETECTED // ${app.displayName} // ${app.status}`, "warning");
            this.output.append(this._button("ADD TO NOMAD", () => this.request("APPLICATION_REGISTER", app.id)),
                this._button("IGNORE", () => this.request("APPLICATION_IGNORE", app.id)));
        });
        if (!ids.length) this._line("NO APPLICATIONS AVAILABLE", "muted");
    }

    _button(label, handler, id = "") {
        const button = this.document.createElement("button");
        button.type = "button";
        button.textContent = label;
        if (id) button.id = id;
        button.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            handler();
        });
        return button;
    }
}

if (typeof module !== "undefined" && typeof window === "undefined") module["exports"] = {ControlPlaneView};
