const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    SECURITY_PROFILE_IDS,
    SecurityProfileService,
    SecurityProfileStore,
    normalizeSecurityProfile,
    parseSecurityProfileContent
} = require("../src/classes/securityProfileService.js");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-security-profile-"));

try {
    const home = path.join(temporaryRoot, "home");
    const storePath = path.join(home, ".config", "nomad", "security.json");
    const renameCalls = [];
    const observedFs = Object.create(fs);
    observedFs.renameSync = (source, target) => {
        renameCalls.push({source, target});
        return fs.renameSync(source, target);
    };
    const store = new SecurityProfileStore({
        fs: observedFs,
        home,
        storePath,
        now: () => new Date("2026-08-13T12:00:00.000Z"),
        randomBytes: () => Buffer.alloc(12, 7)
    });
    const service = new SecurityProfileService({store});

    assert.deepStrictEqual(service.get(), {
        profile: "NORMAL",
        source: "DEFAULT",
        updatedAt: null,
        policy: service.list()[0]
    });
    assert.deepStrictEqual(service.list().map(profile => profile.id), SECURITY_PROFILE_IDS);
    assert.strictEqual(normalizeSecurityProfile(" public "), "PUBLIC");
    assert.strictEqual(normalizeSecurityProfile("public-secure"), null);

    const changed = service.set("public");
    assert.strictEqual(changed.profile, "PUBLIC");
    assert.strictEqual(changed.source, "CONFIG");
    assert.strictEqual(fs.statSync(storePath).mode & 0o777, 0o600);
    assert.strictEqual(renameCalls.length, 1, "profile updates must use one atomic rename");
    assert(renameCalls[0].source.includes(".security.json.tmp-"));
    assert.strictEqual(renameCalls[0].target, storePath);
    assert.deepStrictEqual(parseSecurityProfileContent(fs.readFileSync(storePath)), {
        version: 1,
        profile: "PUBLIC",
        updatedAt: "2026-08-13T12:00:00.000Z"
    });

    const validContent = fs.readFileSync(storePath, "utf8");
    assert.throws(() => service.set("unknown"), error => error.status === "SECURITY PROFILE INVALID");
    assert.strictEqual(fs.readFileSync(storePath, "utf8"), validContent);

    const malformed = "{ this profile store is deliberately malformed\n";
    fs.writeFileSync(storePath, malformed, {mode: 0o600});
    assert.throws(() => service.get(), error => error.status === "SECURITY PROFILE STORE INVALID");
    assert.throws(() => service.set("lockdown"), error => error.status === "SECURITY PROFILE STORE INVALID");
    assert.strictEqual(fs.readFileSync(storePath, "utf8"), malformed, "malformed stores must be preserved");

    const victim = path.join(temporaryRoot, "victim.json");
    fs.writeFileSync(victim, "DO NOT CHANGE", {mode: 0o600});
    fs.unlinkSync(storePath);
    fs.symlinkSync(victim, storePath);
    assert.throws(() => service.get(), error => error.status === "SECURITY PROFILE STORE REFUSED");
    assert.throws(() => service.set("normal"), error => error.status === "SECURITY PROFILE STORE REFUSED");
    assert.strictEqual(fs.readFileSync(victim, "utf8"), "DO NOT CHANGE");

    fs.unlinkSync(storePath);
    fs.writeFileSync(storePath, validContent, {mode: 0o644});
    assert.throws(() => service.get(), error => error.status === "SECURITY PROFILE STORE REFUSED");
    assert.strictEqual(fs.statSync(storePath).mode & 0o777, 0o644, "unsafe modes must be reported, not silently fixed");

    console.log("Security profile defaults, policy validation, atomic mode-0600 storage, and fail-closed preservation passed");
} finally {
    fs.rmSync(temporaryRoot, {recursive: true, force: true});
}
