#!/usr/bin/node

"use strict";

const fs = require("fs");
const path = require("path");
const {spawnSync} = require("child_process");

const OPERATIONS = new Set([
    "apply-public", "apply-lockdown", "restore", "verify-firewall", "verify-storage", "status"
]);
const TABLE = "nomad_security";
const MARKER = "NOMAD-UI MANAGED FIREWALL - DO NOT EDIT";
const CONFIG_PATH = "/etc/nomad-security/policy.json";
const STATE_DIRECTORY = "/var/lib/nomad-security";
const STATE_PATH = `${STATE_DIRECTORY}/state.json`;
const MAX_BYTES = 4 * 1024 * 1024;
const SAFE_TOOL_PATHS = Object.freeze({
    nft: ["/usr/sbin/nft", "/usr/bin/nft", "/sbin/nft"],
    lsblk: ["/usr/bin/lsblk", "/bin/lsblk"],
    umount: ["/usr/bin/umount", "/bin/umount"],
    mount: ["/usr/bin/mount", "/bin/mount"]
});
const ESSENTIAL_ICMPV6 = "destination-unreachable, packet-too-big, time-exceeded, parameter-problem, nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert";

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function renderRules(profile) {
    if (!["PUBLIC", "LOCKDOWN"].includes(profile)) return null;
    const output = profile === "LOCKDOWN" ? `
        chain output {
            type filter hook output priority 0; policy drop;
            oifname "lo" accept
            ct state established,related accept
            ip protocol udp udp sport 68 udp dport 67 accept
            ip6 nexthdr udp udp sport 546 udp dport 547 accept
            udp dport { 53, 123 } accept
            tcp dport { 53, 80, 443 } accept
            ip protocol icmp icmp type { destination-unreachable, time-exceeded, parameter-problem } accept
            meta nfproto ipv6 icmpv6 type { ${ESSENTIAL_ICMPV6} } accept
        }` : `
        chain output {
            type filter hook output priority 0; policy accept;
        }`;
    return `table inet ${TABLE} {
        comment "${MARKER}; NOMAD-UI PROFILE ${profile}"
        chain input {
            type filter hook input priority 0; policy drop;
            iifname "lo" accept
            ct state established,related accept
            ip protocol udp udp sport 67 udp dport 68 accept
            ip6 nexthdr udp udp sport 547 udp dport 546 accept
            ip protocol icmp icmp type { destination-unreachable, time-exceeded, parameter-problem } accept
            meta nfproto ipv6 icmpv6 type { ${ESSENTIAL_ICMPV6} } accept
        }${output}
    }
`;
}

function extractChain(content, name) {
    if (typeof content !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(name || "")) return null;
    const match = new RegExp(`\\bchain\\s+${name}\\s*\\{`, "i").exec(content);
    if (!match) return null;
    const opening = content.indexOf("{", match.index);
    let depth = 0;
    for (let index = opening; index < content.length; index++) {
        if (content[index] === "{") depth++;
        else if (content[index] === "}") {
            depth--;
            if (depth === 0) return content.slice(opening + 1, index);
            if (depth < 0) return null;
        }
    }
    return null;
}

function acceptCount(chain) {
    return typeof chain === "string" ? (chain.match(/\baccept\b/gi) || []).length : 0;
}

