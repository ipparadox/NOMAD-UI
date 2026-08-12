class ApplicationLauncher {
    constructor(opts = {}) {
        if (!opts.manager) throw new TypeError("Application launcher requires a WorkspaceManager");

        this.manager = opts.manager;
        this.trigger = opts.trigger || null;
        this.document = opts.document || (typeof document !== "undefined" ? document : null);
        this.hostWindow = opts.window || (typeof window !== "undefined" ? window : null);
        this.onResume = typeof opts.onResume === "function" ? opts.onResume : (() => {});
        this.isOpen = false;
        this.previousActiveId = null;
        this.selectedIndex = 0;
        this.entries = [];
        this.errorMessage = "";
        this.element = null;

        this._onTriggerClick = event => {
            event.preventDefault();
            event.stopPropagation();
            this.toggle();
        };
        this._onTriggerKeydown = event => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            this.toggle();
        };
        this._onKeydown = event => this._handleKeydown(event);
        this._onResize = () => this._position();

        if (this.document && this.trigger) this._mount();
        this.unsubscribe = this.manager.subscribe(() => this._sync());
    }

    open(opts = {}) {
        if (this.isOpen) return false;
        this.previousActiveId = this.manager.activeSlotId;
        this.selectedIndex = 0;
        if (!opts.preserveError) this.errorMessage = "";
        this.isOpen = true;
        this._sync();

        if (this.element) {
            this.element.hidden = false;
            this.element.style.visibility = "hidden";
            this.trigger.classList.add("launcher_open");
            this.trigger.setAttribute("aria-expanded", "true");
            this.document.addEventListener("keydown", this._onKeydown, true);
            if (this.hostWindow) this.hostWindow.addEventListener("resize", this._onResize);
            this._position();
            this.element.style.visibility = "";
            this.element.focus({preventScroll: true});
        }
        return true;
    }

    close(opts = {}) {
        if (!this.isOpen) return false;
        const resumeId = this.previousActiveId;
        this.isOpen = false;
        this.previousActiveId = null;

        if (this.element) {
            this.element.hidden = true;
            this.trigger.classList.remove("launcher_open");
            this.trigger.setAttribute("aria-expanded", "false");
            this.document.removeEventListener("keydown", this._onKeydown, true);
            if (this.hostWindow) this.hostWindow.removeEventListener("resize", this._onResize);
        }
        if (opts.resume !== false && resumeId) this.onResume(resumeId);
        return true;
    }

    toggle() {
        return this.isOpen ? this.close() : this.open();
    }

    activate(id) {
        const entry = this.entries.find(application => application.id === id);
        if (!entry || !entry.available) {
            this.showError("APPLICATION NOT FOUND");
            return false;
        }
        if (entry.state === "ACTIVE") {
            this.close();
            return true;
        }

        const activated = this.manager.focus(entry.id);
        if (!activated) {
            this.showError("APPLICATION FAILED TO START");
            return false;
        }
        this.close({resume: false});
        return true;
    }

    activateSelected() {
        const entry = this.entries[this.selectedIndex];
        return entry ? this.activate(entry.id) : false;
    }

    showError(message) {
        this.errorMessage = message === "APPLICATION NOT FOUND"
            ? "APPLICATION NOT FOUND"
            : "APPLICATION FAILED TO START";
        if (!this.isOpen) this.open({preserveError: true});
        else this._renderError();
    }

    destroy() {
        this.close({resume: false});
        if (this.unsubscribe) this.unsubscribe();
        if (this.trigger) {
            this.trigger.removeEventListener("click", this._onTriggerClick);
            this.trigger.removeEventListener("keydown", this._onTriggerKeydown);
        }
        if (this.element) this.element.remove();
    }

    _mount() {
        this.element = this.document.createElement("section");
        this.element.id = "application_launcher";
        this.element.className = "application_launcher";
        this.element.hidden = true;
        this.element.tabIndex = -1;
        this.element.setAttribute("role", "dialog");
        this.element.setAttribute("aria-modal", "false");
        this.element.setAttribute("aria-labelledby", "application_launcher_title");

        const title = this.document.createElement("h2");
        title.id = "application_launcher_title";
        title.textContent = "APPLICATIONS";
        this.listElement = this.document.createElement("ul");
        this.listElement.id = "application_launcher_list";
        this.listElement.setAttribute("role", "listbox");
        this.errorElement = this.document.createElement("p");
        this.errorElement.className = "application_launcher_error";
        this.errorElement.setAttribute("role", "status");
        this.footerElement = this.document.createElement("p");
        this.footerElement.className = "application_launcher_help";
        this.footerElement.textContent = "UP/DOWN SELECT  //  ENTER OPEN  //  ESC CLOSE";

        this.element.appendChild(title);
        this.element.appendChild(this.listElement);
        this.element.appendChild(this.errorElement);
        this.element.appendChild(this.footerElement);
        this.document.body.appendChild(this.element);

        this.trigger.setAttribute("role", "button");
        this.trigger.setAttribute("tabindex", "0");
        this.trigger.setAttribute("aria-haspopup", "dialog");
        this.trigger.setAttribute("aria-controls", this.element.id);
        this.trigger.setAttribute("aria-expanded", "false");
        this.trigger.addEventListener("click", this._onTriggerClick);
        this.trigger.addEventListener("keydown", this._onTriggerKeydown);
    }

    _sync() {
        const selected = this.entries[this.selectedIndex];
        this.entries = this.manager.getApplicationStates()
            .sort((left, right) => left.launcherOrder - right.launcherOrder);
        if (selected) {
            const nextIndex = this.entries.findIndex(entry => entry.id === selected.id);
            this.selectedIndex = nextIndex >= 0 ? nextIndex : 0;
        }
        if (this.selectedIndex >= this.entries.length) this.selectedIndex = Math.max(0, this.entries.length - 1);
        if (this.element) this._render();
    }

    _render() {
        while (this.listElement.firstChild) this.listElement.firstChild.remove();
        this.entries.forEach((entry, index) => {
            const item = this.document.createElement("li");
            const button = this.document.createElement("button");
            const pointer = this.document.createElement("span");
            const label = this.document.createElement("span");
            const state = this.document.createElement("span");

            button.id = `application_launcher_${entry.id}`;
            button.type = "button";
            button.dataset.applicationId = entry.id;
            button.dataset.state = entry.state;
            button.setAttribute("role", "option");
            button.setAttribute("aria-selected", index === this.selectedIndex ? "true" : "false");
            button.tabIndex = -1;
            pointer.className = "application_launcher_pointer";
            pointer.textContent = ">";
            pointer.setAttribute("aria-hidden", "true");
            label.className = "application_launcher_label";
            label.textContent = entry.label;
            state.className = "application_launcher_state";
            state.textContent = entry.state;

            button.appendChild(pointer);
            button.appendChild(label);
            button.appendChild(state);
            button.addEventListener("mouseenter", () => this._selectIndex(index));
            button.addEventListener("click", event => {
                event.preventDefault();
                event.stopPropagation();
                this.selectedIndex = index;
                this.activate(entry.id);
            });
            item.appendChild(button);
            this.listElement.appendChild(item);
        });
        this._selectIndex(this.selectedIndex);
        this._renderError();
    }

    _renderError() {
        if (!this.errorElement) return;
        this.errorElement.textContent = this.errorMessage;
        this.errorElement.hidden = !this.errorMessage;
    }

    _selectIndex(index) {
        if (!this.entries.length) return;
        this.selectedIndex = (index + this.entries.length) % this.entries.length;
        if (!this.listElement) return;
        this.listElement.querySelectorAll("button").forEach((button, buttonIndex) => {
            button.setAttribute("aria-selected", buttonIndex === this.selectedIndex ? "true" : "false");
        });
        const active = this.entries[this.selectedIndex];
        if (active && this.element) this.element.setAttribute("aria-activedescendant", `application_launcher_${active.id}`);
    }

    _handleKeydown(event) {
        if (!this.isOpen) return;
        if (event.key === "ArrowUp") this._selectIndex(this.selectedIndex - 1);
        else if (event.key === "ArrowDown") this._selectIndex(this.selectedIndex + 1);
        else if (event.key === "Enter") this.activateSelected();
        else if (event.key === "Escape") this.close();
        else return;

        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    }

    _position() {
        if (!this.element || !this.trigger || !this.hostWindow) return;
        const rect = this.trigger.getBoundingClientRect();
        const gap = Math.max(6, Math.round(this.hostWindow.innerHeight * 0.007));
        const desiredWidth = Math.max(210, Math.min(320, Math.round(this.hostWindow.innerWidth * 0.15)));
        const availableRight = this.hostWindow.innerWidth - rect.right - (gap * 2);
        const width = availableRight >= 190
            ? Math.min(desiredWidth, availableRight)
            : Math.min(desiredWidth, this.hostWindow.innerWidth - (gap * 2));
        const left = availableRight >= 190
            ? rect.right + gap
            : this.hostWindow.innerWidth - width - gap;

        this.element.style.width = `${Math.floor(width)}px`;
        this.element.style.left = `${Math.floor(left)}px`;
        const maxTop = this.hostWindow.innerHeight - this.element.offsetHeight - gap;
        this.element.style.top = `${Math.max(gap, Math.min(Math.floor(rect.bottom + gap), maxTop))}px`;
    }
}

if (typeof module !== "undefined" && typeof window === "undefined") module.exports = {ApplicationLauncher};
