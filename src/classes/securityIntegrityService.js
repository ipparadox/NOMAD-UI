const fs = require("fs");
const os = require("os");
const path = require("path");

function defaultIntegrityResources(appRoot, pathModule = path) {
    return [
        ["boot", "MAIN PROCESS", "src/_boot.js", false],
        ["preload", "PRELOAD BRIDGE", "src/preload.js", false],
        ["security_service", "SECURITY SERVICE", "src/classes/securityService.js", false],
        ["enforcement_service", "ENFORCEMENT SERVICE", "src/classes/securityEnforcementService.js", false],
        ["environment_service", "ENVIRONMENT SERVICE", "src/classes/securityEnvironmentService.js", false],
        ["firewall_service", "FIREWALL SERVICE", "src/classes/securityFirewallService.js", false],
        ["storage_service", "STORAGE SERVICE", "src/classes/securityStoragePolicyService.js", false],
        ["path_policy_service", "PATH POLICY SERVICE", "src/classes/securityPathPolicyService.js", false],
        ["permission_service", "PERMISSION SERVICE", "src/classes/securityPermissionsService.js", false],
        ["integrity_service", "INTEGRITY SERVICE", "src/classes/securityIntegrityService.js", false],
        ["application_policy_service", "APPLICATION POLICY SERVICE", "src/classes/applicationPolicyService.js", false],
        ["profile_service", "PROFILE SERVICE", "src/classes/securityProfileService.js", false],
        ["security_cli_service", "SECURITY CLI SERVICE", "src/cli/securityCliService.js", false],
        ["cli", "NOMAD CLI", "bin/nomad", true],
        ["session_launcher", "SESSION LAUNCHER", "session/nomad-session", true],
        ["session_installer", "SESSION INSTALLER", "scripts/install-nomad-session.sh", true],
        ["helper_installer", "SECURITY HELPER INSTALLER", "scripts/install-nomad-security-helper.sh", true],
        ["security_helper", "SECURITY HELPER SOURCE", "src/security-helper/nomad-security-helper.js", true],
        ["package_manifest", "PACKAGE MANIFEST", "package.json", false],
        ["package_lock", "PACKAGE LOCK", "package-lock.json", false],
        ["renderer_manifest", "RENDERER PACKAGE MANIFEST", "src/package.json", false],
        ["renderer_lock", "RENDERER PACKAGE LOCK", "src/package-lock.json", false]
    ].map(([id, label, relativePath, executable]) => ({
        id, label, path: pathModule.join(appRoot, relativePath), executable
    }));
}

class SecurityIntegrityService {
    constructor(opts = {}) {
        this.fs = opts.fs || fs;
        this.path = opts.path || path;
        this.home = opts.home || os.homedir();
        this.uid = Object.prototype.hasOwnProperty.call(opts, "uid")
            ? opts.uid : (typeof process.getuid === "function" ? process.getuid() : null);
        this.appRoot = this.path.resolve(opts.appRoot || this.path.join(__dirname, "..", ".."));
        this.resources = opts.resources || defaultIntegrityResources(this.appRoot, this.path);
    }

    audit() {
        const resources = this.resources.map(resource => this._auditResource(resource));
        const insecure = resources.filter(resource => resource.state === "INSECURE").length;
        const unknown = resources.filter(resource => resource.state === "UNKNOWN").length;
        const state = insecure ? "INSECURE" : (unknown ? "UNKNOWN" : "PARTIAL");
        return {
            state,
            actual: insecure ? "METADATA_FINDINGS" : (unknown ? "NOT_VERIFIED" : "USER_WRITABLE_TRUST_BASE"),
            detail: insecure
                ? `${insecure} TRUSTED RESOURCE METADATA FINDING(S)`
                : (unknown ? `${unknown} TRUSTED RESOURCE(S) COULD NOT BE VERIFIED`
                    : "OWNER, TYPE, LINKS, AND MODES VERIFIED; USER-WRITABLE CODE HAS NO TAMPER-PROOF ROOT OF TRUST"),
            threatModel: "METADATA CHECKS DETECT ACCIDENTAL OR LOWER-PRIVILEGE CHANGES; A SAME-USER ATTACKER CAN MODIFY CODE AND ANY USER-WRITABLE BASELINE",
            resources
        };
    }

    _auditResource(resource) {
        const output = {id: resource.id, label: resource.label, state: "UNKNOWN", detail: "NOT INSPECTED"};
        const relative = this.path.relative(this.appRoot, resource.path);
        if (!relative || relative.startsWith("..") || this.path.isAbsolute(relative)) {
            output.state = "INSECURE";
            output.detail = "RESOURCE PATH IS OUTSIDE THE TRUSTED APPLICATION ROOT";
            return output;
        }
        let stats;
        try {
            stats = this.fs.lstatSync(resource.path);
            if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1
                || this.fs.realpathSync(resource.path) !== this.path.resolve(resource.path)) {
                output.state = "INSECURE";
                output.detail = "RESOURCE TYPE, SYMLINK, HARDLINK, OR CANONICAL PATH CHECK FAILED";
                return output;
            }
            if (this.uid !== null && typeof stats.uid === "number" && stats.uid !== this.uid && stats.uid !== 0) {
                output.state = "INSECURE";
                output.detail = "RESOURCE OWNER IS NOT THE CURRENT USER OR ROOT";
                return output;
            }
            if ((stats.mode & 0o022) !== 0 || (resource.executable && (stats.mode & 0o111) === 0)) {
                output.state = "INSECURE";
                output.detail = "RESOURCE MODE IS WRITABLE BY GROUP/OTHER OR REQUIRED EXECUTE BITS ARE ABSENT";
                return output;
            }
            let parentPath = this.path.dirname(resource.path);
            while (true) {
                const parent = this.fs.lstatSync(parentPath);
                if (parent.isSymbolicLink() || !parent.isDirectory() || (parent.mode & 0o022) !== 0
                    || (this.uid !== null && typeof parent.uid === "number" && parent.uid !== this.uid && parent.uid !== 0)
                    || this.fs.realpathSync(parentPath) !== this.path.resolve(parentPath)) {
                    output.state = "INSECURE";
                    output.detail = "RESOURCE PARENT DIRECTORY CHAIN IS UNSAFE";
                    return output;
                }
                if (parentPath === this.appRoot) break;
                const next = this.path.dirname(parentPath);
                if (next === parentPath || this.path.relative(this.appRoot, next).startsWith("..")) {
                    output.state = "INSECURE";
                    output.detail = "RESOURCE PARENT DIRECTORY CHAIN ESCAPED THE APPLICATION ROOT";
                    return output;
                }
                parentPath = next;
            }
            output.state = "PARTIAL";
            output.detail = "METADATA VERIFIED; APPLICATION SOURCE REMAINS USER-WRITABLE";
            return output;
        } catch (error) {
            output.state = error && error.code === "ENOENT" ? "UNKNOWN" : "UNKNOWN";
            output.detail = "TRUSTED RESOURCE COULD NOT BE VERIFIED";
            return output;
        }
    }
}

module.exports = {SecurityIntegrityService, defaultIntegrityResources};
