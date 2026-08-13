const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {SecurityIntegrityService} = require("../src/classes/securityIntegrityService.js");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-integrity-"));
try {
    const trustedDirectory = path.join(temporaryRoot, "trusted");
    fs.mkdirSync(trustedDirectory, {recursive: true, mode: 0o755});
    fs.chmodSync(trustedDirectory, 0o755);
    const safeFile = path.join(trustedDirectory, "safe.js");
    const writableFile = path.join(trustedDirectory, "writable.js");
    const linkedFile = path.join(trustedDirectory, "linked.js");
    fs.writeFileSync(safeFile, "module.exports = true;\n", {mode: 0o644});
    fs.writeFileSync(writableFile, "module.exports = false;\n", {mode: 0o666});
    fs.writeFileSync(linkedFile, "module.exports = false;\n", {mode: 0o644});
    fs.chmodSync(writableFile, 0o666);
    fs.linkSync(linkedFile, path.join(temporaryRoot, "unexpected-hardlink.js"));

    const resources = [
        {id: "safe", label: "SAFE", path: safeFile, executable: false},
        {id: "writable", label: "WRITABLE", path: writableFile, executable: false},
        {id: "linked", label: "LINKED", path: linkedFile, executable: false}
    ];
    const findings = new SecurityIntegrityService({appRoot: temporaryRoot, resources}).audit();
    assert.strictEqual(findings.state, "INSECURE");
    assert.strictEqual(findings.resources.find(resource => resource.id === "safe").state, "PARTIAL");
    assert.strictEqual(findings.resources.find(resource => resource.id === "writable").state, "INSECURE");
    assert.strictEqual(findings.resources.find(resource => resource.id === "linked").state, "INSECURE");

    fs.chmodSync(writableFile, 0o644);
    fs.unlinkSync(path.join(temporaryRoot, "unexpected-hardlink.js"));
    const metadataOnly = new SecurityIntegrityService({appRoot: temporaryRoot, resources}).audit();
    assert.strictEqual(metadataOnly.state, "PARTIAL");
    assert.strictEqual(metadataOnly.actual, "USER_WRITABLE_TRUST_BASE");
    assert(metadataOnly.threatModel.includes("SAME-USER ATTACKER"));
    assert(!metadataOnly.detail.includes("CRYPTOGRAPHICALLY TRUSTED"));

    console.log("Integrity owner/type/mode/hardlink checks and honest same-user writable-root threat model passed");
} finally {
    fs.rmSync(temporaryRoot, {recursive: true, force: true});
}
