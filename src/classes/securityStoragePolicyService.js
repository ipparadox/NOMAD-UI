const fs = require("fs");
const os = require("os");
const path = require("path");
const {spawnSync} = require("child_process");
const {resolveTrustedSecurityTool} = require("./securityFirewallService.js");

const MAX_STORAGE_SOURCE_BYTES = 4 * 1024 * 1024;
const SAFE_UNMOUNT_ROOTS = Object.freeze(["/media", "/mnt", "/run/media"]);

function decodeMountField(value) {
    return String(value || "").replace(/\\(040|011|012|134)/g, sequence => ({
        "\\040": " ", "\\011": "\t", "\\012": "\n", "\\134": "\\"
    }[sequence]));
}

function parseStorageMountInfo(content) {
    if (Buffer.isBuffer(content)) content = content.toString("utf8");
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_STORAGE_SOURCE_BYTES) return null;
    const mounts = [];
    content.split("\n").forEach(line => {
        const separator = line.indexOf(" - ");
        if (separator < 0) return;
        const left = line.slice(0, separator).split(" ");
        const right = line.slice(separator + 3).split(" ");
        if (left.length < 6 || right.length < 3) return;
        mounts.push({
            majorMinor: left[2],
            mountPoint: decodeMountField(left[4]),
            fsType: right[0],
            source: decodeMountField(right[1]),
            mountOptions: left[5].split(",").filter(Boolean)
        });
    });
    return mounts.length ? mounts : null;
}

function normalizeMountpoints(node) {
    const source = Array.isArray(node.mountpoints) ? node.mountpoints
        : (typeof node.mountpoint === "string" ? [node.mountpoint] : []);
    return source.filter(value => typeof value === "string").map(decodeMountField);
}

function parseStorageLsblk(content) {
    if (Buffer.isBuffer(content)) content = content.toString("utf8");
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_STORAGE_SOURCE_BYTES) return null;
    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch (error) {
        return null;
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.blockdevices)) return null;
    const devices = [];
    const visit = (node, inherited) => {
        if (!node || typeof node !== "object" || Array.isArray(node) || devices.length >= 4096) return;
        const type = typeof node.type === "string" ? node.type.toLowerCase() : "unknown";
        const removable = node.rm === true || node.rm === 1 || node.rm === "1";
        const rootRemovable = type === "disk" ? removable : inherited.rootRemovable;
        devices.push({
            name: typeof node.name === "string" ? node.name.slice(0, 128) : "UNKNOWN",
            type,
            majorMinor: typeof node["maj:min"] === "string" ? node["maj:min"].slice(0, 32) : null,
            devicePath: typeof node.path === "string" && node.path.startsWith("/dev/") ? node.path.slice(0, 4096) : null,
            rootRemovable: typeof rootRemovable === "boolean" ? rootRemovable : null,
            mountpoints: normalizeMountpoints(node)
        });
        if (Array.isArray(node.children)) node.children.forEach(child => visit(child, {rootRemovable}));
    };
    parsed.blockdevices.forEach(node => visit(node, {rootRemovable: null}));
    return devices.length ? devices : null;
}

function mountForPath(mounts, candidatePath, pathModule = path) {
    if (!Array.isArray(mounts) || typeof candidatePath !== "string" || !pathModule.isAbsolute(candidatePath)) return null;
    let selected = null;
    mounts.forEach(mount => {
        if (!mount || typeof mount.mountPoint !== "string") return;
        const relative = pathModule.relative(mount.mountPoint, candidatePath);
        if (relative === "" || (!relative.startsWith("..") && !pathModule.isAbsolute(relative))) {
            if (!selected || mount.mountPoint.length > selected.mountPoint.length) selected = mount;
        }
    });
    return selected;
}

function withinRoot(candidate, root, pathModule = path) {
    const relative = pathModule.relative(root, candidate);
    return relative !== "" && !relative.startsWith("..") && !pathModule.isAbsolute(relative);
}

