const assert = require("assert");
const {
    AutomountPolicyController,
    classifyStorageMounts,
    parseStorageLsblk,
    parseStorageMountInfo,
    sanitizeStoragePlan,
    verifyUnmountCandidate
} = require("../src/classes/securityStoragePolicyService.js");

const mountInfo = [
    "24 1 8:2 / / rw,relatime - ext4 /dev/sda2 rw",
    "25 24 8:17 / /mnt/host rw,relatime - ext4 /dev/sdb1 rw",
    "26 24 8:33 / /mnt/nomad rw,relatime - ext4 /dev/sdc1 rw",
    "27 24 8:49 / /mnt/repos rw,relatime - ext4 /dev/sdd1 rw",
    "28 24 8:65 / /media/usb rw,relatime - vfat /dev/sde1 rw",
    "29 24 0:55 / /run/user/1000 rw,nosuid,nodev - tmpfs tmpfs rw"
].join("\n");
const lsblk = JSON.stringify({blockdevices: [
    {name: "sda", path: "/dev/sda", "maj:min": "8:0", type: "disk", rm: false, children: [
        {name: "sda2", path: "/dev/sda2", "maj:min": "8:2", type: "part", rm: false, mountpoints: ["/"]}
    ]},
    {name: "sdb", path: "/dev/sdb", "maj:min": "8:16", type: "disk", rm: false, children: [
        {name: "sdb1", path: "/dev/sdb1", "maj:min": "8:17", type: "part", rm: false, mountpoints: ["/mnt/host"]}
    ]},
    {name: "sdc", path: "/dev/sdc", "maj:min": "8:32", type: "disk", rm: false, children: [
        {name: "sdc1", path: "/dev/sdc1", "maj:min": "8:33", type: "part", rm: false, mountpoints: ["/mnt/nomad"]}
    ]},
    {name: "sdd", path: "/dev/sdd", "maj:min": "8:48", type: "disk", rm: false, children: [
        {name: "sdd1", path: "/dev/sdd1", "maj:min": "8:49", type: "part", rm: false, mountpoints: ["/mnt/repos"]}
    ]},
    {name: "sde", path: "/dev/sde", "maj:min": "8:64", type: "disk", rm: true, children: [
        {name: "sde1", path: "/dev/sde1", "maj:min": "8:65", type: "part", rm: true, mountpoints: ["/media/usb"]}
    ]}
]});

const mounts = parseStorageMountInfo(mountInfo);
const devices = parseStorageLsblk(lsblk);
const inventory = classifyStorageMounts(mounts, devices, {
    protectedPaths: ["/mnt/nomad/NOMAD-UI", "/mnt/repos/example"],
    runtimePath: "/run/user/1000"
});
assert.strictEqual(inventory.state, "VERIFIED");
assert.strictEqual(inventory.ambiguous, false);
assert.deepStrictEqual(inventory.eligible.map(item => item.mountPoint), ["/mnt/host"]);
assert(inventory.protected.some(item => item.mountPoint === "/"), "root must always be protected");
assert(inventory.protected.some(item => item.mountPoint === "/mnt/nomad"), "NOMAD filesystem must always be protected");
assert(inventory.protected.some(item => item.mountPoint === "/mnt/repos"), "repository filesystem must always be protected");
assert(!inventory.eligible.some(item => ["/", "/mnt/nomad", "/mnt/repos", "/run/user/1000"].includes(item.mountPoint)));
assert.deepStrictEqual(inventory.removable.map(item => item.mountPoint), ["/media/usb"]);
assert.strictEqual(verifyUnmountCandidate(inventory.eligible[0], inventory), true);
assert.strictEqual(verifyUnmountCandidate(Object.assign({}, inventory.eligible[0], {majorMinor: "8:99"}), inventory), false);
assert.deepStrictEqual(sanitizeStoragePlan(inventory, false), {
    state: "VERIFIED", ambiguous: false, eligibleCount: 1, protectedCount: 3,
    refusedCount: 0, removableCount: 1, manualRemountPreventionVerified: false
});

const ambiguousMounts = parseStorageMountInfo(`${mountInfo}\n30 24 65:1 / /mnt/mystery rw - ext4 /dev/sdz1 rw`);
const ambiguous = classifyStorageMounts(ambiguousMounts, devices, {
    protectedPaths: ["/mnt/nomad/NOMAD-UI", "/mnt/repos/example"],
    runtimePath: "/run/user/1000"
});
assert.strictEqual(ambiguous.state, "AMBIGUOUS");
assert.strictEqual(ambiguous.ambiguous, true);
assert.strictEqual(verifyUnmountCandidate(inventory.eligible[0], ambiguous), false, "ambiguity must fail closed");

const internalOutsideAllowlist = parseStorageMountInfo(`${mountInfo}\n31 24 8:81 / /home/host rw - ext4 /dev/sdf1 rw`);
const outsideDevices = parseStorageLsblk(JSON.stringify({blockdevices: JSON.parse(lsblk).blockdevices.concat([
    {name: "sdf", path: "/dev/sdf", "maj:min": "8:80", type: "disk", rm: false, children: [
        {name: "sdf1", path: "/dev/sdf1", "maj:min": "8:81", type: "part", rm: false, mountpoints: ["/home/host"]}
    ]}
])}));
const refused = classifyStorageMounts(internalOutsideAllowlist, outsideDevices, {
    protectedPaths: ["/mnt/nomad/NOMAD-UI", "/mnt/repos/example"], runtimePath: "/run/user/1000"
});
assert(refused.refused.some(item => item.mountPoint === "/home/host"));
assert(!refused.eligible.some(item => item.mountPoint === "/home/host"));

let automountValue = "true";
const automountCalls = [];
const automount = new AutomountPolicyController({runner: (command, args, options) => {
    automountCalls.push({command, args, options});
    if (args[0] === "get") return {status: 0, stdout: `${automountValue}\n`, stderr: ""};
    if (args[0] === "set" && ["true", "false"].includes(args[3])) {
        automountValue = args[3];
        return {status: 0, stdout: "", stderr: ""};
    }
    return {status: 1, stdout: "", stderr: "refused"};
}});
const disabled = automount.disable();
assert.deepStrictEqual(disabled, {ok: true, changed: true, previous: "true", status: "DISABLED"});
assert.strictEqual(automountValue, "false");
assert.strictEqual(automount.restore({owned: true, previous: "true"}).ok, true);
assert.strictEqual(automountValue, "true");
automountValue = "true";
assert.strictEqual(automount.restore({owned: true, previous: "true"}).status, "ALREADY_RESTORED",
    "an interrupted restore must be safely idempotent when the exact prior value is already active");
automountValue = "false";
assert.strictEqual(automount.restore({owned: false, pending: true, previous: "true"}).ok, true,
    "a write-ahead pending record must restore a change completed immediately before a crash");
assert.strictEqual(automountValue, "true");
assert.strictEqual(automount.restore({owned: false, pending: false, previous: "false"}).status, "NOT_OWNED");
assert(automountCalls.every(call => call.command === "gsettings" && call.options.shell === false));
assert(!automountCalls.some(call => ["mount", "umount", "sudo", "pkexec"].includes(call.command)));

console.log("Storage root/NOMAD/repository protection, internal/removable classification, ambiguity refusal, revalidation, and automount ownership passed");
