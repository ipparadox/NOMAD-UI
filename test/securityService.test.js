const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {RepositoryIsolationService} = require("../src/classes/repositoryIsolationService.js");
const {SECURITY_PROFILES} = require("../src/classes/securityProfileService.js");
const {
    SecurityService,
    analyzeHostStorage,
    auditPermissionPath,
    detectEncryption,
    handleSecurityProfileSetRequest,
    handleSecurityStatusRequest,
    parseLsblkJson,
    parseSecureBootText,
    parseSecureBootVariable,
    parseSwapTable,
    sanitizeHostStorageInventory,
    sanitizeSecurityStatus
} = require("../src/classes/securityService.js");

function check(status, id) {
    const result = status.checks.find(item => item.id === id);
    assert(result, `missing security check ${id}`);
    return result;
}

function profileService(profile, changes = []) {
    return {
        get: () => ({profile, source: "CONFIG", updatedAt: null, policy: SECURITY_PROFILES[profile]}),
        set: value => {
            changes.push(value);
            const normalized = String(value).toUpperCase();
            return {profile: normalized, source: "CONFIG", updatedAt: new Date().toISOString(), policy: SECURITY_PROFILES[normalized]};
        },
        list: () => Object.keys(SECURITY_PROFILES).map(id => SECURITY_PROFILES[id])
    };
}

