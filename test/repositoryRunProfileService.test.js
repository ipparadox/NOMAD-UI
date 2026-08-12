const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    RepositoryRunProfileService,
    RepositoryRunTrustStore,
    parseRepositoryTrustContent
} = require("../src/classes/repositoryRunProfileService.js");

const repositoryId = "repo_0123456789abcdef0123456789abcdef";
const identity = `sha256:${"1".repeat(64)}`;
const executionIdentity = `sha256:${"2".repeat(64)}`;

function writeManifest(repositoryPath, scripts, extra = {}) {
    fs.writeFileSync(path.join(repositoryPath, "package.json"), JSON.stringify(Object.assign({scripts}, extra), null, 2));
}

function run() {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-run-profiles-"));
    try {
        const repositoryPath = path.join(temporaryRoot, "repository");
        const trustStorePath = path.join(temporaryRoot, "config", "repository-runs.json");
        const marker = path.join(temporaryRoot, "MUST-NOT-EXIST");
        fs.mkdirSync(repositoryPath);
        writeManifest(repositoryPath, {
            predev: `node -e "require('fs').writeFileSync('${marker}', 'bad')"`,
            dev: "vite --host 127.0.0.1",
            start: "node server.js",
            unsupported: "make all"
        });
        fs.writeFileSync(path.join(repositoryPath, "main.py"), `open(${JSON.stringify(marker)}, "w").write("bad")\n`);

        const repository = {
            id: repositoryId,
            canonicalPath: fs.realpathSync(repositoryPath),
            repositoryIdentity: identity,
            executionIdentity
        };
        const trustStore = new RepositoryRunTrustStore({trustStorePath});
        const service = new RepositoryRunProfileService({
            trustStore,
            now: () => new Date("2026-08-12T12:00:00.000Z")
        });

        const detected = service.discover(repository);
        assert.deepStrictEqual(detected.map(profile => profile.displayName), ["NPM DEV", "NPM START", "PYTHON MAIN"]);
        assert.deepStrictEqual(detected.map(profile => [profile.executable, profile.args]), [
            ["npm", ["run", "dev"]],
            ["npm", ["run", "start"]],
            ["python3", ["main.py"]]
        ]);
        assert.strictEqual(fs.existsSync(marker), false, "candidate detection must never execute package scripts or Python files");

        let inspection = service.inspect(repository);
        assert(inspection.candidates.every(profile => profile.authorizationState === "UNAPPROVED"));
        const npmDev = inspection.candidates.find(profile => profile.profileId === "npm-dev");
        service.approve(repository, npmDev);

        const storedDocument = fs.readFileSync(trustStorePath, "utf8");
        const stored = JSON.parse(storedDocument);
        assert.strictEqual(stored.version, 1);
        assert.strictEqual(stored.profiles.length, 1);
        assert.deepStrictEqual(stored.profiles[0], {
            repositoryId,
            repositoryIdentity: identity,
            profileId: "npm-dev",
            displayName: "NPM DEV",
            executable: "npm",
            args: ["run", "dev"],
            workingDirectory: ".",
            port: null,
            browserBehavior: "none",
            trustMode: "TRUST_PROFILE",
            source: {kind: "package-json-script", reference: "dev"},
            sourceFingerprint: npmDev.sourceFingerprint,
            profileFingerprint: npmDev.profileFingerprint,
            approvedAt: "2026-08-12T12:00:00.000Z"
        });
        assert.deepStrictEqual(parseRepositoryTrustContent(storedDocument), stored.profiles);
        assert.strictEqual(fs.statSync(trustStorePath).mode & 0o777, 0o600);

        inspection = service.inspect(repository);
        assert.strictEqual(inspection.candidates.find(profile => profile.profileId === "npm-dev").authorizationState, "APPROVED");

        writeManifest(repositoryPath, {
            predev: `node -e "require('fs').writeFileSync('${marker}', 'bad')"`,
            dev: "vite --host 127.0.0.1",
            start: "node changed-but-unrelated.js"
        }, {description: "unrelated package metadata"});
        assert.strictEqual(
            service.inspect(repository).candidates.find(profile => profile.profileId === "npm-dev").authorizationState,
            "APPROVED",
            "unrelated manifest fields and other profiles must not invalidate the approved profile"
        );

        writeManifest(repositoryPath, {
            predev: "node changed-pre-hook.js",
            dev: "vite --host 127.0.0.1",
            start: "node changed-but-unrelated.js"
        });
        assert.strictEqual(
            service.inspect(repository).candidates.find(profile => profile.profileId === "npm-dev").authorizationState,
            "CHANGED",
            "relevant npm lifecycle changes must require authorization"
        );

        const replacedIdentity = Object.assign({}, repository, {repositoryIdentity: `sha256:${"3".repeat(64)}`});
        assert.strictEqual(
            service.inspect(replacedIdentity).candidates.find(profile => profile.profileId === "npm-dev").authorizationState,
            "CHANGED",
            "trust must not transfer to a different repository identity"
        );

        const originalTrust = "{ definitely not valid json\n";
        fs.writeFileSync(trustStorePath, originalTrust);
        inspection = service.inspect(repository);
        assert.strictEqual(inspection.trustStoreStatus, "RUN TRUST STORE INVALID");
        assert.throws(() => service.approve(repository, service.discover(repository)[0]), error => (
            error.status === "RUN TRUST STORE INVALID"
        ));
        assert.strictEqual(fs.readFileSync(trustStorePath, "utf8"), originalTrust, "malformed trust stores must be preserved");

        const outsideManifest = path.join(temporaryRoot, "outside-package.json");
        fs.writeFileSync(outsideManifest, JSON.stringify({scripts: {dev: "touch escaped"}}));
        fs.unlinkSync(path.join(repositoryPath, "package.json"));
        fs.symlinkSync(outsideManifest, path.join(repositoryPath, "package.json"));
        assert(!service.discover(repository).some(profile => profile.profileId.startsWith("npm-")), "symlinked metadata must be refused");

        const noProfilePath = path.join(temporaryRoot, "no-profile");
        fs.mkdirSync(noProfilePath);
        assert.deepStrictEqual(service.discover(Object.assign({}, repository, {canonicalPath: noProfilePath})), []);
        assert.strictEqual(fs.existsSync(marker), false);

        console.log("Repository run profile discovery, exact trust, fingerprints, and fail-closed storage passed");
    } finally {
        fs.rmSync(temporaryRoot, {recursive: true, force: true});
    }
}

run();
