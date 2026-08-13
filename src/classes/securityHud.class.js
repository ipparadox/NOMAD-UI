class SecurityHud {
    constructor(opts = {}) {
        if (typeof opts.loadStatus !== "function") throw new TypeError("Security HUD requires a status loader");
        this.loadStatus = opts.loadStatus;
        this.Modal = opts.Modal || (typeof Modal !== "undefined" ? Modal : null);
        this.escapeHtml = opts.escapeHtml || (value => String(value)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#039;"));
        this.onOpen = typeof opts.onOpen === "function" ? opts.onOpen : (() => {});
        this.onClose = typeof opts.onClose === "function" ? opts.onClose : (() => {});
        this.opening = false;
    }

    async open() {
        if (this.opening || !this.Modal) return false;
        this.opening = true;
        let response;
        try {
            response = await this.loadStatus();
        } catch (error) {
            response = null;
        }
        this.opening = false;
        if (!response || response.ok !== true) {
            new this.Modal({
                type: "warning",
                title: "NOMAD // SECURITY",
                message: "SECURITY STATUS UNAVAILABLE"
            });
            return false;
        }
        const status = this._normalize(response.status);
        if (!status) return false;
        this.onOpen();
        new this.Modal({
            type: "custom",
            title: "NOMAD // SECURITY STATUS",
            html: this._html(status),
            buttons: []
        }, () => this.onClose());
        return true;
    }

    _normalize(status) {
        if (!status || typeof status !== "object" || Array.isArray(status)
            || !status.profile || typeof status.profile !== "object" || !Array.isArray(status.checks)) return null;
        const profileId = ["NORMAL", "PUBLIC", "LOCKDOWN", "UNKNOWN"].includes(status.profile.id)
            ? status.profile.id : "UNKNOWN";
        const compliance = ["COMPLIANT", "NON_COMPLIANT", "UNKNOWN"].includes(status.profile.compliance)
            ? status.profile.compliance : "UNKNOWN";
        const checks = status.checks.slice(0, 64).map(check => {
            if (!check || typeof check !== "object" || Array.isArray(check)) return null;
            return {
                label: typeof check.label === "string" ? check.label.slice(0, 64) : "UNKNOWN CHECK",
                state: ["SECURE", "PARTIAL", "INSECURE", "UNAVAILABLE", "UNKNOWN", "NOT_APPLICABLE"].includes(check.state)
                    ? check.state : "UNKNOWN",
                actual: typeof check.actual === "string" ? check.actual.slice(0, 96) : "UNKNOWN",
                detail: typeof check.detail === "string" ? check.detail.slice(0, 240) : "NO VERIFIED DETAIL AVAILABLE"
            };
        }).filter(Boolean);
        return {
            profileId,
            compliance,
            systemEnforcementPending: status.profile.systemEnforcementPending === true,
            checks
        };
    }

    _html(status) {
        const escape = value => this.escapeHtml(String(value));
        const rows = status.checks.map(check => `<tr>
            <td>${escape(check.label)}</td>
            <td>${escape(check.actual)}</td>
            <td data-security-state="${escape(check.state)}">${escape(check.state)}</td>
            <td>${escape(check.detail)}</td>
        </tr>`).join("");
        return `<section id="security_hud">
            <header>
                <span>PROFILE ${escape(status.profileId)}</span>
                <span>${escape(status.compliance)}</span>
            </header>
            ${status.systemEnforcementPending ? "<p>SYSTEM-LEVEL ENFORCEMENT PENDING</p>" : ""}
            <div>
                <table>
                    <thead><tr><th>CHECK</th><th>ACTUAL</th><th>STATE</th><th>DETAIL</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </section>`;
    }
}

if (typeof module !== "undefined") module.exports = {SecurityHud};