async function run() {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-security-service-"));
    try {
        const configRoot = path.join(temporaryRoot, "config", "nomad");
        const stateRoot = path.join(temporaryRoot, "state", "nomad");
        const runtimeRoot = path.join(temporaryRoot, "runtime");
        fs.mkdirSync(configRoot, {recursive: true, mode: 0o700});
        fs.mkdirSync(stateRoot, {recursive: true, mode: 0o700});
        fs.mkdirSync(runtimeRoot, {recursive: true, mode: 0o700});
        ["security.json", "apps.json", "repository-runs.json", "session.env"].forEach(filename => {
            fs.writeFileSync(path.join(configRoot, filename), "{}\n", {mode: 0o600});
        });
        ["session.log", "ui.log"].forEach(filename => {
            fs.writeFileSync(path.join(stateRoot, filename), "log\n", {mode: 0o600});
        });

        const mountInfo = [
            "24 1 8:2 / / rw,relatime - ext4 /dev/sda2 rw",
            "25 24 0:30 / /tmp rw,nosuid,nodev - tmpfs tmpfs rw",
            `26 24 0:31 / ${runtimeRoot.replace(/ /g, "\\040")} rw,nosuid,nodev - tmpfs tmpfs rw`
        ].join("\n");
        const blockFixture = JSON.stringify({
            blockdevices: [
                {
                    name: "sda", kname: "sda", path: "/dev/sda", type: "disk", rm: false,
                    children: [{
                        name: "sda2", kname: "sda2", path: "/dev/sda2", type: "part", rm: false,
                        fstype: "ext4", mountpoints: ["/"]
                    }]
                },
                {
                    name: "sdb", kname: "sdb", path: "/dev/sdb", type: "disk", rm: true,
                    children: [{
                        name: "sdb1", kname: "sdb1", path: "/dev/sdb1", type: "part", rm: true,
                        fstype: "vfat", mountpoints: ["/media/NOMAD"]
                    }]
                }
            ]
        });
        const environment = {
            PATH: "/usr/bin:/bin",
            HOME: temporaryRoot,
            XDG_CONFIG_HOME: path.join(temporaryRoot, "config"),
            XDG_STATE_HOME: path.join(temporaryRoot, "state"),
            XDG_RUNTIME_DIR: runtimeRoot,
            XDG_SESSION_TYPE: "x11",
            XDG_CURRENT_DESKTOP: "NOMAD",
            DESKTOP_SESSION: "nomad"
        };
        const directIsolation = new RepositoryIsolationService({
            env: environment,
            runtimeRoot: path.join(temporaryRoot, "repository-runtime"),
            probeBackend: () => false
        });
        const commandCalls = [];
        const service = new SecurityService({
            env: environment,
            home: temporaryRoot,
            nomadConfigRoot: configRoot,
            nomadStateRoot: stateRoot,
            profileService: profileService("PUBLIC"),
            isolationService: directIsolation,
            productionMode: true,
            debugConfiguration: {
                devTools: false,
                nodeIntegration: true,
                enableRemoteModule: true,
                experimentalFeatures: false
            },
            sources: {
                mountInfo,
                lsblk: blockFixture,
                swaps: "Filename\tType\t\tSize\tUsed\tPriority\n/swapfile file 1024 0 -2\n",
                secureBoot: Buffer.from([0, 0, 0, 0, 1])
            },
            commandRunner: (command, args, options) => {
                commandCalls.push({command, args, options});
                if (command === "gsettings") return {status: 0, stdout: "false\n", stderr: ""};
                return null;
            },
            now: () => new Date("2026-08-13T14:00:00.000Z")
        });

        const status = service.status({verbose: true});
        assert.strictEqual(status.profile.id, "PUBLIC");
        assert.strictEqual(status.profile.compliance, "NON_COMPLIANT");
        assert.strictEqual(status.profile.systemEnforcementPending, true);
        assert.deepStrictEqual(check(status, "firewall"), {
            id: "firewall",
            label: "FIREWALL",
            state: "UNAVAILABLE",
            actual: "UNAVAILABLE",
            detail: "NO SUPPORTED FIREWALL INSPECTION TOOL AVAILABLE"
        });
        assert.strictEqual(check(status, "host_storage").actual, "ACCESSIBLE");
        assert.strictEqual(check(status, "swap").actual, "ACTIVE");
        assert.strictEqual(check(status, "secure_boot").actual, "ENABLED");
        assert.strictEqual(check(status, "disk_encryption").actual, "NOT_VERIFIED");
        assert.strictEqual(check(status, "repository_isolation").actual, "NONE");
        assert.strictEqual(check(status, "repository_execution").actual, "BLOCKED");
        assert.strictEqual(check(status, "session_type").state, "SECURE");
        assert.strictEqual(check(status, "debug_devtools").actual, "RESTRICTED");
        assert.strictEqual(check(status, "renderer_privilege").state, "INSECURE");
        assert.strictEqual(check(status, "application_registry_permissions").state, "SECURE");
        assert.strictEqual(check(status, "repository_trust_store_permissions").state, "SECURE");
        const hostPolicy = status.policy.find(item => item.id === "host_storage");
        assert.deepStrictEqual({desired: hostPolicy.desired, actual: hostPolicy.actual, compliant: hostPolicy.compliant}, {
            desired: "BLOCKED", actual: "ACCESSIBLE", compliant: false
        });
        assert(commandCalls.every(call => call.options.shell === false));
        assert(!commandCalls.some(call => ["sudo", "pkexec", "mount", "umount"].includes(call.command)));
        assert(!commandCalls.some(call => call.command === "firewall-cmd" && call.args.some(argument => argument.startsWith("--add"))));
        const serialized = JSON.stringify(status);
        assert(!serialized.includes("/dev/sda"));
        assert(!serialized.includes(configRoot));
        assert(!serialized.includes(runtimeRoot));

        const inventory = analyzeHostStorage(parseLsblkJson(blockFixture));
        assert.strictEqual(inventory.actual, "ACCESSIBLE");
        assert.deepStrictEqual(sanitizeHostStorageInventory(Object.assign({}, inventory, {
            rawPath: "/private/device/path"
        })), {
            actual: "ACCESSIBLE",
            rootBacking: "INTERNAL",
            internalMountCount: 1,
            removableMountCount: 1,
            internalDeviceCount: 1,
            removableDeviceCount: 1,
            repositoryBacking: "UNKNOWN"
        });

        const unknownService = new SecurityService({
            env: {PATH: ""},
            home: temporaryRoot,
            nomadConfigRoot: path.join(temporaryRoot, "absent-config"),
            nomadStateRoot: path.join(temporaryRoot, "absent-state"),
            profileService: profileService("NORMAL"),
            isolationService: directIsolation,
            sources: {mountInfo: null, lsblk: null, swaps: null, secureBoot: null},
            resolveExecutable: () => null,
            productionMode: false
        });
        const unknown = unknownService.status({verbose: true});
        ["host_storage", "disk_encryption", "swap", "secure_boot", "runtime_directory"].forEach(id => {
            assert.notStrictEqual(check(unknown, id).state, "SECURE", `${id} must not become SECURE without evidence`);
        });
        assert.strictEqual(check(unknown, "firewall").state, "UNAVAILABLE");

        assert.strictEqual(parseSecureBootVariable(Buffer.from([0, 0, 0, 0, 1])), "ENABLED");
        assert.strictEqual(parseSecureBootVariable(Buffer.from([0, 0, 0, 0, 0])), "DISABLED");
        assert.strictEqual(parseSecureBootVariable(Buffer.from([])), "UNKNOWN");
        assert.strictEqual(parseSecureBootText("SecureBoot enabled\n"), "ENABLED");
        assert.strictEqual(parseSecureBootText("SecureBoot disabled\n"), "DISABLED");
        assert.deepStrictEqual(parseSwapTable("Filename\tType\tSize\tUsed\tPriority\n"), []);

        const dmOnly = parseLsblkJson(JSON.stringify({blockdevices: [{
            name: "dm-0", path: "/dev/dm-0", type: "dm", rm: false, mountpoints: ["/"]
        }]}));
        assert.strictEqual(detectEncryption(dmOnly).actual, "NOT_VERIFIED", "generic device mapper must not imply encryption");
        const encrypted = parseLsblkJson(JSON.stringify({blockdevices: [{
            name: "sda", path: "/dev/sda", type: "disk", rm: false, children: [{
                name: "cryptroot", path: "/dev/mapper/cryptroot", type: "crypt", mountpoints: ["/"]
            }]
        }]}));
        assert.strictEqual(detectEncryption(encrypted).actual, "VERIFIED");
        const partialEncryption = parseLsblkJson(JSON.stringify({blockdevices: [{
            name: "sda", path: "/dev/sda", type: "disk", rm: false, children: [
                {name: "cryptroot", path: "/dev/mapper/cryptroot", type: "crypt", mountpoints: ["/"]},
                {name: "sda3", path: "/dev/sda3", type: "part", mountpoints: ["/home"]}
            ]
        }]}));
        assert.strictEqual(detectEncryption(partialEncryption).actual, "PARTIAL");
        const unencryptedSwap = parseLsblkJson(JSON.stringify({blockdevices: [{
            name: "sda", path: "/dev/sda", type: "disk", rm: false, children: [
                {name: "cryptroot", path: "/dev/mapper/cryptroot", type: "crypt", mountpoints: ["/"]},
                {name: "sda4", path: "/dev/sda4", type: "part", mountpoints: ["[SWAP]"]}
            ]
        }]}));
        assert.strictEqual(detectEncryption(unencryptedSwap).actual, "PARTIAL", "unencrypted swap must prevent VERIFIED status");

        const permissionFile = path.join(temporaryRoot, "permission-test.json");
        fs.writeFileSync(permissionFile, "{}", {mode: 0o600});
        assert.strictEqual(auditPermissionPath({
            id: "permission_test", label: "PERMISSION TEST", path: permissionFile, type: "file", sensitive: true
        }).state, "SECURE");
        fs.chmodSync(permissionFile, 0o644);
        assert.strictEqual(auditPermissionPath({
            id: "permission_test", label: "PERMISSION TEST", path: permissionFile, type: "file", sensitive: true
        }).state, "INSECURE");
        const victim = path.join(temporaryRoot, "permission-victim");
        const linked = path.join(temporaryRoot, "permission-link");
        fs.writeFileSync(victim, "preserve", {mode: 0o600});
        fs.symlinkSync(victim, linked);
        assert.strictEqual(auditPermissionPath({
            id: "permission_test", label: "PERMISSION TEST", path: linked, type: "file", sensitive: true
        }).actual, "SYMLINK");

        const projected = sanitizeSecurityStatus({
            generatedAt: "2026-08-13T14:00:00.000Z",
            profile: {id: "NORMAL", source: "DEFAULT", compliance: "UNKNOWN", systemEnforcementPending: false},
            checks: [{
                id: "firewall", label: "FIREWALL", state: "UNKNOWN", actual: "UNKNOWN",
                detail: "NO DATA", rawOutput: "secret raw command output", internalPath: "/secret/path"
            }],
            internalPath: "/secret/root"
        }, true);
        assert(!JSON.stringify(projected).includes("secret"));
        const ipcResult = await handleSecurityStatusRequest({status: () => Object.assign({}, projected, {
            internalPath: "/main-only/path"
        })}, {verbose: true});
        assert.strictEqual(ipcResult.ok, true);
        assert(!JSON.stringify(ipcResult).includes("main-only"));
        assert.deepStrictEqual(await handleSecurityStatusRequest(service, {path: "/tmp"}), {
            ok: false, status: "INVALID REQUEST"
        });
        assert.deepStrictEqual(await handleSecurityProfileSetRequest(service, {
            profile: "PUBLIC", executable: "/tmp/renderer"
        }), {ok: false, status: "INVALID REQUEST"});

        const changes = [];
        const safeProfileChange = new SecurityService({
            env: environment,
            home: temporaryRoot,
            nomadConfigRoot: configRoot,
            nomadStateRoot: stateRoot,
            profileService: profileService("NORMAL", changes),
            isolationService: directIsolation,
            sources: {mountInfo, lsblk: blockFixture, swaps: "Filename\tType\tSize\tUsed\tPriority\n", secureBoot: null},
            commandRunner: (command, args, options) => {
                commandCalls.push({command, args, options});
                return null;
            }
        });
        safeProfileChange.setProfile("PUBLIC");
        assert.deepStrictEqual(changes, ["PUBLIC"]);
        assert(!commandCalls.some(call => ["sudo", "pkexec", "mount", "umount", "systemctl"].includes(call.command)));

        const lockdown = new SecurityService({
            env: environment,
            home: temporaryRoot,
            nomadConfigRoot: configRoot,
            nomadStateRoot: stateRoot,
            profileService: profileService("LOCKDOWN"),
            isolationService: directIsolation,
            sources: {mountInfo, lsblk: blockFixture, swaps: "Filename\tType\tSize\tUsed\tPriority\n", secureBoot: null},
            commandRunner: () => null
        }).status({verbose: true});
        assert.strictEqual(check(lockdown, "repository_execution").actual, "NEW_RUNS_DISABLED");
        assert.strictEqual(lockdown.policy.find(item => item.id === "repository_execution").compliant, null);
        assert.strictEqual(lockdown.profile.compliance, "NON_COMPLIANT", "disabled RUN must not hide other pending lockdown controls");

        const verifiedLockdown = new SecurityService({
            env: environment,
            home: temporaryRoot,
            nomadConfigRoot: configRoot,
            nomadStateRoot: stateRoot,
            profileService: profileService("LOCKDOWN"),
            isolationService: directIsolation,
            hasActiveRepositoryProcesses: () => false,
            sources: {mountInfo, lsblk: blockFixture, swaps: "Filename\tType\tSize\tUsed\tPriority\n", secureBoot: null},
            commandRunner: () => null
        }).status({verbose: true});
        assert.strictEqual(check(verifiedLockdown, "repository_execution").actual, "DISABLED");
        assert.strictEqual(verifiedLockdown.policy.find(item => item.id === "repository_execution").compliant, true);

        console.log("Factual security observations, unknown handling, storage sanitization, parsing, permissions, policy compliance, and IPC projection passed");
    } finally {
        fs.rmSync(temporaryRoot, {recursive: true, force: true});
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
