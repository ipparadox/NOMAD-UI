const fs = require("fs");
const path = require("path");
const {spawnSync} = require("child_process");
const {normalizeSecurityProfile} = require("./securityProfileService.js");

const NOMAD_NFT_TABLE = "nomad_security";
const NOMAD_NFT_MARKER = "NOMAD-UI MANAGED FIREWALL - DO NOT EDIT";
const MAX_FIREWALL_OUTPUT = 4 * 1024 * 1024;
const TRUSTED_SECURITY_TOOL_PATHS = Object.freeze({
    nft: Object.freeze(["/usr/sbin/nft", "/usr/bin/nft", "/sbin/nft"]),
    ufw: Object.freeze(["/usr/sbin/ufw", "/usr/bin/ufw"]),
    "firewall-cmd": Object.freeze(["/usr/bin/firewall-cmd", "/usr/sbin/firewall-cmd"]),
    ss: Object.freeze(["/usr/bin/ss", "/bin/ss", "/usr/sbin/ss"]),
    lsblk: Object.freeze(["/usr/bin/lsblk", "/bin/lsblk"]),
    gsettings: Object.freeze(["/usr/bin/gsettings", "/bin/gsettings"]),
    mokutil: Object.freeze(["/usr/bin/mokutil", "/usr/sbin/mokutil"]),
    pkexec: Object.freeze(["/usr/bin/pkexec"])
});

const ESSENTIAL_ICMPV6 = "destination-unreachable, packet-too-big, time-exceeded, parameter-problem, nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert";

function trustedRootDirectoryChain(filename, opts = {}) {
    const fsModule = opts.fs || fs;
    const pathModule = opts.path || path;
    let parentPath = pathModule.dirname(filename);
    try {
        while (true) {
            const stats = fsModule.lstatSync(parentPath);
            if (stats.isSymbolicLink() || !stats.isDirectory() || stats.uid !== 0 || (stats.mode & 0o022) !== 0
                || fsModule.realpathSync(parentPath) !== pathModule.resolve(parentPath)) return false;
            if (parentPath === pathModule.parse(parentPath).root) return true;
            parentPath = pathModule.dirname(parentPath);
        }
    } catch (error) {
        return false;
    }
}

function resolveTrustedSecurityTool(command, opts = {}) {
    const fsModule = opts.fs || fs;
    const pathModule = opts.path || path;
    const candidates = (opts.toolPaths || TRUSTED_SECURITY_TOOL_PATHS)[command];
    if (!Array.isArray(candidates)) return null;
    for (const candidate of candidates) {
        if (typeof candidate !== "string" || !pathModule.isAbsolute(candidate)) continue;
        try {
            const canonical = fsModule.realpathSync(candidate);
            const stats = fsModule.statSync(canonical);
            if (stats.isFile() && stats.uid === 0 && (stats.mode & 0o022) === 0
                && (stats.mode & 0o111) !== 0 && trustedRootDirectoryChain(canonical, opts)) return canonical;
        } catch (error) {}
    }
    return null;
}

