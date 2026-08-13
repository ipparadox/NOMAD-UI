class RepositoryLauncher {
    constructor(opts = {}) {
        this.document = opts.document || (typeof document !== "undefined" ? document : null);
        this.hostWindow = opts.window || (typeof window !== "undefined" ? window : null);
        this.container = typeof opts.container === "string" && this.document
            ? this.document.getElementById(opts.container)
            : (opts.container || null);
        this.folderIcon = opts.folderIcon || null;
        this.addTrigger = typeof opts.addTrigger === "string" && this.document
            ? this.document.getElementById(opts.addTrigger)
            : (opts.addTrigger || null);
        this.loadRepositories = typeof opts.loadRepositories === "function" ? opts.loadRepositories : (async () => ({repositories: []}));
        this.onaction = typeof opts.onaction === "function" ? opts.onaction : (async () => ({ok: false, status: "ACTION UNAVAILABLE"}));
        this.onclone = typeof opts.onclone === "function" ? opts.onclone : (async () => ({ok: false, status: "CLONE UNAVAILABLE"}));
        this.oncancelclone = typeof opts.oncancelclone === "function"
            ? opts.oncancelclone : (async () => ({ok: false, status: "NO CLONE IN PROGRESS"}));
        this.onInputCaptureChange = typeof opts.onInputCaptureChange === "function"
            ? opts.onInputCaptureChange : (() => {});
        this.getActiveId = typeof opts.getActiveId === "function" ? opts.getActiveId : (() => null);
        this.onResume = typeof opts.onResume === "function" ? opts.onResume : (() => false);
        this.repositories = [];
        this.status = null;
        this.isOpen = false;
        this.selectedRepositoryId = null;
        this.selectedActionIndex = 0;
        this.selectedChoiceIndex = 0;
        this.view = "actions";
        this.info = null;
        this.prompt = null;
        this.repositoryUrl = "";
        this.cloneResult = "";
        this.cloneCancellationRequested = false;
        this.errorMessage = "";
        this.busy = false;
        this.inputCaptureActive = false;
        this.previousActiveId = null;
        this.element = null;
        this.entryElements = new Map();
        this._onKeydown = event => this._handleKeydown(event);
        this._onResize = () => this._position();
        this._onAddClick = () => this.openAdd();
        this._onAddKeydown = event => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            this.openAdd();
        };
        if (this.document) {
            this._mount();
            if (this.addTrigger) {
                this.addTrigger.addEventListener("click", this._onAddClick);
                this.addTrigger.addEventListener("keydown", this._onAddKeydown);
            }
        }
    }

    async render() {
        return this.refresh();
    }

    async refresh() {
        let result;
        try {
            result = await this.loadRepositories();
        } catch (error) {
            result = {ok: false, status: "REPOSITORY SERVICE UNAVAILABLE", repositories: []};
        }
        this.setRepositories(result && Array.isArray(result.repositories) ? result.repositories : [], result && result.status);
        return Boolean(result && result.ok !== false);
    }

    setRepositories(repositories, status = null) {
        const selectedId = this.selectedRepositoryId;
        this.repositories = (repositories || []).map(repository => this._normalizeRepository(repository)).filter(Boolean);
        this.status = typeof status === "string" ? status : (this.repositories.length ? null : "NO REPOSITORIES DETECTED");
        this._renderRepositories();

        if (selectedId && !this.repositories.some(repository => repository.id === selectedId)) {
            this.close({restoreFocus: false});
        } else if (this.isOpen) {
            this._renderMenu();
        }
        return this.repositories.slice();
    }

    selectRepository(repositoryId) {
        if (this.isOpen && this.busy) return false;
        const repository = this.repositories.find(item => item.id === repositoryId);
        if (!repository) return false;
        if (!this.isOpen) this.previousActiveId = this.getActiveId();
        this._setInputCapture(false);
        this.selectedRepositoryId = repository.id;
        this.selectedActionIndex = 0;
        this.view = "actions";
        this.info = null;
        this.prompt = null;
        this.selectedChoiceIndex = 0;
        this.errorMessage = "";
        this.busy = false;
        this.isOpen = true;
        this._renderMenu();
        if (this.element) {
            this.element.hidden = false;
            this.element.style.visibility = "hidden";
            this.document.addEventListener("keydown", this._onKeydown, true);
            if (this.hostWindow) this.hostWindow.addEventListener("resize", this._onResize);
            this._position();
            this.element.style.visibility = "";
            this.element.focus({preventScroll: true});
        }
        return true;
    }

    openAdd() {
        if (this.busy) return false;
        if (this.isOpen) this.close({restoreFocus: false, resume: false});
        this.previousActiveId = this.getActiveId();
        this.selectedRepositoryId = null;
        this.selectedChoiceIndex = 0;
        this.view = "add";
        this.info = null;
        this.prompt = null;
        this.repositoryUrl = "";
        this.cloneResult = "";
        this.cloneCancellationRequested = false;
        this.errorMessage = "";
        this.busy = false;
        this.isOpen = true;
        this._setInputCapture(true);
        this._renderMenu();
        if (this.element) {
            this.element.hidden = false;
            this.element.style.visibility = "hidden";
            this.document.addEventListener("keydown", this._onKeydown, true);
            if (this.hostWindow) this.hostWindow.addEventListener("resize", this._onResize);
            this._position();
            this.element.style.visibility = "";
            if (this.cloneInputElement) this.cloneInputElement.focus({preventScroll: true});
            else this.element.focus({preventScroll: true});
        }
        return true;
    }

    setRepositoryUrl(value) {
        this.repositoryUrl = typeof value === "string" ? value.slice(0, 512) : "";
        if (this.cloneInputElement) this.cloneInputElement.value = this.repositoryUrl;
        return this.repositoryUrl;
    }

    updateGitState(state) {
        if (!state || typeof state !== "object" || Array.isArray(state)) return false;
        if (state.operation === "clone" && this.isOpen && this.view === "add" && this.busy) {
            const progress = typeof state.progress === "string" ? state.progress.slice(0, 160) : "";
            this.errorMessage = progress || (state.state === "CLONING" ? "CLONING" : "");
            this._renderMenu();
            return true;
        }
        if (state.operation === "pull" && state.state === "UPDATING"
            && typeof state.repositoryId === "string") {
            const repository = this.repositories.find(item => item.id === state.repositoryId);
            const pull = repository && repository.actions.find(action => action.id === "pull");
            if (!pull) return false;
            pull.enabled = false;
            pull.state = "UPDATING";
            if (this.isOpen && this.selectedRepositoryId === repository.id) this._renderMenu();
            return true;
        }
        return false;
    }

    close(opts = {}) {
        if (!this.isOpen) return false;
        if (this.busy && this.view === "add") return false;
        const selectedId = this.selectedRepositoryId;
        const wasAdd = this.view === "add" || this.view === "clone-complete";
        const resumeId = this.previousActiveId;
        this.isOpen = false;
        this.selectedRepositoryId = null;
        this.view = "actions";
        this.info = null;
        this.prompt = null;
        this.repositoryUrl = "";
        this.cloneResult = "";
        this.cloneCancellationRequested = false;
        this.selectedChoiceIndex = 0;
        this.errorMessage = "";
        this.busy = false;
        this.previousActiveId = null;
        this._setInputCapture(false);
        if (this.element) {
            this.element.hidden = true;
            this.document.removeEventListener("keydown", this._onKeydown, true);
            if (this.hostWindow) this.hostWindow.removeEventListener("resize", this._onResize);
        }
        const resumed = opts.resume !== false && resumeId ? this.onResume(resumeId) === true : false;
        if (opts.restoreFocus !== false && !resumed) {
            const entry = wasAdd ? this.addTrigger : this.entryElements.get(selectedId);
            if (entry && typeof entry.focus === "function") entry.focus({preventScroll: true});
        }
        return true;
    }

    async activate(actionId) {
        if (!this.isOpen || this.busy || this.view !== "actions") return false;
        const repository = this._selectedRepository();
        const action = repository && repository.actions.find(item => item.id === actionId);
        if (!repository || !action || !action.enabled) {
            if (repository && action && action.id === "run" && repository.executionSecurity
                && !repository.executionSecurity.allowed) {
                this._showError(repository.executionSecurity.securityProfile === "LOCKDOWN"
                    ? "EXECUTION BLOCKED\nLOCKDOWN POLICY DISABLES REPOSITORY EXECUTION"
                    : "EXECUTION BLOCKED\nISOLATION REQUIREMENT NOT MET");
            } else this._showError("ACTION UNAVAILABLE");
            return false;
        }

        return this._invokeAction(repository, action, {});
    }

    async _invokeAction(repository, action, details) {
        if (!this.isOpen || this.busy || !repository || !action) return false;

        this.busy = true;
        this.errorMessage = "";
        this._renderMenu();
        let result;
        try {
            result = await this.onaction(repository.id, action.id, details || {});
        } catch (error) {
            result = {ok: false, status: "REPOSITORY ACTION FAILED"};
        }
        this.busy = false;

        if (!result || !result.ok) {
            const status = result && typeof result.status === "string" ? result.status : "REPOSITORY ACTION FAILED";
            if (status === "REPOSITORY NOT FOUND") {
                this.close({restoreFocus: false});
                await this.refresh();
            } else {
                if (action.id === "pull") await this.refresh();
                if (this.view === "prompt") {
                    this.view = "actions";
                    this.prompt = null;
                }
                this._showError(status);
            }
            return false;
        }

        let updatedRepository = null;
        if (result.repository) {
            updatedRepository = this._normalizeRepository(result.repository);
            if (updatedRepository) {
                const index = this.repositories.findIndex(item => item.id === updatedRepository.id);
                if (index >= 0) this.repositories[index] = updatedRepository;
            }
        }

        if (result.prompt) {
            const prompt = this._normalizePrompt(result.prompt);
            if (!prompt) {
                this._showError("RUN PROMPT INVALID");
                return false;
            }
            this.prompt = prompt;
            this.selectedChoiceIndex = 0;
            this.view = "prompt";
            this._renderMenu();
            return true;
        }

        if (action.id === "info" && result.repository) {
            const info = updatedRepository;
            if (!info) {
                this._showError("REPOSITORY INFO UNAVAILABLE");
                return false;
            }
            this.info = info;
            this.view = "info";
            this._renderMenu();
            return true;
        }

        if ((action.id === "run" || action.id === "stop" || action.id === "pull") && updatedRepository) {
            this.prompt = null;
            this.view = "actions";
            this._renderMenu();
            return true;
        }

        this.close({restoreFocus: false, resume: false});
        return true;
    }

    activateSelected() {
        const repository = this._selectedRepository();
        const action = repository && repository.actions[this.selectedActionIndex];
        return action ? this.activate(action.id) : Promise.resolve(false);
    }

    activateChoice() {
        if (!this.isOpen || this.busy || this.view !== "prompt" || !this.prompt) return Promise.resolve(false);
        const choice = this.prompt.choices[this.selectedChoiceIndex];
        if (!choice || !choice.enabled) {
            this._showError("ACTION UNAVAILABLE");
            return Promise.resolve(false);
        }
        if (choice.id === "cancel") {
            this.close();
            return Promise.resolve(true);
        }
        const repository = this._selectedRepository();
        const action = repository && repository.actions.find(item => item.id === "run");
        if (!repository || !action) return Promise.resolve(false);
        if (this.prompt.kind === "profile-selection") {
            return this._invokeAction(repository, action, {profileId: choice.id});
        }
        return this._invokeAction(repository, action, {
            profileId: this.prompt.profileId,
            authorizationId: this.prompt.authorizationId,
            authorization: choice.id
        });
    }

    _cloneChoices() {
        return [
            {id: "clone", label: "CLONE", enabled: !this.busy, state: this.busy ? "CLONING" : ""},
            {
                id: "cancel",
                label: "CANCEL",
                enabled: true,
                state: this.busy ? (this.cloneCancellationRequested ? "STOPPING" : "STOP CLONE") : ""
            }
        ];
    }

    activateAddChoice() {
        if (!this.isOpen || this.view !== "add") return Promise.resolve(false);
        const choice = this._cloneChoices()[this.selectedChoiceIndex];
        if (!choice) return Promise.resolve(false);
        if (choice.id === "cancel") {
            if (this.busy) return this._cancelClone();
            this.close();
            return Promise.resolve(true);
        }
        return this._cloneRepository();
    }

    async _cloneRepository() {
        if (!this.isOpen || this.view !== "add" || this.busy) return false;
        const candidate = this.cloneInputElement ? this.cloneInputElement.value : this.repositoryUrl;
        this.repositoryUrl = typeof candidate === "string" ? candidate.slice(0, 512) : "";
        if (!this.repositoryUrl.trim()) {
            this._showError("GITHUB URL REQUIRED");
            return false;
        }
        this.busy = true;
        this.cloneCancellationRequested = false;
        this.errorMessage = "";
        this._renderMenu();
        let result;
        try {
            result = await this.onclone(this.repositoryUrl);
        } catch (error) {
            result = {ok: false, status: "CLONE FAILED"};
        }
        this.busy = false;
        this.cloneCancellationRequested = false;
        if (!result || !result.ok) {
            this._showError(result && typeof result.status === "string" ? result.status : "CLONE FAILED");
            if (this.cloneInputElement) this.cloneInputElement.focus({preventScroll: true});
            return false;
        }
        await this.refresh();
        this.view = "clone-complete";
        this.cloneResult = typeof result.status === "string"
            ? result.status.slice(0, 128) : "CLONE COMPLETE\nREPOSITORY REGISTERED";
        this.errorMessage = "";
        this._renderMenu();
        if (this.element) this.element.focus({preventScroll: true});
        return true;
    }

    async _cancelClone() {
        if (!this.busy || this.cloneCancellationRequested) return false;
        this.cloneCancellationRequested = true;
        this._renderMenu();
        try {
            await this.oncancelclone();
        } catch (error) {
            this.cloneCancellationRequested = false;
            this._showError("CLONE CANCELLATION FAILED");
            return false;
        }
        return true;
    }

    destroy() {
        this.close({restoreFocus: false, resume: false});
        this._setInputCapture(false);
        if (this.addTrigger) {
            this.addTrigger.removeEventListener("click", this._onAddClick);
            this.addTrigger.removeEventListener("keydown", this._onAddKeydown);
        }
        if (this.element) this.element.remove();
        this.entryElements.clear();
    }

    _mount() {
        this.element = this.document.createElement("section");
        this.element.id = "repository_actions";
        this.element.className = "repository_actions";
        this.element.hidden = true;
        this.element.tabIndex = -1;
        this.element.setAttribute("role", "dialog");
        this.element.setAttribute("aria-modal", "false");
        this.element.setAttribute("aria-labelledby", "repository_actions_title");

        this.titleElement = this.document.createElement("h2");
        this.titleElement.id = "repository_actions_title";
        this.actionListElement = this.document.createElement("ul");
        this.actionListElement.id = "repository_action_list";
        this.actionListElement.setAttribute("role", "listbox");
        this.promptElement = this.document.createElement("div");
        this.promptElement.className = "repository_action_summary repository_prompt_summary";
        this.cloneFormElement = this.document.createElement("div");
        this.cloneFormElement.className = "repository_clone_form";
        const cloneLabel = this.document.createElement("label");
        cloneLabel.htmlFor = "repository_clone_url";
        cloneLabel.textContent = "GITHUB URL:";
        this.cloneInputElement = this.document.createElement("input");
        this.cloneInputElement.id = "repository_clone_url";
        this.cloneInputElement.type = "text";
        this.cloneInputElement.inputMode = "url";
        this.cloneInputElement.autocomplete = "off";
        this.cloneInputElement.spellcheck = false;
        this.cloneInputElement.placeholder = "https://github.com/owner/repo";
        this.cloneInputElement.maxLength = 512;
        this.cloneInputElement.addEventListener("input", () => {
            this.repositoryUrl = this.cloneInputElement.value.slice(0, 512);
            this.errorMessage = "";
        });
        this.cloneInputElement.addEventListener("change", event => {
            if (event.detail === "enter") this._cloneRepository();
        });
        this.cloneFormElement.append(cloneLabel, this.cloneInputElement);
        this.infoElement = this.document.createElement("dl");
        this.infoElement.className = "repository_info";
        this.errorElement = this.document.createElement("p");
        this.errorElement.className = "repository_action_error";
        this.errorElement.setAttribute("role", "status");
        this.summaryElement = this.document.createElement("div");
        this.summaryElement.className = "repository_action_summary";
        this.footerElement = this.document.createElement("p");
        this.footerElement.className = "repository_action_help";

        this.element.append(
            this.titleElement,
            this.promptElement,
            this.cloneFormElement,
            this.actionListElement,
            this.infoElement,
            this.errorElement,
            this.summaryElement,
            this.footerElement
        );
        this.document.body.appendChild(this.element);
    }

    _normalizeRepository(repository) {
        if (!repository || typeof repository !== "object" || Array.isArray(repository)) return null;
        if (typeof repository.id !== "string" || !/^repo_[a-f0-9]{32}$/.test(repository.id)) return null;
        const actions = Array.isArray(repository.actions) ? repository.actions.map(action => {
            if (!action || typeof action.id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(action.id)) return null;
            return {
                id: action.id,
                label: typeof action.label === "string" ? action.label.slice(0, 32) : action.id.toUpperCase(),
                enabled: action.enabled === true,
                state: typeof action.state === "string" ? action.state.slice(0, 64) : ""
            };
        }).filter(Boolean) : [];
        let processState = null;
        if (repository.process && typeof repository.process === "object" && !Array.isArray(repository.process)
            && ["STARTING", "RUNNING", "STOPPING", "STOPPED", "FAILED"].includes(repository.process.state)) {
            processState = {
                profileId: typeof repository.process.profileId === "string" ? repository.process.profileId.slice(0, 64) : "UNKNOWN",
                displayName: typeof repository.process.displayName === "string" ? repository.process.displayName.slice(0, 64) : "UNKNOWN",
                state: repository.process.state,
                startedAt: typeof repository.process.startedAt === "string" ? repository.process.startedAt.slice(0, 64) : null,
                exitedAt: typeof repository.process.exitedAt === "string" ? repository.process.exitedAt.slice(0, 64) : null,
                exitCode: Number.isInteger(repository.process.exitCode) ? repository.process.exitCode : null,
                signal: typeof repository.process.signal === "string" ? repository.process.signal.slice(0, 32) : null,
                securityProfile: ["NORMAL", "PUBLIC", "LOCKDOWN"].includes(repository.process.securityProfile)
                    ? repository.process.securityProfile : "UNKNOWN",
                isolationLevel: ["STRONG", "PARTIAL", "NONE", "UNAVAILABLE"].includes(repository.process.isolationLevel)
                    ? repository.process.isolationLevel : "UNAVAILABLE",
                isolationBackend: typeof repository.process.isolationBackend === "string"
                    ? repository.process.isolationBackend.slice(0, 32) : "UNAVAILABLE"
            };
        }
        const execution = repository.executionSecurity && typeof repository.executionSecurity === "object"
            && !Array.isArray(repository.executionSecurity) ? repository.executionSecurity : {};
        return {
            id: repository.id,
            displayName: typeof repository.displayName === "string" ? repository.displayName.slice(0, 255) : "REPOSITORY",
            relativePath: typeof repository.relativePath === "string" ? repository.relativePath.slice(0, 255) : "REPOSITORY",
            branch: typeof repository.branch === "string" ? repository.branch.slice(0, 160) : "UNKNOWN",
            dirty: repository.dirty === true,
            status: repository.status === "MODIFIED" ? "MODIFIED" : "CLEAN",
            modifiedFileCount: Number.isSafeInteger(repository.modifiedFileCount) && repository.modifiedFileCount >= 0 ? repository.modifiedFileCount : 0,
            remoteAvailable: repository.remoteAvailable === true,
            remoteProvider: ["GITHUB", "OTHER", "NONE"].includes(repository.remoteProvider) ? repository.remoteProvider : "NONE",
            remote: typeof repository.remote === "string" ? repository.remote.slice(0, 255) : "NONE",
            upstream: typeof repository.upstream === "string" ? repository.upstream.slice(0, 255) : "NONE",
            ahead: Number.isSafeInteger(repository.ahead) && repository.ahead >= 0 ? repository.ahead : null,
            behind: Number.isSafeInteger(repository.behind) && repository.behind >= 0 ? repository.behind : null,
            repositoryAvailable: repository.repositoryAvailable !== false,
            executionSecurity: {
                allowed: execution.allowed === true,
                authorization: ["TRUSTED", "REQUIRED"].includes(execution.authorization)
                    ? execution.authorization : "REQUIRED",
                securityProfile: ["NORMAL", "PUBLIC", "LOCKDOWN"].includes(execution.securityProfile)
                    ? execution.securityProfile : "UNKNOWN",
                level: ["STRONG", "PARTIAL", "NONE", "UNAVAILABLE"].includes(execution.level)
                    ? execution.level : "UNAVAILABLE",
                backend: typeof execution.backend === "string" ? execution.backend.slice(0, 32) : "UNAVAILABLE"
            },
            process: processState,
            actions
        };
    }

    _normalizePrompt(prompt) {
        if (!prompt || typeof prompt !== "object" || Array.isArray(prompt)
            || !["profile-selection", "authorization"].includes(prompt.kind)
            || typeof prompt.title !== "string" || !Array.isArray(prompt.fields)
            || !Array.isArray(prompt.choices) || !prompt.choices.length || prompt.choices.length > 16) return null;
        const fields = prompt.fields.slice(0, 8).map(field => {
            if (!field || typeof field !== "object" || Array.isArray(field)
                || typeof field.label !== "string" || typeof field.value !== "string") return null;
            return {label: field.label.slice(0, 32), value: field.value.slice(0, 512)};
        }).filter(Boolean);
        if (fields.length !== Math.min(prompt.fields.length, 8)) return null;
        const choices = prompt.choices.map(choice => {
            if (!choice || typeof choice !== "object" || Array.isArray(choice)
                || typeof choice.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(choice.id)
                || typeof choice.label !== "string") return null;
            return {
                id: choice.id,
                label: choice.label.slice(0, 96),
                enabled: choice.enabled === true,
                state: typeof choice.state === "string" ? choice.state.slice(0, 64) : ""
            };
        }).filter(Boolean);
        if (choices.length !== prompt.choices.length) return null;
        const normalized = {
            kind: prompt.kind,
            title: prompt.title.slice(0, 64),
            repositoryName: typeof prompt.repositoryName === "string" ? prompt.repositoryName.slice(0, 255) : "REPOSITORY",
            fields,
            warning: typeof prompt.warning === "string" ? prompt.warning.slice(0, 512) : "",
            choices
        };
        if (prompt.kind === "authorization") {
            if (typeof prompt.profileId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(prompt.profileId)
                || typeof prompt.authorizationId !== "string" || !/^auth_[a-f0-9]{48}$/.test(prompt.authorizationId)) return null;
            normalized.profileId = prompt.profileId;
            normalized.authorizationId = prompt.authorizationId;
        }
        return normalized;
    }

    _renderRepositories() {
        if (!this.container || !this.document) return;
        this.container.replaceChildren();
        this.entryElements.clear();
        if (!this.repositories.length) {
            const status = this.document.createElement("p");
            status.className = "repository_status";
            status.textContent = this.status || "NO REPOSITORIES DETECTED";
            this.container.appendChild(status);
            return;
        }

        this.repositories.forEach(repository => {
            const entry = this.document.createElement("div");
            entry.className = "repository_entry";
            entry.title = repository.displayName;
            entry.tabIndex = 0;
            entry.dataset.repositoryId = repository.id;
            entry.setAttribute("role", "button");
            entry.setAttribute("aria-haspopup", "dialog");
            entry.setAttribute("aria-controls", "repository_actions");

            if (this.folderIcon) entry.appendChild(this.folderIcon.cloneNode(true));
            const name = this.document.createElement("h3");
            name.textContent = repository.displayName;
            entry.appendChild(name);

            const select = () => this.selectRepository(repository.id);
            entry.addEventListener("click", select);
            entry.addEventListener("keydown", event => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                select();
            });
            this.entryElements.set(repository.id, entry);
            this.container.appendChild(entry);
        });
    }

    _renderMenu() {
        if (!this.element) return;
        const repositoryView = ["actions", "prompt", "info"].includes(this.view);
        const repository = this.view === "info" ? this.info : this._selectedRepository();
        if (repositoryView && !repository) {
            this.close({restoreFocus: false});
            return;
        }
        this.titleElement.textContent = this.view === "add" ? "ADD REPOSITORY"
            : (this.view === "clone-complete" ? "CLONE COMPLETE"
                : (this.view === "info" ? "REPOSITORY INFO"
                    : (this.view === "prompt" && this.prompt ? this.prompt.title : repository.displayName)));
        this.actionListElement.hidden = this.view === "info" || this.view === "clone-complete";
        this.promptElement.hidden = this.view !== "prompt" && this.view !== "clone-complete";
        this.cloneFormElement.hidden = this.view !== "add";
        this.infoElement.hidden = this.view !== "info";
        this.summaryElement.hidden = this.view !== "actions";
        this.footerElement.textContent = this.view === "info" || this.view === "clone-complete"
            ? "ESC CLOSE"
            : (this.view === "prompt"
                ? "UP/DOWN SELECT  //  ENTER CONFIRM  //  ESC CANCEL"
                : (this.view === "add"
                    ? "ENTER CLONE  //  ESC CANCEL"
                    : "UP/DOWN SELECT  //  ENTER OPEN  //  ESC CLOSE"));

        if (this.view === "actions") {
            this._renderList(repository.actions, "action", this.selectedActionIndex,
                index => this._selectAction(index), entry => this.activate(entry.id));
            this._selectAction(this.selectedActionIndex);
            this._renderSummary(repository);
        } else if (this.view === "prompt" && this.prompt) {
            this._renderList(this.prompt.choices, "choice", this.selectedChoiceIndex,
                index => this._selectChoice(index), () => this.activateChoice());
            this._selectChoice(this.selectedChoiceIndex);
            this._renderPrompt(this.prompt);
        } else if (this.view === "add") {
            const choices = this._cloneChoices();
            this._renderList(choices, "choice", this.selectedChoiceIndex,
                index => this._selectChoice(index), () => this.activateAddChoice());
            this._selectChoice(this.selectedChoiceIndex);
        } else if (this.view === "clone-complete") {
            this._renderCloneComplete();
        } else {
            this._renderInfo(repository);
        }
        this.errorElement.textContent = this.errorMessage || (this.busy
            ? (this.view === "add" ? "CLONING" : "ACTION IN PROGRESS") : "");
        this.errorElement.hidden = !this.errorElement.textContent;
        if (this.isOpen) this._position();
    }

    _renderSummary(repository) {
        this.summaryElement.replaceChildren();
        const fields = [["BRANCH", repository.branch], ["STATUS", repository.status]];
        if (repository.executionSecurity) {
            fields.push(
                ["AUTH", repository.executionSecurity.authorization],
                ["ISOLATION", repository.executionSecurity.level],
                ["SECURITY", repository.executionSecurity.securityProfile]
            );
        }
        if (repository.process) {
            fields.push(["PROCESS", repository.process.state], ["RUN PROFILE", repository.process.displayName]);
        }
        fields.forEach(field => this._appendSummaryLine(field[0], field[1]));
    }

    _renderPrompt(prompt) {
        this.promptElement.replaceChildren();
        const heading = this.document.createElement("p");
        heading.className = "repository_prompt_repository";
        heading.textContent = prompt.repositoryName;
        this.promptElement.appendChild(heading);
        prompt.fields.forEach(field => this._appendSummaryLine(field.label, field.value, this.promptElement));
        if (prompt.warning) {
            const warning = this.document.createElement("p");
            warning.className = "repository_run_warning";
            warning.textContent = prompt.warning;
            this.promptElement.appendChild(warning);
        }
    }

    _renderCloneComplete() {
        this.promptElement.replaceChildren();
        const status = this.document.createElement("p");
        status.className = "repository_clone_complete";
        status.textContent = this.cloneResult || "CLONE COMPLETE\nREPOSITORY REGISTERED";
        this.promptElement.appendChild(status);
    }

    _appendSummaryLine(label, value, container = this.summaryElement) {
        const line = this.document.createElement("p");
        const key = this.document.createElement("span");
        const output = this.document.createElement("span");
        key.textContent = `${label}:`;
        output.textContent = value;
        line.append(key, output);
        container.appendChild(line);
    }

    _renderInfo(repository) {
        this.infoElement.replaceChildren();
        const fields = [
            ["NAME", repository.displayName],
            ["PATH", repository.relativePath],
            ["BRANCH", repository.branch],
            ["STATUS", repository.status],
            ["MODIFIED", String(repository.modifiedFileCount)],
            ["REMOTE", repository.remote],
            ["UPSTREAM", repository.upstream],
            ["AHEAD", repository.ahead === null ? "UNKNOWN" : String(repository.ahead)],
            ["BEHIND", repository.behind === null ? "UNKNOWN" : String(repository.behind)],
            ["PROCESS", repository.process ? repository.process.state : "STOPPED"],
            ["AUTHORIZATION", repository.executionSecurity.authorization],
            ["ISOLATION", repository.executionSecurity.level],
            ["PROFILE", repository.executionSecurity.securityProfile]
        ];
        fields.forEach(([label, value]) => {
            const term = this.document.createElement("dt");
            const description = this.document.createElement("dd");
            term.textContent = label;
            description.textContent = value;
            this.infoElement.append(term, description);
        });
    }

    _showError(message) {
        this.errorMessage = typeof message === "string" ? message.slice(0, 96) : "REPOSITORY ACTION FAILED";
        this._renderMenu();
    }

    _renderList(entries, prefix, selectedIndex, onSelect, onActivate) {
        this.actionListElement.replaceChildren();
        entries.forEach((entry, index) => {
            const item = this.document.createElement("li");
            const button = this.document.createElement("button");
            const pointer = this.document.createElement("span");
            const label = this.document.createElement("span");
            const state = this.document.createElement("span");
            button.id = `repository_${prefix}_${entry.id}`;
            button.type = "button";
            button.dataset.repositorySelection = entry.id;
            button.setAttribute("role", "option");
            button.setAttribute("aria-selected", index === selectedIndex ? "true" : "false");
            button.setAttribute("aria-disabled", entry.enabled ? "false" : "true");
            button.tabIndex = -1;
            pointer.className = "repository_action_pointer";
            pointer.textContent = ">";
            pointer.setAttribute("aria-hidden", "true");
            label.className = "repository_action_label";
            label.textContent = entry.label;
            state.className = "repository_action_state";
            state.textContent = entry.state || (entry.enabled ? "" : "UNAVAILABLE");
            button.append(pointer, label, state);
            button.addEventListener("mouseenter", () => onSelect(index));
            button.addEventListener("click", event => {
                event.preventDefault();
                event.stopPropagation();
                onSelect(index);
                onActivate(entry);
            });
            item.appendChild(button);
            this.actionListElement.appendChild(item);
        });
    }

    _selectAction(index) {
        const repository = this._selectedRepository();
        if (!repository || !repository.actions.length) return;
        this.selectedActionIndex = (index + repository.actions.length) % repository.actions.length;
        if (!this.actionListElement) return;
        this.actionListElement.querySelectorAll("button").forEach((button, buttonIndex) => {
            button.setAttribute("aria-selected", buttonIndex === this.selectedActionIndex ? "true" : "false");
        });
        const action = repository.actions[this.selectedActionIndex];
        if (action) this.element.setAttribute("aria-activedescendant", `repository_action_${action.id}`);
    }

    _selectChoice(index) {
        const choices = this.view === "add" ? this._cloneChoices() : (this.prompt && this.prompt.choices);
        if (!choices || !choices.length) return;
        this.selectedChoiceIndex = (index + choices.length) % choices.length;
        if (!this.actionListElement) return;
        this.actionListElement.querySelectorAll("button").forEach((button, buttonIndex) => {
            button.setAttribute("aria-selected", buttonIndex === this.selectedChoiceIndex ? "true" : "false");
        });
        const choice = choices[this.selectedChoiceIndex];
        if (choice) this.element.setAttribute("aria-activedescendant", `repository_choice_${choice.id}`);
    }

    _handleKeydown(event) {
        if (!this.isOpen) return;
        let handled = true;
        if (this.ownsInputTarget(event.target)) {
            if (event.key === "Escape") {
                if (this.busy) this._cancelClone();
                else this.close();
            } else if (event.key === "Enter") this._cloneRepository();
            else return;
        } else if (this.view === "add" && event.key === "Escape") {
            if (this.busy) this._cancelClone();
            else this.close();
        } else if (this.view === "clone-complete" && (event.key === "Escape" || event.key === "Enter")) this.close();
        else if (event.key === "Escape") this.close();
        else if (this.view === "actions" && event.key === "ArrowUp") this._selectAction(this.selectedActionIndex - 1);
        else if (this.view === "actions" && event.key === "ArrowDown") this._selectAction(this.selectedActionIndex + 1);
        else if (this.view === "actions" && event.key === "Enter") this.activateSelected();
        else if (this.view === "prompt" && event.key === "ArrowUp") this._selectChoice(this.selectedChoiceIndex - 1);
        else if (this.view === "prompt" && event.key === "ArrowDown") this._selectChoice(this.selectedChoiceIndex + 1);
        else if (this.view === "prompt" && event.key === "Enter") this.activateChoice();
        else if (this.view === "add" && event.key === "ArrowUp") this._selectChoice(this.selectedChoiceIndex - 1);
        else if (this.view === "add" && event.key === "ArrowDown") this._selectChoice(this.selectedChoiceIndex + 1);
        else if (this.view === "add" && event.key === "Enter") this.activateAddChoice();
        else handled = false;
        if (!handled) return;
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    }

    ownsInputTarget(target) {
        return Boolean(this.isOpen && this.view === "add" && this.cloneInputElement
            && target === this.cloneInputElement);
    }

    _setInputCapture(active) {
        const next = active === true;
        if (this.inputCaptureActive === next) return false;
        this.inputCaptureActive = next;
        this.onInputCaptureChange(next);
        return true;
    }

    _selectedRepository() {
        return this.repositories.find(repository => repository.id === this.selectedRepositoryId) || null;
    }

    _position() {
        if (!this.element || !this.hostWindow) return;
        const entry = this.view === "add" || this.view === "clone-complete"
            ? this.addTrigger : this.entryElements.get(this.selectedRepositoryId);
        if (!entry) return;
        const rect = entry.getBoundingClientRect();
        const gap = Math.max(6, Math.round(this.hostWindow.innerHeight * 0.007));
        const width = Math.max(230, Math.min(330, Math.round(this.hostWindow.innerWidth * 0.17)));
        const left = Math.min(Math.max(gap, rect.left), this.hostWindow.innerWidth - width - gap);
        const top = Math.max(gap, rect.top - this.element.offsetHeight - gap);
        this.element.style.width = `${Math.floor(width)}px`;
        this.element.style.left = `${Math.floor(left)}px`;
        this.element.style.top = `${Math.floor(top)}px`;
    }
}

if (typeof module !== "undefined" && typeof window === "undefined") module.exports = {RepositoryLauncher};