function classifyStorageMounts(mounts, devices, opts = {}) {
    const pathModule = opts.path || path;
    const protectedPaths = Array.isArray(opts.protectedPaths) ? opts.protectedPaths.filter(value => (
        typeof value === "string" && pathModule.isAbsolute(value)
    )) : [];
    const safeRoots = Array.isArray(opts.safeUnmountRoots) && opts.safeUnmountRoots.length
        ? opts.safeUnmountRoots : SAFE_UNMOUNT_ROOTS;
    if (!Array.isArray(mounts) || !Array.isArray(devices)) return {
        state: "UNKNOWN", ambiguous: true, eligible: [], protected: [], refused: [], removable: [], reason: "STORAGE TOPOLOGY UNAVAILABLE"
    };
    const mandatoryPaths = ["/", "/boot", "/boot/efi"]
        .concat(typeof opts.runtimePath === "string" ? [opts.runtimePath] : [])
        .concat(protectedPaths);
    const protectedMounts = new Set();
    let ambiguous = false;
    mandatoryPaths.forEach(candidate => {
        if (!pathModule.isAbsolute(candidate)) {
            ambiguous = true;
            return;
        }
        const mount = mountForPath(mounts, candidate, pathModule);
        if (!mount) ambiguous = true;
        else protectedMounts.add(mount.mountPoint);
    });
    const output = {state: "VERIFIED", ambiguous, eligible: [], protected: [], refused: [], removable: []};
    mounts.forEach(mount => {
        if (!mount || !pathModule.isAbsolute(mount.mountPoint)) return;
        const device = devices.find(item => (item.majorMinor && item.majorMinor === mount.majorMinor)
            || (item.devicePath && item.devicePath === mount.source));
        if (!device || device.rootRemovable === null) {
            if (mount.source && mount.source.startsWith("/dev/")) {
                output.refused.push({mountPoint: mount.mountPoint, reason: "DEVICE IDENTITY AMBIGUOUS"});
                output.ambiguous = true;
            }
            return;
        }
        const record = {
            mountPoint: mount.mountPoint,
            source: mount.source,
            majorMinor: mount.majorMinor,
            fsType: mount.fsType,
            rootRemovable: device.rootRemovable
        };
        if (device.rootRemovable) {
            output.removable.push(record);
            return;
        }
        if (protectedMounts.has(mount.mountPoint)) {
            output.protected.push(Object.assign(record, {reason: "REQUIRED FILESYSTEM"}));
            return;
        }
        if (!safeRoots.some(root => withinRoot(mount.mountPoint, root, pathModule))) {
            output.refused.push(Object.assign(record, {reason: "MOUNT LOCATION NOT ALLOWLISTED"}));
            return;
        }
        output.eligible.push(record);
    });
    if (output.ambiguous) output.state = "AMBIGUOUS";
    return output;
}

function sameMountIdentity(left, right) {
    return Boolean(left && right && left.mountPoint === right.mountPoint && left.source === right.source
        && left.majorMinor === right.majorMinor && left.fsType === right.fsType
        && left.rootRemovable === false && right.rootRemovable === false);
}

function verifyUnmountCandidate(candidate, freshInventory) {
    if (!candidate || !freshInventory || freshInventory.ambiguous) return false;
    const current = freshInventory.eligible.find(item => item.mountPoint === candidate.mountPoint);
    return sameMountIdentity(candidate, current);
}

function sanitizeStoragePlan(inventory, verbose = false) {
    const result = {
        state: ["VERIFIED", "AMBIGUOUS", "UNKNOWN"].includes(inventory && inventory.state)
            ? inventory.state : "UNKNOWN",
        ambiguous: Boolean(inventory && inventory.ambiguous),
        eligibleCount: Array.isArray(inventory && inventory.eligible) ? inventory.eligible.length : 0,
        protectedCount: Array.isArray(inventory && inventory.protected) ? inventory.protected.length : 0,
        refusedCount: Array.isArray(inventory && inventory.refused) ? inventory.refused.length : 0,
        removableCount: Array.isArray(inventory && inventory.removable) ? inventory.removable.length : 0,
        manualRemountPreventionVerified: false
    };
    if (verbose) result.eligibleMounts = (inventory && inventory.eligible || []).map(item => item.mountPoint).slice(0, 64);
    return result;
}

class AutomountPolicyController {
    constructor(opts = {}) {
        this.environment = opts.env || process.env;
        this.spawnSync = opts.spawnSync || spawnSync;
        this.runner = typeof opts.runner === "function" ? opts.runner : null;
        this.resolveExecutable = opts.resolveExecutable || (command => resolveTrustedSecurityTool(command, opts));
    }

    observe() {
        const result = this._run(["get", "org.gnome.desktop.media-handling", "automount"]);
        if (!result) return {available: false, value: null, state: "UNAVAILABLE"};
        const value = String(result.stdout || "").trim().toLowerCase();
        if (result.status !== 0 || !["true", "false"].includes(value)) return {
            available: true, value: null, state: "UNKNOWN"
        };
        return {available: true, value, state: value === "false" ? "DISABLED" : "ENABLED"};
    }

    disable() {
        const before = this.observe();
        if (!before.available || before.value === null) return {ok: false, changed: false, previous: null, status: before.state};
        if (before.value === "false") return {ok: true, changed: false, previous: "false", status: "ALREADY_DISABLED"};
        const result = this._run(["set", "org.gnome.desktop.media-handling", "automount", "false"]);
        const after = this.observe();
        return {
            ok: Boolean(result && result.status === 0 && after.value === "false"),
            changed: Boolean(result && result.status === 0 && after.value === "false"),
            previous: "true",
            status: after.value === "false" ? "DISABLED" : "VERIFICATION_FAILED"
        };
    }