function renderNftRules(profileValue) {
    const profile = normalizeSecurityProfile(profileValue);
    if (!profile || profile === "NORMAL") return null;
    const lockdown = profile === "LOCKDOWN";
    const outputRules = lockdown ? `
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
    return `table inet ${NOMAD_NFT_TABLE} {
        comment "${NOMAD_NFT_MARKER}; NOMAD-UI PROFILE ${profile}"
        chain input {
            type filter hook input priority 0; policy drop;
            iifname "lo" accept
            ct state established,related accept
            ip protocol udp udp sport 67 udp dport 68 accept
            ip6 nexthdr udp udp sport 547 udp dport 546 accept
            ip protocol icmp icmp type { destination-unreachable, time-exceeded, parameter-problem } accept
            meta nfproto ipv6 icmpv6 type { ${ESSENTIAL_ICMPV6} } accept
        }${outputRules}
    }
`;
}

function normalizeFirewallOutput(value, maximum = MAX_FIREWALL_OUTPUT) {
    return typeof value === "string" ? value.slice(0, maximum) : "";
}

function extractNftChain(content, name) {
    if (typeof content !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(name || "")) return null;
    const expression = new RegExp(`\\bchain\\s+${name}\\s*\\{`, "i");
    const match = expression.exec(content);
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

function acceptedRuleCount(chain) {
    return typeof chain === "string" ? (chain.match(/\baccept\b/gi) || []).length : 0;
}

function verifyNftPolicy(content, profileValue) {
    const profile = normalizeSecurityProfile(profileValue);
    if (!profile || profile === "NORMAL" || typeof content !== "string") return {
        result: "NOT_APPLICABLE", profile: null, ipv4: false, ipv6: false, reason: "NO RESTRICTED PROFILE REQUESTED"
    };
    const normalized = content.replace(/\s+/g, " ");
    const inputChain = extractNftChain(content, "input");
    const outputChain = extractNftChain(content, "output");
    const marker = normalized.includes(NOMAD_NFT_MARKER) && normalized.includes(`NOMAD-UI PROFILE ${profile}`);
    const table = new RegExp(`table\\s+inet\\s+${NOMAD_NFT_TABLE}\\b`).test(normalized);
    const chainCount = (normalized.match(/\bchain\s+[a-z][a-z0-9_]*\s*\{/gi) || []).length;
    const input = typeof inputChain === "string" && /hook\s+input\b.*?policy\s+drop/i.test(inputChain)
        && /iifname\s+"lo"\s+accept/i.test(inputChain)
        && (/ct\s+state\s+established,related\s+accept/i.test(inputChain)
            || /ct\s+state\s+\{\s*established,\s*related\s*\}\s+accept/i.test(inputChain))
        && /ip\s+protocol\s+udp.*?sport\s+67.*?dport\s+68.*?accept/i.test(inputChain)
        && /ip6\s+nexthdr\s+udp.*?sport\s+547.*?dport\s+546.*?accept/i.test(inputChain)
        && /ip\s+protocol\s+icmp.*?accept/i.test(inputChain)
        && /nfproto\s+ipv6\s+icmpv6.*?accept/i.test(inputChain)
        && acceptedRuleCount(inputChain) === 6;
    const ipv4 = Boolean(inputChain && /ip\s+protocol\s+udp.*?sport\s+67.*?dport\s+68/i.test(inputChain)
        && /ip\s+protocol\s+icmp/i.test(inputChain));
    const ipv6 = Boolean(inputChain && /ip6\s+nexthdr\s+udp.*?sport\s+547.*?dport\s+546/i.test(inputChain)
        && /nfproto\s+ipv6\s+icmpv6/i.test(inputChain));
    const output = profile === "PUBLIC"
        ? Boolean(outputChain && /hook\s+output\b.*?policy\s+accept/i.test(outputChain)
            && acceptedRuleCount(outputChain) === 1)
        : Boolean(outputChain && /hook\s+output\b.*?policy\s+drop/i.test(outputChain)
            && /oifname\s+"lo"\s+accept/i.test(outputChain)
            && (/ct\s+state\s+established,related\s+accept/i.test(outputChain)
                || /ct\s+state\s+\{\s*established,\s*related\s*\}\s+accept/i.test(outputChain))
            && /ip\s+protocol\s+udp.*?sport\s+68.*?dport\s+67.*?accept/i.test(outputChain)
            && /ip6\s+nexthdr\s+udp.*?sport\s+546.*?dport\s+547.*?accept/i.test(outputChain)
            && /udp\s+dport\s+\{\s*53,\s*123\s*\}.*?accept/i.test(outputChain)
            && /tcp\s+dport\s+\{\s*53,\s*80,\s*443\s*\}.*?accept/i.test(outputChain)
            && /ip\s+protocol\s+icmp.*?accept/i.test(outputChain)
            && /nfproto\s+ipv6\s+icmpv6.*?accept/i.test(outputChain)
            && acceptedRuleCount(outputChain) === 8);
    const verified = marker && table && chainCount === 2 && input && ipv4 && ipv6 && output;
    return {
        result: verified ? "VERIFIED" : "FAILED",
        profile: marker ? profile : null,
        ipv4,
        ipv6,
        reason: verified ? "NOMAD NFTABLES POLICY AND DUAL-STACK SEMANTICS VERIFIED"
            : "NOMAD NFTABLES POLICY COULD NOT BE VERIFIED COMPLETELY"
    };
}

function addressFromEndpoint(endpoint) {
    if (typeof endpoint !== "string") return null;
    const value = endpoint.trim();
    if (!value) return null;
    if (value.startsWith("[")) {
        const close = value.lastIndexOf("]:");
        return close > 0 ? value.slice(1, close) : null;
    }
    const separator = value.lastIndexOf(":");
    return separator >= 0 ? value.slice(0, separator) : value;
}

function classifyListeningAddress(address) {
    if (!address) return "UNKNOWN";
    const normalized = address.replace(/%.+$/, "").toLowerCase();
    if (["127.0.0.1", "::1"].includes(normalized) || normalized.startsWith("127.")) return "LOOPBACK";
    if (["0.0.0.0", "::", "*"].includes(normalized)) return "WILDCARD";
    return "NON_LOOPBACK";
}

function parseListeningSockets(content) {
    if (Buffer.isBuffer(content)) content = content.toString("utf8");
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_FIREWALL_OUTPUT) return null;
    const summary = {total: 0, tcp: 0, udp: 0, loopback: 0, externallyReachable: 0, unknown: 0};
    content.split("\n").forEach(line => {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 5) return;
        const protocol = fields[0].toLowerCase();
        if (protocol !== "tcp" && protocol !== "udp") return;
        const classification = classifyListeningAddress(addressFromEndpoint(fields[4]));
        summary.total++;
        summary[protocol]++;
        if (classification === "LOOPBACK") summary.loopback++;
        else if (classification === "WILDCARD" || classification === "NON_LOOPBACK") summary.externallyReachable++;
        else summary.unknown++;
    });
    return summary;
}

class SecurityFirewallService {
    constructor(opts = {}) {
        this.environment = opts.env || process.env;
        this.platform = opts.platform || process.platform;
        this.spawnSync = opts.spawnSync || spawnSync;
        this.runner = typeof opts.runner === "function" ? opts.runner : null;
        this.resolveExecutable = opts.resolveExecutable || (command => resolveTrustedSecurityTool(command, opts));
        this.timeoutMs = Number.isSafeInteger(opts.timeoutMs) ? opts.timeoutMs : 2000;
    }

    inspect(profileValue = "NORMAL") {
        const profile = normalizeSecurityProfile(profileValue) || "UNKNOWN";
        const nftRuleset = this._run("nft", ["list", "ruleset"]);
        const nftNomad = this._run("nft", ["list", "table", "inet", NOMAD_NFT_TABLE]);
        const ufw = this._run("ufw", ["status", "verbose"]);
        const firewalld = this._run("firewall-cmd", ["--state"]);
        const backends = [
            this._nftBackend(nftRuleset, nftNomad, profile),
            this._ufwBackend(ufw),
            this._firewalldBackend(firewalld)
        ];
        const active = backends.find(backend => backend.nomadPolicyState !== "NOT_APPLIED")
            || backends.find(backend => backend.currentState === "ACTIVE")
            || backends.find(backend => backend.available)
            || null;
        const listeners = parseListeningSockets((this._run("ss", ["-H", "-lntu"]) || {}).stdout);
        const expectedProfile = profile === "PUBLIC" || profile === "LOCKDOWN" ? profile : null;
        const nomad = backends[0];
        const compliant = expectedProfile ? nomad.verificationResult === "VERIFIED"
            && nomad.nomadPolicyState === expectedProfile && nomad.ipv4 && nomad.ipv6 : true;
        return {
            backend: active ? active.id : "NONE",
            available: backends.some(backend => backend.available),
            currentState: active ? active.currentState : "UNAVAILABLE",
            nomadPolicyState: nomad.nomadPolicyState,
            verificationResult: nomad.verificationResult,
            enforcementBackend: backends[0].available ? "NFTABLES_DEDICATED_TABLE" : "UNAVAILABLE",
            ipv4: nomad.ipv4,
            ipv6: nomad.ipv6,
            compliant,
            backends,
            listeners
        };
    }

    plan(profileValue) {
        const profile = normalizeSecurityProfile(profileValue);
        if (!profile) throw new Error("SECURITY PROFILE INVALID");
        const inspection = this.inspect(profile);
        if (profile === "NORMAL") return {
            profile,
            operation: "RESTORE_NOMAD_POLICY",
            backend: inspection.enforcementBackend,
            available: inspection.nomadPolicyState !== "NOT_APPLIED" || inspection.enforcementBackend !== "UNAVAILABLE",
            privileged: true,
            rules: null,
            preservesUnrelatedPolicy: true,
            reason: "REMOVE ONLY THE VERIFIED NOMAD-OWNED NFTABLES TABLE; PRESERVE ADMINISTRATOR POLICY"
        };
        return {
            profile,
            operation: `APPLY_${profile}`,
            backend: inspection.enforcementBackend,
            available: inspection.enforcementBackend !== "UNAVAILABLE",
            privileged: true,
            rules: renderNftRules(profile),
            preservesUnrelatedPolicy: true,
            reason: inspection.enforcementBackend === "UNAVAILABLE"
                ? "NO SAFE TRANSACTIONAL NOMAD FIREWALL BACKEND AVAILABLE"
                : "DEDICATED INET TABLE COVERS IPV4 AND IPV6 WITHOUT FLUSHING UNRELATED RULES"
        };
    }

    check(profileValue) {
        const profile = normalizeSecurityProfile(profileValue) || "UNKNOWN";
        const status = this.inspect(profile);
        if (!status.available) return {
            id: "firewall", label: "FIREWALL", state: "UNAVAILABLE", actual: "UNAVAILABLE",
            detail: "NO SUPPORTED FIREWALL INSPECTION TOOL AVAILABLE", status
        };
        if (status.verificationResult === "VERIFIED") return {
            id: "firewall", label: "FIREWALL", state: "SECURE", actual: status.nomadPolicyState,
            detail: "NOMAD DUAL-STACK NFTABLES POLICY VERIFIED", status
        };
        if (status.currentState === "ACTIVE") return {
            id: "firewall", label: "FIREWALL", state: "PARTIAL", actual: "ACTIVE_ADMIN_POLICY",
            detail: "A FIREWALL IS ACTIVE; NOMAD PROFILE SEMANTICS ARE NOT VERIFIED", status
        };
        if (status.currentState === "INACTIVE") return {
            id: "firewall", label: "FIREWALL", state: "INSECURE", actual: "NOT_CONFIGURED",
            detail: "SUPPORTED FIREWALL BACKENDS ARE INACTIVE", status
        };
        return {
            id: "firewall", label: "FIREWALL", state: "UNKNOWN", actual: "UNKNOWN",
            detail: "FIREWALL POLICY COULD NOT BE VERIFIED", status
        };
    }

    listeningCheck(profileValue, firewallStatus) {
        const profile = normalizeSecurityProfile(profileValue) || "UNKNOWN";
        const status = firewallStatus || this.inspect(profile);
        const listeners = status.listeners;
        if (!listeners) return {
            id: "listening_services", label: "LISTENING SERVICES", state: "UNKNOWN", actual: "UNKNOWN",
            detail: "LISTENING SOCKET INVENTORY UNAVAILABLE"
        };
        if (!listeners.externallyReachable) return {
            id: "listening_services", label: "LISTENING SERVICES", state: "SECURE", actual: "LOOPBACK_ONLY",
            detail: `${listeners.total} TCP/UDP LISTENER(S); NONE BOUND BEYOND LOOPBACK`
        };
        const restricted = profile === "PUBLIC" || profile === "LOCKDOWN";
        const filtered = restricted && status.verificationResult === "VERIFIED"
            && status.nomadPolicyState === profile;
        return {
            id: "listening_services", label: "LISTENING SERVICES",
            state: filtered ? "PARTIAL" : "INSECURE",
            actual: filtered ? "FILTERED" : "EXTERNALLY_REACHABLE",
            detail: `${listeners.externallyReachable} NON-LOOPBACK OR WILDCARD LISTENER(S) DETECTED${filtered ? "; NOMAD INPUT POLICY VERIFIED" : ""}`
        };
    }

    _nftBackend(ruleset, nomadTable, profile) {
        const available = Boolean(ruleset || nomadTable);
        const readable = Boolean(ruleset && ruleset.status === 0);
        const active = Boolean(readable && /\bhook\s+(input|forward|output)\b/i.test(ruleset.stdout));
        const knownAbsent = Boolean(readable
            && !new RegExp(`table\\s+inet\\s+${NOMAD_NFT_TABLE}\\b`).test(ruleset.stdout || ""));
        let verified = {result: "NOT_APPLIED", profile: null, ipv4: false, ipv6: false};
        if (nomadTable && nomadTable.status === 0) {
            const candidates = profile === "PUBLIC" || profile === "LOCKDOWN" ? [profile] : ["PUBLIC", "LOCKDOWN"];
            for (const candidate of candidates) {
                const result = verifyNftPolicy(nomadTable.stdout, candidate);
                if (result.result === "VERIFIED") {
                    verified = result;
                    break;
                }
                if (verified.result === "NOT_APPLIED") verified = result;
            }
        }
        return {
            id: "NFTABLES",
            available,
            currentState: active ? "ACTIVE" : (readable ? "INACTIVE" : (available ? "UNKNOWN" : "UNAVAILABLE")),
            nomadPolicyState: verified.result === "VERIFIED" ? verified.profile : "NOT_APPLIED",
            verificationResult: verified.result === "VERIFIED" ? "VERIFIED"
                : (nomadTable && nomadTable.status === 0 ? "FAILED" : (knownAbsent ? "NOT_APPLIED" : "UNKNOWN")),
            ipv4: verified.ipv4 === true,
            ipv6: verified.ipv6 === true,
            enforcement: available ? "SUPPORTED_DEDICATED_TABLE" : "UNAVAILABLE"
        };
    }

    _ufwBackend(result) {
        const available = Boolean(result);
        const output = result ? `${result.stdout || ""} ${result.stderr || ""}` : "";
        const active = /status:\s*active/i.test(output);
        const inactive = /status:\s*inactive/i.test(output);
        return {
            id: "UFW", available,
            currentState: active ? "ACTIVE" : (inactive ? "INACTIVE" : (available ? "UNKNOWN" : "UNAVAILABLE")),
            nomadPolicyState: "NOT_APPLIED", verificationResult: "NOT_APPLICABLE",
            ipv4: false, ipv6: false, enforcement: "INSPECTION_ONLY"
        };
    }

    _firewalldBackend(result) {
        const available = Boolean(result);
        const output = result ? `${result.stdout || ""} ${result.stderr || ""}` : "";
        const active = result && result.status === 0 && /^running\s*$/i.test(result.stdout || "");
        const inactive = /not\s+running/i.test(output);
        return {
            id: "FIREWALLD", available,
            currentState: active ? "ACTIVE" : (inactive ? "INACTIVE" : (available ? "UNKNOWN" : "UNAVAILABLE")),
            nomadPolicyState: "NOT_APPLIED", verificationResult: "NOT_APPLICABLE",
            ipv4: false, ipv6: false, enforcement: "INSPECTION_ONLY"
        };
    }

    _run(command, args) {
        if (!Array.isArray(args) || args.some(argument => typeof argument !== "string" || argument.includes("\0"))) return null;
        if (this.runner) {
            try {
                const result = this.runner(command, args.slice(), {shell: false, timeout: this.timeoutMs});
                return result && typeof result === "object" ? {
                    status: Number.isInteger(result.status) ? result.status : null,
                    stdout: normalizeFirewallOutput(result.stdout),
                    stderr: normalizeFirewallOutput(result.stderr, 4096)
                } : null;
            } catch (error) {
                return null;
            }
        }
        const executable = this.resolveExecutable(command);
        if (!executable) return null;
        try {
            const result = this.spawnSync(executable, args, {
                encoding: "utf8",
                env: {PATH: this.environment.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
                shell: false,
                timeout: this.timeoutMs,
                maxBuffer: MAX_FIREWALL_OUTPUT,
                windowsHide: true
            });
            return {
                status: Number.isInteger(result.status) ? result.status : null,
                stdout: normalizeFirewallOutput(result.stdout),
                stderr: normalizeFirewallOutput(result.stderr, 4096)
            };
        } catch (error) {
            return {status: null, stdout: "", stderr: ""};
        }
    }
}

module.exports = {
    ESSENTIAL_ICMPV6,
    NOMAD_NFT_MARKER,
    NOMAD_NFT_TABLE,
    SecurityFirewallService,
    extractNftChain,
    TRUSTED_SECURITY_TOOL_PATHS,
    addressFromEndpoint,
    classifyListeningAddress,
    parseListeningSockets,
    renderNftRules,
    resolveTrustedSecurityTool,
    trustedRootDirectoryChain,
    verifyNftPolicy
};