function verifyRules(content, profile) {
    if (typeof content !== "string" || !["PUBLIC", "LOCKDOWN"].includes(profile)) return false;
    const normalized = content.replace(/\s+/g, " ");
    const input = extractChain(content, "input");
    const output = extractChain(content, "output");
    return normalized.includes(MARKER) && normalized.includes(`NOMAD-UI PROFILE ${profile}`)
        && new RegExp(`table\\s+inet\\s+${TABLE}\\b`).test(normalized)
        && (normalized.match(/\bchain\s+[a-z][a-z0-9_]*\s*\{/gi) || []).length === 2
        && input && /hook\s+input\b.*?policy\s+drop/i.test(input)
        && /iifname\s+"lo"\s+accept/i.test(input)
        && /ct\s+state\s+established,related\s+accept/i.test(input)
        && /ip\s+protocol\s+udp.*?sport\s+67.*?dport\s+68.*?accept/i.test(input)
        && /ip6\s+nexthdr\s+udp.*?sport\s+547.*?dport\s+546.*?accept/i.test(input)
        && /ip\s+protocol\s+icmp.*?accept/i.test(input)
        && /nfproto\s+ipv6\s+icmpv6.*?accept/i.test(input)
        && acceptCount(input) === 6
        && (profile === "PUBLIC" ? output && /hook\s+output\b.*?policy\s+accept/i.test(output)
                && acceptCount(output) === 1
            : output && /hook\s+output\b.*?policy\s+drop/i.test(output)
                && /oifname\s+"lo"\s+accept/i.test(output)
                && /ct\s+state\s+established,related\s+accept/i.test(output)
                && /ip\s+protocol\s+udp.*?sport\s+68.*?dport\s+67.*?accept/i.test(output)
                && /ip6\s+nexthdr\s+udp.*?sport\s+546.*?dport\s+547.*?accept/i.test(output)
                && /udp\s+dport\s+\{\s*53,\s*123\s*\}.*?accept/i.test(output)
                && /tcp\s+dport\s+\{\s*53,\s*80,\s*443\s*\}.*?accept/i.test(output)
                && /ip\s+protocol\s+icmp.*?accept/i.test(output)
                && /nfproto\s+ipv6\s+icmpv6.*?accept/i.test(output)
                && acceptCount(output) === 8);
}

function decodeMountField(value) {
    return String(value || "").replace(/\\(040|011|012|134)/g, sequence => ({
        "\\040": " ", "\\011": "\t", "\\012": "\n", "\\134": "\\"
    }[sequence]));
}

function parseMountInfo(content) {
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_BYTES) return null;
    const mounts = [];
    content.split("\n").forEach(line => {
        const separator = line.indexOf(" - ");
        if (separator < 0) return;
        const left = line.slice(0, separator).split(" ");
        const right = line.slice(separator + 3).split(" ");
        if (left.length < 6 || right.length < 3) return;
        mounts.push({
            majorMinor: left[2], mountPoint: decodeMountField(left[4]),
            source: decodeMountField(right[1]), fsType: right[0],
            mountOptions: left[5].split(",").filter(Boolean).slice(0, 64),
            superOptions: right[2].split(",").filter(Boolean).slice(0, 64)
        });
    });
    return mounts.length ? mounts : null;
}

function parseLsblk(content) {
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_BYTES) return null;
    let parsed;
    try { parsed = JSON.parse(content); } catch (error) { return null; }
    if (!isPlainObject(parsed) || !Array.isArray(parsed.blockdevices)) return null;
    const devices = [];
    const visit = (node, rootRemovable) => {
        if (!isPlainObject(node) || devices.length >= 4096) return;
        const type = typeof node.type === "string" ? node.type.toLowerCase() : "unknown";
        const removable = node.rm === true || node.rm === 1 || node.rm === "1";
        const inherited = type === "disk" ? removable : rootRemovable;
        devices.push({
            majorMinor: typeof node["maj:min"] === "string" ? node["maj:min"] : null,
            devicePath: typeof node.path === "string" && node.path.startsWith("/dev/") ? node.path : null,
            rootRemovable: typeof inherited === "boolean" ? inherited : null
        });
        if (Array.isArray(node.children)) node.children.forEach(child => visit(child, inherited));
    };
    parsed.blockdevices.forEach(node => visit(node, null));
    return devices.length ? devices : null;
}

function mountForPath(mounts, candidate) {
    let selected = null;
    (mounts || []).forEach(mount => {
        const relative = path.relative(mount.mountPoint, candidate);
        if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
            if (!selected || mount.mountPoint.length > selected.mountPoint.length) selected = mount;
        }
    });
    return selected;
}

