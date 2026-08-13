const assert = require("assert");
const {
    SecuritySecretsService,
    buildProductionEnvironment,
    inventoryEnvironment,
    isSensitiveEnvironmentKey,
    sanitizeEnvironmentInPlace
} = require("../src/classes/securityEnvironmentService.js");
const {buildRepositoryRunEnvironment} = require("../src/classes/repositoryIsolationService.js");

const source = {
    HOME: "/home/nomad",
    USER: "nomad",
    LOGNAME: "nomad",
    SHELL: "/bin/bash",
    PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    LC_TIME: "C",
    TERM: "xterm-256color",
    DISPLAY: ":0",
    XAUTHORITY: "/run/user/1000/xauth",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    XDG_RUNTIME_DIR: "/run/user/1000",
    XDG_SESSION_TYPE: "x11",
    XDG_CURRENT_DESKTOP: "NOMAD",
    I3SOCK: "/run/user/1000/i3/ipc",
    NOMAD_PRODUCTION: "1",
    GH_TOKEN: "value-must-never-cross",
    AWS_SECRET_ACCESS_KEY: "value-must-never-cross",
    SSH_AUTH_SOCK: "/run/user/1000/agent.sock",
    NODE_OPTIONS: "--require=/tmp/inject.js",
    NODE_PATH: "/tmp/inject",
    LD_PRELOAD: "/tmp/inject.so",
    PYTHONPATH: "/tmp/inject",
    DATABASE_URL: "postgres://credential",
    NPM_CONFIG_USERCONFIG: "/tmp/npmrc",
    HISTFILE: "/tmp/parent-history",
    TMPDIR: "/tmp/parent-temp",
    RANDOM_UNPROVEN_VARIABLE: "not allowlisted"
};

const before = inventoryEnvironment(source);
assert.strictEqual(before.sensitiveCount, 9);
assert(before.credentialCount >= 4);
assert(before.runtimeInjectionCount >= 5);

const sanitized = buildProductionEnvironment(source);
[
    "HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LC_TIME", "TERM", "DISPLAY",
    "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE",
    "XDG_CURRENT_DESKTOP", "I3SOCK", "NOMAD_PRODUCTION"
].forEach(key => assert.strictEqual(sanitized[key], source[key], `${key} should cross the production boundary`));
[
    "GH_TOKEN", "AWS_SECRET_ACCESS_KEY", "SSH_AUTH_SOCK", "NODE_OPTIONS", "NODE_PATH",
    "LD_PRELOAD", "PYTHONPATH", "DATABASE_URL", "NPM_CONFIG_USERCONFIG", "RANDOM_UNPROVEN_VARIABLE"
].forEach(key => assert.strictEqual(Object.prototype.hasOwnProperty.call(sanitized, key), false, `${key} must be excluded`));
assert.strictEqual(sanitized.HISTFILE, undefined, "parent history policy must not be inherited");
assert.strictEqual(sanitized.TMPDIR, undefined, "parent temporary path must not be inherited");
const restrictedTerminal = buildProductionEnvironment(source, {HISTFILE: "/dev/null", TMPDIR: "/run/user/1000/nomad/tmp"});
assert.strictEqual(restrictedTerminal.HISTFILE, "/dev/null");
assert.strictEqual(restrictedTerminal.TMPDIR, "/run/user/1000/nomad/tmp");
assert.strictEqual(inventoryEnvironment(sanitized).sensitiveCount, 0);
assert(!JSON.stringify(inventoryEnvironment(source)).includes("value-must-never-cross"));

const mutable = Object.assign({}, source);
const after = sanitizeEnvironmentInPlace(mutable);
assert.strictEqual(after.sensitiveCount, 0);
assert.deepStrictEqual(mutable, sanitized);

const repositoryEnvironment = buildRepositoryRunEnvironment(source, {
    HOME: "/tmp/home",
    TMPDIR: "/tmp/runtime"
});
assert.strictEqual(repositoryEnvironment.HOME, "/tmp/home");
assert.strictEqual(repositoryEnvironment.TMPDIR, "/tmp/runtime");
assert.strictEqual(repositoryEnvironment.GH_TOKEN, undefined);
assert.strictEqual(repositoryEnvironment.SSH_AUTH_SOCK, undefined);
assert.strictEqual(repositoryEnvironment.NODE_OPTIONS, undefined);

[
    "GH_TOKEN", "SERVICE_PASSWORD", "STRIPE_KEY", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "NODE_OPTIONS",
    "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "BUNDLE_GEMS__EXAMPLE__COM", "PIP_INDEX_URL", "CARGO_HOME"
].forEach(key => assert.strictEqual(isSensitiveEnvironmentKey(key), true, `${key} should be sensitive`));

const partialSecrets = new SecuritySecretsService({env: sanitized, userFilesAccessible: true}).observe();
assert.strictEqual(partialSecrets.state, "PARTIAL");
assert.strictEqual(partialSecrets.environmentClosed, true);
assert.strictEqual(partialSecrets.otherUserCredentialsAccessible, true);
assert(!JSON.stringify(partialSecrets).includes("/home/nomad"));

const exposedSecrets = new SecuritySecretsService({env: source, userFilesAccessible: true}).observe();
assert.strictEqual(exposedSecrets.state, "INSECURE");
assert.strictEqual(exposedSecrets.environmentClosed, false);

console.log("Production environment allowlisting, credential/runtime exclusion, repository sanitization, and value-free secrets inventory passed");
