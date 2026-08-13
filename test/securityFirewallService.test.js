const assert = require("assert");
const {
    NOMAD_NFT_MARKER,
    SecurityFirewallService,
    parseListeningSockets,
    renderNftRules,
    verifyNftPolicy
} = require("../src/classes/securityFirewallService.js");

const publicRules = renderNftRules("PUBLIC");
const lockdownRules = renderNftRules("LOCKDOWN");
assert(publicRules.includes("table inet nomad_security"));
assert(publicRules.includes(NOMAD_NFT_MARKER));
assert(publicRules.includes("hook input"));
assert(publicRules.includes("policy drop"));
assert(publicRules.includes('iifname "lo" accept'));
assert(publicRules.includes("ct state established,related accept"));
assert(publicRules.includes("hook output"));
assert(publicRules.includes("policy accept"), "PUBLIC must retain ordinary outbound access");
assert(publicRules.includes("sport 67 udp dport 68"), "PUBLIC must preserve IPv4 DHCP replies");
assert(publicRules.includes("sport 547 udp dport 546"), "PUBLIC must preserve IPv6 DHCP replies");
assert(publicRules.includes("nfproto ipv6 icmpv6"), "IPv6 control traffic must be considered");
assert(!publicRules.includes("flush ruleset"));

assert(lockdownRules.includes("hook output"));
assert(lockdownRules.match(/hook output[\s\S]*policy drop/));
assert(lockdownRules.includes("udp dport { 53, 123 }"));
assert(lockdownRules.includes("tcp dport { 53, 80, 443 }"));
assert(!lockdownRules.includes("5353"), "mDNS must not be allowed in LOCKDOWN");
assert(!lockdownRules.includes("1900"), "SSDP must not be allowed in LOCKDOWN");
assert(!lockdownRules.includes("5355"), "LLMNR must not be allowed in LOCKDOWN");
assert(!lockdownRules.includes("flush ruleset"));

assert.strictEqual(verifyNftPolicy(publicRules, "PUBLIC").result, "VERIFIED");
assert.strictEqual(verifyNftPolicy(lockdownRules, "LOCKDOWN").result, "VERIFIED");
assert.strictEqual(verifyNftPolicy(lockdownRules.replace(
    "oifname \"lo\" accept", "oifname \"lo\" accept\n            accept"
), "LOCKDOWN").result, "FAILED", "an unexpected broad accept must invalidate LOCKDOWN verification");
const outputEstablishedOffset = lockdownRules.lastIndexOf("ct state established,related accept");
const missingOutputEstablished = `${lockdownRules.slice(0, outputEstablishedOffset)}ct state invalid drop${
    lockdownRules.slice(outputEstablishedOffset + "ct state established,related accept".length)}`;
assert.strictEqual(verifyNftPolicy(missingOutputEstablished, "LOCKDOWN").result, "FAILED",
    "LOCKDOWN must verify established outbound traffic semantics");
assert.strictEqual(verifyNftPolicy(publicRules, "LOCKDOWN").result, "FAILED");
assert.strictEqual(verifyNftPolicy(publicRules.replace(/ip6 nexthdr[^\n]+\n/, ""), "PUBLIC").result, "FAILED",
    "IPv4-only coverage must never verify");
assert.strictEqual(renderNftRules("NORMAL"), null);
assert.strictEqual(renderNftRules("PUBLIC; flush ruleset"), null, "rule input must be a strict profile enum");

const calls = [];
const nftService = new SecurityFirewallService({
    runner: (command, args, options) => {
        calls.push({command, args, options});
        if (command === "nft" && args.join(" ") === "list ruleset") {
            return {status: 0, stdout: "table inet admin { chain input { type filter hook input priority 10; policy accept; } }", stderr: ""};
        }
        if (command === "nft" && args.join(" ") === "list table inet nomad_security") {
            return {status: 0, stdout: publicRules, stderr: ""};
        }
        if (command === "ss") return {status: 0, stdout: [
            "tcp LISTEN 0 128 127.0.0.1:3000 0.0.0.0:*",
            "udp UNCONN 0 0 [::]:5353 [::]:*"
        ].join("\n"), stderr: ""};
        return null;
    }
});
const nft = nftService.inspect("PUBLIC");
assert.strictEqual(nft.backend, "NFTABLES");
assert.strictEqual(nft.available, true);
assert.strictEqual(nft.nomadPolicyState, "PUBLIC");
assert.strictEqual(nft.verificationResult, "VERIFIED");
assert.strictEqual(nft.ipv4, true);
assert.strictEqual(nft.ipv6, true);
assert.strictEqual(nft.compliant, true);
assert.strictEqual(nft.listeners.externallyReachable, 1);
assert.strictEqual(nftService.check("PUBLIC").state, "SECURE");
assert.strictEqual(nftService.listeningCheck("PUBLIC", nft).state, "PARTIAL");
assert(calls.every(call => call.options.shell === false));
assert(!calls.some(call => call.args.some(argument => argument.includes("flush ruleset"))));

const ufwService = new SecurityFirewallService({runner: command => {
    if (command === "ufw") return {status: 0, stdout: "Status: active\nDefault: deny (incoming), allow (outgoing)", stderr: ""};
    return null;
}});
const ufw = ufwService.inspect("PUBLIC");
assert.strictEqual(ufw.backend, "UFW");
assert.strictEqual(ufw.currentState, "ACTIVE");
assert.strictEqual(ufw.nomadPolicyState, "NOT_APPLIED");
assert.strictEqual(ufw.compliant, false);
assert.strictEqual(ufwService.check("PUBLIC").state, "PARTIAL");

const firewalldService = new SecurityFirewallService({runner: command => {
    if (command === "firewall-cmd") return {status: 0, stdout: "running\n", stderr: ""};
    return null;
}});
const firewalld = firewalldService.inspect("LOCKDOWN");
assert.strictEqual(firewalld.backend, "FIREWALLD");
assert.strictEqual(firewalld.currentState, "ACTIVE");
assert.strictEqual(firewalld.compliant, false);

const unavailableService = new SecurityFirewallService({runner: () => null});
const unavailable = unavailableService.inspect("PUBLIC");
assert.strictEqual(unavailable.available, false);
assert.strictEqual(unavailable.compliant, false);
assert.strictEqual(unavailableService.check("PUBLIC").state, "UNAVAILABLE");
assert.strictEqual(unavailableService.plan("PUBLIC").available, false);

assert.deepStrictEqual(parseListeningSockets([
    "tcp LISTEN 0 128 127.0.0.1:3000 0.0.0.0:*",
    "tcp LISTEN 0 128 [::1]:3001 [::]:*",
    "udp UNCONN 0 0 0.0.0.0:68 0.0.0.0:*",
    "udp UNCONN 0 0 192.0.2.10:123 0.0.0.0:*"
].join("\n")), {
    total: 4, tcp: 2, udp: 2, loopback: 2, externallyReachable: 2, unknown: 0
});

console.log("Firewall backend abstraction, nft/UFW/firewalld detection, dual-stack templates, listener counts, and no-backend truthfulness passed");