    restore(record) {
        const nomadOwnedOrPending = record && (record.changed === true || record.owned === true || record.pending === true);
        if (!nomadOwnedOrPending || !["true", "false"].includes(record.previous)) {
            return {ok: true, changed: false, status: "NOT_OWNED"};
        }
        const current = this.observe();
        if (!current.available || current.value === null) return {ok: false, changed: false, status: "UNAVAILABLE"};
        if (current.value === record.previous) return {ok: true, changed: false, status: "ALREADY_RESTORED"};
        if (current.value !== "false") return {ok: false, changed: false, status: "STATE_CHANGED_EXTERNALLY"};
        const result = this._run(["set", "org.gnome.desktop.media-handling", "automount", record.previous]);
        const after = this.observe();
        return {
            ok: Boolean(result && result.status === 0 && after.value === record.previous),
            changed: Boolean(result && result.status === 0 && after.value === record.previous),
            status: after.value === record.previous ? "RESTORED" : "VERIFICATION_FAILED"
        };
    }

    _run(args) {
        if (!Array.isArray(args) || args.some(argument => typeof argument !== "string" || argument.includes("\0"))) return null;
        if (this.runner) {
            const result = this.runner("gsettings", args.slice(), {shell: false, timeout: 3000});
            return result && typeof result === "object" ? result : null;
        }
        const executable = this.resolveExecutable("gsettings");
        if (!executable) return null;
        try {
            return this.spawnSync(executable, args, {
                encoding: "utf8",
                env: {
                    PATH: this.environment.PATH || "/usr/local/bin:/usr/bin:/bin",
                    HOME: this.environment.HOME || os.homedir(),
                    DBUS_SESSION_BUS_ADDRESS: this.environment.DBUS_SESSION_BUS_ADDRESS || "",
                    XDG_RUNTIME_DIR: this.environment.XDG_RUNTIME_DIR || ""
                },
                shell: false,
                timeout: 3000,
                windowsHide: true
            });
        } catch (error) {
            return {status: null, stdout: "", stderr: ""};
        }
    }
}

class SecurityStoragePolicyService {
    constructor(opts = {}) {
        this.fs = opts.fs || fs;
        this.path = opts.path || path;
        this.environment = opts.env || process.env;
        this.home = opts.home || os.homedir();
        this.sources = opts.sources || {};
        this.spawnSync = opts.spawnSync || spawnSync;
        this.runner = typeof opts.runner === "function" ? opts.runner : null;
        this.resolveExecutable = opts.resolveExecutable || (command => resolveTrustedSecurityTool(command, opts));
        this.protectedPaths = Array.isArray(opts.protectedPaths) ? opts.protectedPaths.slice() : [];
        this.safeUnmountRoots = opts.safeUnmountRoots || SAFE_UNMOUNT_ROOTS;
    }

    inspect(verbose = false) {
        const mounts = parseStorageMountInfo(this._source("mountInfo", "/proc/self/mountinfo"));
        const devices = parseStorageLsblk(this._lsblk());
        const inventory = classifyStorageMounts(mounts, devices, {
            path: this.path,
            protectedPaths: this.protectedPaths,
            runtimePath: this.environment.XDG_RUNTIME_DIR,
            safeUnmountRoots: this.safeUnmountRoots
        });
        return Object.assign({inventory}, sanitizeStoragePlan(inventory, verbose));
    }

    _source(id, filename) {
        if (Object.prototype.hasOwnProperty.call(this.sources, id)) return this.sources[id];
        try {
            const stats = this.fs.lstatSync(filename);
            return stats.isFile() && stats.size <= MAX_STORAGE_SOURCE_BYTES ? this.fs.readFileSync(filename) : null;
        } catch (error) {
            return null;
        }
    }

    _lsblk() {
        if (Object.prototype.hasOwnProperty.call(this.sources, "lsblk")) return this.sources.lsblk;
        let result = null;
        if (this.runner) result = this.runner("lsblk", [
            "--json", "--bytes", "--output", "NAME,PATH,MAJ:MIN,TYPE,RM,MOUNTPOINTS,FSTYPE"
        ], {shell: false, timeout: 3000});
        else {
            const executable = this.resolveExecutable("lsblk");
            if (!executable) return null;
            result = this.spawnSync(executable, [
                "--json", "--bytes", "--output", "NAME,PATH,MAJ:MIN,TYPE,RM,MOUNTPOINTS,FSTYPE"
            ], {
                encoding: "utf8",
                env: {PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C"},
                shell: false,
                timeout: 3000,
                windowsHide: true
            });
        }
        return result && result.status === 0 ? result.stdout : null;
    }
}

module.exports = {
    AutomountPolicyController,
    SAFE_UNMOUNT_ROOTS,
    SecurityStoragePolicyService,
    classifyStorageMounts,
    mountForPath,
    parseStorageLsblk,
    parseStorageMountInfo,
    sameMountIdentity,
    sanitizeStoragePlan,
    verifyUnmountCandidate,
    withinRoot
};