function withinRoot(candidate, root) {
    const relative = path.relative(root, candidate);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function classifyMounts(mounts, devices, config) {
    if (!Array.isArray(mounts) || !Array.isArray(devices) || !config) return {
        available: false, ambiguous: false, eligible: [], protected: [], reason: "STORAGE CONFIGURATION UNAVAILABLE"
    };
    const required = ["/", "/boot", "/boot/efi", config.nomadRoot]
        .concat(config.repositoryRoots, config.persistentPaths);
    const protectedMounts = new Set();
    let ambiguous = false;
    required.forEach(candidate => {
        const mount = mountForPath(mounts, candidate);
        if (!mount) ambiguous = true;
        else protectedMounts.add(mount.mountPoint);
    });
    const output = {available: true, ambiguous, eligible: [], protected: [], refused: []};
    mounts.forEach(mount => {
        const device = devices.find(item => (item.majorMinor && item.majorMinor === mount.majorMinor)
            || (item.devicePath && item.devicePath === mount.source));
        if (!device || device.rootRemovable === null) {
            if (mount.source.startsWith("/dev/")) {
                output.ambiguous = true;
                output.refused.push({mountPoint: mount.mountPoint, reason: "AMBIGUOUS"});
            }
            return;
        }
        if (device.rootRemovable || !mount.mountPoint.startsWith("/")) return;
        const record = {
            mountPoint: mount.mountPoint,
            source: mount.source,
            majorMinor: mount.majorMinor,
            fsType: mount.fsType,
            mountOptions: Array.isArray(mount.mountOptions) ? mount.mountOptions.slice() : [],
            superOptions: Array.isArray(mount.superOptions) ? mount.superOptions.slice() : [],
            rootRemovable: false
        };
        if (protectedMounts.has(mount.mountPoint)) output.protected.push(record);
        else if (config.allowedUnmountRoots.some(root => withinRoot(mount.mountPoint, root))) output.eligible.push(record);
        else output.refused.push(Object.assign(record, {reason: "LOCATION_REFUSED"}));
    });
    return output;
}

function sameIdentity(left, right) {
    return Boolean(left && right && left.mountPoint === right.mountPoint && left.source === right.source
        && left.majorMinor === right.majorMinor && left.fsType === right.fsType
        && JSON.stringify(left.mountOptions || []) === JSON.stringify(right.mountOptions || [])
        && JSON.stringify(left.superOptions || []) === JSON.stringify(right.superOptions || [])
        && left.rootRemovable === false && right.rootRemovable === false);
}

class HelperRuntime {
    constructor(opts = {}) {
        this.fs = opts.fs || fs;
        this.spawnSync = opts.spawnSync || spawnSync;
        this.uid = Object.prototype.hasOwnProperty.call(opts, "uid") ? opts.uid
            : (typeof process.getuid === "function" ? process.getuid() : null);
        this.configPath = opts.configPath || CONFIG_PATH;
        this.stateDirectory = opts.stateDirectory || STATE_DIRECTORY;
        this.statePath = opts.statePath || STATE_PATH;
        this.tools = Object.assign({}, SAFE_TOOL_PATHS, opts.tools || {});
    }

    execute(operation) {
        if (!OPERATIONS.has(operation)) return this._result(false, "INVALID OPERATION");
        if (this.uid !== 0) return this._result(false, "ROOT EXECUTION REQUIRED");
        try {
            if (operation === "apply-public") return this._apply("PUBLIC");
            if (operation === "apply-lockdown") return this._apply("LOCKDOWN");
            if (operation === "restore") return this._restore();
            if (operation === "verify-firewall") return this._verifyFirewall();
            if (operation === "verify-storage") return this._verifyStorage();
            return this._status();
        } catch (error) {
            return this._result(false, "HELPER STATE OR CONFIGURATION REFUSED");
        }
    }

    _apply(profile) {
        const config = this._readConfig();
        const storage = this._storageInventory(config);
        if (!storage.available || storage.ambiguous) return this._result(false,
            "STORAGE OBSERVATION UNAVAILABLE OR AMBIGUOUS - NO CHANGES APPLIED", profile,
            "NOT_APPLIED", "FAILED");
        const currentFirewall = this._currentFirewall();
        if (!currentFirewall.available || currentFirewall.ambiguous) {
            return this._result(false, "NFTABLES OBSERVATION AMBIGUOUS - NO CHANGES APPLIED", profile,
                "NOT_APPLIED", "NOT_APPLIED");
        }
        if (currentFirewall.present && !currentFirewall.owned) {
            return this._result(false, "NFTABLES TABLE NAME COLLISION - NO CHANGES APPLIED", profile, "FAILED", "NOT_APPLIED");
        }
        const previousState = this._readState();
        if (previousState && (previousState.phase !== "APPLIED" || !currentFirewall.owned
            || currentFirewall.profile !== previousState.profile)) {
            return this._result(false, "EXISTING NOMAD HELPER STATE REQUIRES RESTORE", profile, "FAILED", "FAILED");
        }
        const previousProfile = currentFirewall.profile;
        const unmounted = [];
        const state = previousState ? {
            version: 3,
            profile,
            originalFirewallProfile: previousState.originalFirewallProfile,
            previousFirewallProfile: currentFirewall.profile,
            phase: "APPLYING",
            mounts: previousState.mounts.slice(),
            pendingMount: null
        } : {
            version: 3,
            profile,
            originalFirewallProfile: currentFirewall.owned ? currentFirewall.profile : null,
            previousFirewallProfile: currentFirewall.owned ? currentFirewall.profile : null,
            phase: "APPLYING",
            mounts: [],
            pendingMount: null
        };
        try {
            this._writeState(state);
            const firewall = this._applyFirewall(profile, currentFirewall.present);
            if (!firewall.ok) throw new Error(firewall.status);
            for (const candidate of storage.eligible) {
                state.pendingMount = candidate;
                this._writeState(state);
                const fresh = this._storageInventory(config);
                const verified = fresh.eligible.find(item => item.mountPoint === candidate.mountPoint);
                if (fresh.ambiguous || !sameIdentity(candidate, verified)) throw new Error("MOUNT IDENTITY CHANGED");
                const result = this._runTool("umount", ["--", candidate.mountPoint]);
                if (!result || result.status !== 0) throw new Error("ELIGIBLE MOUNT COULD NOT BE UNMOUNTED");
                unmounted.push(candidate);
                state.mounts = state.mounts.concat(candidate).filter((entry, index, all) => (
                    all.findIndex(item => item.mountPoint === entry.mountPoint) === index
                ));
                state.pendingMount = null;
                this._writeState(state);
            }
            const verified = this._verifyFirewall(profile);
            if (!verified.ok) throw new Error("FIREWALL VERIFICATION FAILED");
            state.phase = "APPLIED";
            this._writeState(state);
        } catch (error) {
            const rollbackMounts = state.pendingMount ? unmounted.concat(state.pendingMount) : unmounted;
            const mountsRestored = this._restoreMounts(rollbackMounts);
            const firewallRestored = this._restoreFirewallProfile(previousProfile);
            let stateRestored = true;
            try {
                if (previousState) this._writeState(previousState);
                else this._clearStateIfPresent();
            } catch (stateError) {
                stateRestored = false;
            }
            return this._result(false, mountsRestored && firewallRestored && stateRestored
                ? "APPLY FAILED - HELPER CHANGES ROLLED BACK"
                : "APPLY FAILED - HELPER ROLLBACK PARTIAL", profile, "FAILED", "FAILED");
        }
        return this._result(true, "NOMAD SYSTEM POLICY APPLIED PARTIALLY",
            profile, "VERIFIED", "PARTIAL");
    }

    _restore() {
        const state = this._readState();
        const current = this._currentFirewall();
        if (!current.available || current.ambiguous || (current.present && !current.owned)) {
            return this._result(false, "NOMAD FIREWALL OWNERSHIP COULD NOT BE VERIFIED");
        }
        if (!state) {
            if (current.present) return this._result(false, "UNJOURNALED NOMAD FIREWALL RESTORE REFUSED");
            return this._result(true, "NO NOMAD-OWNED SYSTEM POLICY RECORDED", "NONE", "NOT_APPLIED", "NOT_APPLIED");
        }
        const acceptedProfiles = state.phase === "APPLYING"
            ? [state.profile, state.previousFirewallProfile, state.originalFirewallProfile]
            : [state.profile, state.originalFirewallProfile];
        if (current.present && !acceptedProfiles.includes(current.profile)) {
            return this._result(false, "NOMAD FIREWALL STATE CHANGED EXTERNALLY");
        }
        const restoreRecords = state.pendingMount ? state.mounts.concat(state.pendingMount) : state.mounts;
        if (!this._restoreMounts(restoreRecords)) {
            return this._result(false, "MOUNT RESTORE PARTIAL", "NONE", "NOT_APPLIED", "FAILED");
        }
        if (!this._restoreFirewallProfile(state.originalFirewallProfile)) {
            return this._result(false, "NOMAD FIREWALL RESTORE FAILED");
        }
        this._clearState();
        return this._result(true, "NOMAD-OWNED SYSTEM POLICY RESTORED", "NONE", "NOT_APPLIED", "NOT_APPLIED");
    }

    _status() {
        const firewall = this._currentFirewall();
        const state = this._readState();
        if (!firewall.available || firewall.ambiguous) return this._result(false, "NFTABLES STATUS AMBIGUOUS");
        if (!state) {
            const clean = !firewall.present;
            return this._result(clean, clean ? "NOMAD POLICY NOT APPLIED" : "UNJOURNALED NOMAD FIREWALL PRESENT",
                firewall.profile || "NONE", clean ? "NOT_APPLIED" : "FAILED", "NOT_APPLIED");
        }
        if (state.phase !== "APPLIED" || !firewall.owned || firewall.profile !== state.profile) {
            return this._result(false, "NOMAD POLICY JOURNAL IS INCOMPLETE OR INCONSISTENT",
                state.profile, "FAILED", "FAILED");
        }
        const firewallVerification = this._verifyFirewall(state.profile);
        if (!firewallVerification.ok) return this._result(false, firewallVerification.status,
            state.profile, "FAILED", "NOT_APPLIED");
        const storageVerification = this._verifyStorage();
        if (!storageVerification.ok) return this._result(false, storageVerification.status,
            state.profile, "VERIFIED", "FAILED");
        return this._result(true, "NOMAD SYSTEM POLICY VERIFIED PARTIALLY",
            state.profile, "VERIFIED", storageVerification.storage);
    }

    _verifyFirewall(profile) {
        const current = this._currentFirewall();
        const expected = profile || current.profile;
        const ok = Boolean(current.owned && expected && current.profile === expected && verifyRules(current.content, expected));
        return this._result(ok, ok ? "NOMAD FIREWALL VERIFIED" : "NOMAD FIREWALL VERIFICATION FAILED",
            expected || "NONE", ok ? "VERIFIED" : "FAILED", "NOT_APPLIED");
    }

    _verifyStorage() {
        const state = this._readState();
        if (!state) return this._result(true, "NO NOMAD STORAGE CHANGES RECORDED", "NONE", "NOT_APPLIED", "NOT_APPLIED");
        const mounts = parseMountInfo(this._readSystemFile("/proc/self/mountinfo")) || [];
        const records = state.pendingMount ? state.mounts.concat(state.pendingMount) : state.mounts;
        const remounted = records.some(record => mounts.some(mount => mount.mountPoint === record.mountPoint));
        return this._result(!remounted, remounted ? "A NOMAD-UNMOUNTED FILESYSTEM IS MOUNTED AGAIN" : "RECORDED UNMOUNTS REMAIN ABSENT",
            state.profile, "NOT_APPLIED", remounted ? "FAILED" : "PARTIAL");
    }

    _applyFirewall(profile, existing) {
        const nft = this._tool("nft");
        if (!nft) return {ok: false, status: "NFTABLES UNAVAILABLE"};
        const rules = renderRules(profile);
        const batch = `${existing ? `delete table inet ${TABLE}\n` : ""}${rules}`;
        const checked = this._run(nft, ["-c", "-f", "-"], batch);
        if (!checked || checked.status !== 0) return {ok: false, status: "NFTABLES PREFLIGHT FAILED"};
        const applied = this._run(nft, ["-f", "-"], batch);
        return {ok: Boolean(applied && applied.status === 0), status: applied && applied.status === 0 ? "APPLIED" : "NFTABLES APPLY FAILED"};
    }

    _restoreFirewallProfile(profile) {
        const current = this._currentFirewall();
        const nft = this._tool("nft");
        if (!nft || !current.available || current.ambiguous || (current.present && !current.owned)) return false;
        const batch = profile ? `${current.present ? `delete table inet ${TABLE}\n` : ""}${renderRules(profile)}`
            : (current.present ? `delete table inet ${TABLE}\n` : "");
        if (!batch) return true;
        const checked = this._run(nft, ["-c", "-f", "-"], batch);
        if (!checked || checked.status !== 0) return false;
        const result = this._run(nft, ["-f", "-"], batch);
        if (!result || result.status !== 0) return false;
        const after = this._currentFirewall();
        return profile ? after.owned && after.profile === profile : after.available && !after.present;
    }

    _currentFirewall() {
        const nft = this._tool("nft");
        if (!nft) return {available: false, ambiguous: false, present: false, owned: false, profile: null, content: ""};
        const tables = this._run(nft, ["list", "tables"]);
        if (!tables || tables.status !== 0) {
            return {available: true, ambiguous: true, present: false, owned: false, profile: null, content: ""};
        }
        const present = String(tables.stdout || "").split(/\r?\n/)
            .some(line => new RegExp(`^\\s*table\\s+inet\\s+${TABLE}\\s*$`).test(line));
        if (!present) return {available: true, ambiguous: false, present: false, owned: false, profile: null, content: ""};
        const result = this._run(nft, ["list", "table", "inet", TABLE]);
        if (!result || result.status !== 0) {
            return {available: true, ambiguous: true, present: true, owned: false, profile: null, content: ""};
        }
        const content = String(result.stdout || "");
        const profile = content.includes("NOMAD-UI PROFILE PUBLIC") ? "PUBLIC"
            : (content.includes("NOMAD-UI PROFILE LOCKDOWN") ? "LOCKDOWN" : null);
        const owned = content.includes(MARKER) && Boolean(profile) && verifyRules(content, profile);
        return {available: true, ambiguous: false, present: true, owned, profile, content};
    }

    _storageInventory(config) {
        const mountInfo = parseMountInfo(this._readSystemFile("/proc/self/mountinfo"));
        const lsblk = this._runTool("lsblk", [
            "--json", "--bytes", "--output", "NAME,PATH,MAJ:MIN,TYPE,RM,MOUNTPOINTS,FSTYPE"
        ]);
        const devices = lsblk && lsblk.status === 0 ? parseLsblk(String(lsblk.stdout || "")) : null;
        return classifyMounts(mountInfo, devices, config);
    }

    _restoreMounts(records) {
        let ok = true;
        const unique = (records || []).filter((record, index, all) => record
            && all.findIndex(candidate => candidate && candidate.mountPoint === record.mountPoint) === index);
        unique.slice().reverse().forEach(record => {
            if (!record || typeof record.mountPoint !== "string" || typeof record.source !== "string"
                || !["/media", "/mnt", "/run/media"].some(root => withinRoot(record.mountPoint, root))
                || !record.source.startsWith("/dev/")) {
                ok = false;
                return;
            }
            const current = parseMountInfo(this._readSystemFile("/proc/self/mountinfo")) || [];
            const currentMount = current.find(mount => mount.mountPoint === record.mountPoint);
            if (currentMount) {
                if (currentMount.source !== record.source || currentMount.majorMinor !== record.majorMinor
                    || currentMount.fsType !== record.fsType
                    || JSON.stringify(currentMount.mountOptions || []) !== JSON.stringify(record.mountOptions || [])
                    || JSON.stringify(currentMount.superOptions || []) !== JSON.stringify(record.superOptions || [])) ok = false;
                return;
            }
            if (!this._deviceIdentityCurrent(record)) { ok = false; return; }
            let targetStats;
            try { targetStats = this.fs.lstatSync(record.mountPoint); } catch (error) { ok = false; return; }
            if (targetStats.isSymbolicLink() || !targetStats.isDirectory()) { ok = false; return; }
            const options = Array.from(new Set((record.mountOptions || []).concat(record.superOptions || []))).join(",");
            const args = ["--types", record.fsType];
            if (options) args.push("--options", options);
            args.push("--source", record.source, "--target", record.mountPoint);
            const result = this._runTool("mount", args);
            if (!result || result.status !== 0) {
                ok = false;
                return;
            }
            const after = parseMountInfo(this._readSystemFile("/proc/self/mountinfo")) || [];
            const restored = after.find(mount => mount.mountPoint === record.mountPoint);
            if (!sameIdentity(record, restored ? Object.assign({}, restored, {rootRemovable: false}) : null)) ok = false;
        });
        return ok;
    }

    _deviceIdentityCurrent(record) {
        const result = this._runTool("lsblk", [
            "--json", "--bytes", "--output", "NAME,PATH,MAJ:MIN,TYPE,RM,MOUNTPOINTS,FSTYPE"
        ]);
        const devices = result && result.status === 0 ? parseLsblk(String(result.stdout || "")) : null;
        return Boolean(devices && devices.some(device => device.rootRemovable === false
            && device.majorMinor === record.majorMinor && device.devicePath === record.source));
    }

    _readConfig() {
        const document = this._readRootJson(this.configPath, false);
        if (document.version !== 1 || Object.keys(document).some(key => ![
            "version", "nomadRoot", "repositoryRoots", "persistentPaths", "allowedUnmountRoots"
        ].includes(key))) throw new Error("invalid helper config");
        const validPath = value => typeof value === "string" && path.isAbsolute(value)
            && path.normalize(value) === value && !value.includes("\0");
        if (!validPath(document.nomadRoot) || !Array.isArray(document.repositoryRoots)
            || !document.repositoryRoots.length || !document.repositoryRoots.every(validPath)
            || !Array.isArray(document.persistentPaths) || !document.persistentPaths.every(validPath)
            || !Array.isArray(document.allowedUnmountRoots) || !document.allowedUnmountRoots.length
            || !document.allowedUnmountRoots.every(root => ["/media", "/mnt", "/run/media"].includes(root))) {
            throw new Error("invalid helper config");
        }
        return {
            version: 1,
            nomadRoot: document.nomadRoot,
            repositoryRoots: document.repositoryRoots.slice(0, 16),
            persistentPaths: document.persistentPaths.slice(0, 32),
            allowedUnmountRoots: document.allowedUnmountRoots.slice()
        };
    }

    _readState() {
        const document = this._readRootJson(this.statePath, true);
        if (!document) return null;
        const allowedKeys = [
            "version", "profile", "originalFirewallProfile", "previousFirewallProfile", "phase", "mounts", "pendingMount"
        ];
        if (Object.keys(document).length !== allowedKeys.length
            || Object.keys(document).some(key => !allowedKeys.includes(key)) || document.version !== 3
            || !["PUBLIC", "LOCKDOWN"].includes(document.profile)
            || ![null, "PUBLIC", "LOCKDOWN"].includes(document.originalFirewallProfile)
            || ![null, "PUBLIC", "LOCKDOWN"].includes(document.previousFirewallProfile)
            || !["APPLYING", "APPLIED"].includes(document.phase)
            || !Array.isArray(document.mounts) || document.mounts.length > 64) {
            throw new Error("invalid helper state");
        }
        const validRecord = record => isPlainObject(record)
            && Object.keys(record).length === 7
            && Object.keys(record).every(key => [
                "mountPoint", "source", "majorMinor", "fsType", "mountOptions", "superOptions", "rootRemovable"
            ].includes(key))
            && typeof record.mountPoint === "string"
            && ["/media", "/mnt", "/run/media"].some(root => withinRoot(record.mountPoint, root))
            && typeof record.source === "string" && /^\/dev\/[A-Za-z0-9._+@%/:-]+$/.test(record.source)
            && typeof record.majorMinor === "string" && /^[0-9]+:[0-9]+$/.test(record.majorMinor)
            && typeof record.fsType === "string" && /^[A-Za-z0-9._+-]{1,64}$/.test(record.fsType)
            && [record.mountOptions, record.superOptions].every(options => Array.isArray(options) && options.length <= 64
                && options.every(option => typeof option === "string" && /^[A-Za-z0-9._:+@%\/-]+(?:=[A-Za-z0-9._:+@%\/-]+)?$/.test(option)))
            && record.rootRemovable === false;
        if (!document.mounts.every(validRecord) || (document.pendingMount !== null && !validRecord(document.pendingMount))) {
            throw new Error("invalid helper state");
        }
        return {
            version: 3,
            profile: document.profile,
            originalFirewallProfile: document.originalFirewallProfile,
            previousFirewallProfile: document.previousFirewallProfile,
            phase: document.phase,
            mounts: document.mounts.map(record => Object.assign({}, record)),
            pendingMount: document.pendingMount ? Object.assign({}, document.pendingMount) : null
        };
    }

    _writeState(document) {
        const validated = this._validateStateDocument(document);
        this.fs.mkdirSync(this.stateDirectory, {recursive: true, mode: 0o700});
        const directory = this.fs.lstatSync(this.stateDirectory);
        if (directory.isSymbolicLink() || !directory.isDirectory() || directory.uid !== 0 || (directory.mode & 0o077) !== 0
            || this.fs.realpathSync(this.stateDirectory) !== path.resolve(this.stateDirectory)) {
            throw new Error("unsafe helper state directory");
        }
        const existing = this._stateSnapshot();
        const temporary = `${this.statePath}.tmp-${process.pid}-${Date.now()}`;
        const descriptor = this.fs.openSync(temporary,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
        try {
            this.fs.fchmodSync(descriptor, 0o600);
            this.fs.writeFileSync(descriptor, `${JSON.stringify(validated, null, 4)}\n`, {encoding: "utf8"});
            this.fs.fsyncSync(descriptor);
        } finally {
            this.fs.closeSync(descriptor);
        }
        try {
            if (!this._sameSnapshot(existing, this._stateSnapshot())) throw new Error("helper state changed");
            this.fs.renameSync(temporary, this.statePath);
            this._syncDirectory(this.stateDirectory);
        } catch (error) {
            try { this.fs.unlinkSync(temporary); } catch (cleanupError) {}
            throw error;
        }
    }

    _clearState() {
        const before = this._stateSnapshot();
        if (!before) return false;
        const stats = this.fs.lstatSync(this.statePath);
        if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1 || stats.uid !== 0 || (stats.mode & 0o077) !== 0) {
            throw new Error("unsafe helper state");
        }
        if (!this._sameSnapshot(before, this._stateSnapshot())) throw new Error("helper state changed");
        this.fs.unlinkSync(this.statePath);
        this._syncDirectory(this.stateDirectory);
        return true;
    }

    _clearStateIfPresent() {
        try {
            return this._clearState();
        } catch (error) {
            if (error && error.code === "ENOENT") return false;
            throw error;
        }
    }

    _validateStateDocument(document) {
        if (!isPlainObject(document)) throw new Error("invalid helper state");
        const allowedKeys = [
            "version", "profile", "originalFirewallProfile", "previousFirewallProfile", "phase", "mounts", "pendingMount"
        ];
        if (Object.keys(document).length !== allowedKeys.length
            || Object.keys(document).some(key => !allowedKeys.includes(key)) || document.version !== 3
            || !["PUBLIC", "LOCKDOWN"].includes(document.profile)
            || ![null, "PUBLIC", "LOCKDOWN"].includes(document.originalFirewallProfile)
            || ![null, "PUBLIC", "LOCKDOWN"].includes(document.previousFirewallProfile)
            || !["APPLYING", "APPLIED"].includes(document.phase)
            || !Array.isArray(document.mounts) || document.mounts.length > 64) {
            throw new Error("invalid helper state");
        }
        const validRecord = record => isPlainObject(record)
            && Object.keys(record).length === 7
            && Object.keys(record).every(key => [
                "mountPoint", "source", "majorMinor", "fsType", "mountOptions", "superOptions", "rootRemovable"
            ].includes(key))
            && typeof record.mountPoint === "string"
            && ["/media", "/mnt", "/run/media"].some(root => withinRoot(record.mountPoint, root))
            && typeof record.source === "string" && /^\/dev\/[A-Za-z0-9._+@%/:-]+$/.test(record.source)
            && typeof record.majorMinor === "string" && /^[0-9]+:[0-9]+$/.test(record.majorMinor)
            && typeof record.fsType === "string" && /^[A-Za-z0-9._+-]{1,64}$/.test(record.fsType)
            && [record.mountOptions, record.superOptions].every(options => Array.isArray(options) && options.length <= 64
                && options.every(option => typeof option === "string" && /^[A-Za-z0-9._:+@%\/-]+(?:=[A-Za-z0-9._:+@%\/-]+)?$/.test(option)))
            && record.rootRemovable === false;
        if (!document.mounts.every(validRecord) || (document.pendingMount !== null && !validRecord(document.pendingMount))) {
            throw new Error("invalid helper state");
        }
        return JSON.parse(JSON.stringify(document));
    }

    _stateSnapshot() {
        try {
            const stats = this.fs.lstatSync(this.statePath);
            if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1 || stats.uid !== 0
                || (stats.mode & 0o077) !== 0 || stats.size > MAX_BYTES) throw new Error("unsafe helper state");
            return {dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs};
        } catch (error) {
            if (error && error.code === "ENOENT") return null;
            throw error;
        }
    }

    _sameSnapshot(left, right) {
        if (!left || !right) return left === right;
        return left.dev === right.dev && left.ino === right.ino
            && left.size === right.size && left.mtimeMs === right.mtimeMs;
    }

    _syncDirectory(directory) {
        let descriptor;
        try {
            descriptor = this.fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
            this.fs.fsyncSync(descriptor);
        } finally {
            if (typeof descriptor === "number") this.fs.closeSync(descriptor);
        }
    }

    _readRootJson(filename, optional) {
        let stats;
        try { stats = this.fs.lstatSync(filename); } catch (error) {
            if (optional && error && error.code === "ENOENT") return null;
            throw new Error("root json unavailable");
        }
        if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1 || stats.uid !== 0
            || (stats.mode & 0o077) !== 0 || stats.size > MAX_BYTES) throw new Error("root json metadata refused");
        if (!this._trustedRootDirectoryChain(filename)) throw new Error("root json parent refused");
        let descriptor;
        try {
            descriptor = this.fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
            const opened = this.fs.fstatSync(descriptor);
            if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== 0 || (opened.mode & 0o077) !== 0
                || opened.dev !== stats.dev || opened.ino !== stats.ino || opened.size > MAX_BYTES) {
                throw new Error("root json changed");
            }
            const document = JSON.parse(this.fs.readFileSync(descriptor, "utf8"));
            if (!isPlainObject(document)) throw new Error("root json invalid");
            return document;
        } catch (error) {
            throw new Error("root json refused");
        } finally {
            if (typeof descriptor === "number") this.fs.closeSync(descriptor);
        }
    }

    _readSystemFile(filename) {
        try {
            const stats = this.fs.lstatSync(filename);
            if (!stats.isFile() || stats.size > MAX_BYTES) return null;
            return this.fs.readFileSync(filename, "utf8");
        } catch (error) {
            return null;
        }
    }

    _tool(name) {
        const candidates = this.tools[name];
        if (!Array.isArray(candidates)) return null;
        for (const candidate of candidates) {
            try {
                const canonical = this.fs.realpathSync(candidate);
                const stats = this.fs.statSync(canonical);
                if (!stats.isFile() || stats.uid !== 0 || (stats.mode & 0o022) !== 0 || (stats.mode & 0o111) === 0) continue;
                if (this._trustedRootDirectoryChain(canonical)) return canonical;
            } catch (error) {}
        }
        return null;
    }

    _trustedRootDirectoryChain(filename) {
        let parentPath = path.dirname(filename);
        try {
            while (true) {
                const parent = this.fs.lstatSync(parentPath);
                if (parent.isSymbolicLink() || !parent.isDirectory() || parent.uid !== 0
                    || (parent.mode & 0o022) !== 0 || this.fs.realpathSync(parentPath) !== path.resolve(parentPath)) return false;
                if (parentPath === path.parse(parentPath).root) return true;
                parentPath = path.dirname(parentPath);
            }
        } catch (error) {
            return false;
        }
    }

    _runTool(name, args) {
        const executable = this._tool(name);
        return executable ? this._run(executable, args) : null;
    }

    _run(executable, args, input) {
        if (typeof executable !== "string" || !path.isAbsolute(executable) || !Array.isArray(args)
            || args.some(argument => typeof argument !== "string" || argument.includes("\0"))) return null;
        return this.spawnSync(executable, args, {
            encoding: "utf8",
            input,
            env: {PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C"},
            shell: false,
            timeout: 30000,
            maxBuffer: MAX_BYTES,
            windowsHide: true
        });
    }

    _result(ok, status, profile = "NONE", firewall = "NOT_APPLIED", storage = "NOT_APPLIED") {
        return {
            ok: ok === true,
            status: String(status || "HELPER FAILURE").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160),
            profile: ["PUBLIC", "LOCKDOWN", "NONE"].includes(profile) ? profile : "NONE",
            firewall,
            storage
        };
    }
}

function main(argv = process.argv.slice(2), runtime = new HelperRuntime()) {
    if (!Array.isArray(argv) || argv.length !== 1 || !OPERATIONS.has(argv[0])) {
        return {exitCode: 2, result: {ok: false, status: "USAGE: nomad-security-helper <named-operation>", profile: "NONE", firewall: "NOT_APPLIED", storage: "NOT_APPLIED"}};
    }
    const result = runtime.execute(argv[0]);
    return {exitCode: result.ok ? 0 : 1, result};
}

if (require.main === module) {
    const response = main();
    process.stdout.write(`${JSON.stringify(response.result)}\n`);
    process.exitCode = response.exitCode;
}

module.exports = {
    CONFIG_PATH,
    HelperRuntime,
    MARKER,
    OPERATIONS,
    STATE_PATH,
    TABLE,
    classifyMounts,
    main,
    parseLsblk,
    parseMountInfo,
    renderRules,
    sameIdentity,
    verifyRules
};
