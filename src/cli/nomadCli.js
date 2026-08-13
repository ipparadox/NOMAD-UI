const readline = require("readline");
const {ApplicationService} = require("./applicationService.js");
const {CliError} = require("./errors.js");
const {InstallService} = require("./installService.js");
const {RepositoryCliService} = require("./repositoryCliService.js");
const {SecurityCliService} = require("./securityCliService.js");
const {
    MAX_LEARNING_TIMEOUT_MS,
    MIN_LEARNING_TIMEOUT_MS,
    WindowClassLearningService
} = require("./windowClassLearningService.js");

const GENERAL_HELP = `NOMAD CLI

USAGE
  nomad app <command> [application]
  nomad repo <command> [repository]
  nomad security <command>
  nomad install <application> [--apply]

COMMANDS
  app list                 List registered applications
  app scan                 Scan safe desktop-entry candidates
  app add <application>    Register an installed application
  app learn <application>  Learn an exact WM_CLASS from a safe first launch
  app remove <application> Remove a user application
  app info <application>   Show sanitized application status
  app reload               Validate the registry and report reload action
  repo list                List registered repositories
  repo clone <github-url>  Clone and register a safe GitHub repository
  repo info <repository>   Show local repository and Git state
  repo pull <repository>   Fetch and fast-forward a clean repository
  security status          Show factual observed security status
  security audit           Show actionable security findings
  security profile         Show or change the selected policy profile
  install <application>    Plan a catalog-backed package installation

Run 'nomad app --help', 'nomad repo --help', or 'nomad security --help' for command help.`;

const APP_HELP = `NOMAD APPLICATION MANAGEMENT

USAGE
  nomad app list
  nomad app scan
  nomad app add <application>
  nomad app learn <application> [--timeout <seconds>]
  nomad app remove <application>
  nomad app info <application> [--verbose]
  nomad app reload

Desktop IDs and friendly identifiers such as spotify or vlc are accepted.`;

const REPO_HELP = `NOMAD REPOSITORY MANAGEMENT

USAGE
  nomad repo list
  nomad repo clone <github-url>
  nomad repo info <repository>
  nomad repo pull <repository>

Only validated GitHub repository URLs and safe fast-forward updates are supported.`;

const SECURITY_HELP = `NOMAD SECURITY

USAGE
  nomad security status [--verbose]
  nomad security audit
  nomad security profile
  nomad security profile list
  nomad security profile set <normal|public|lockdown>

Profile changes apply NOMAD policy and safe user-level gates only.
No firewall, mount, boot, encryption, or privileged system setting is changed.`;

function table(headers, rows) {
    const widths = headers.map((header, column) => rows.reduce((width, row) => {
        return Math.max(width, String(row[column]).length);
    }, header.length));
    const render = row => row.map((cell, column) => String(cell).padEnd(widths[column])).join("  ").trimEnd();
    return [render(headers), render(widths.map(width => "-".repeat(width)))].concat(rows.map(render)).join("\n");
}

function defaultConfirmation(input, output) {
    return new Promise(resolve => {
        const prompt = readline.createInterface({input, output});
        prompt.question("Continue? [y/N] ", answer => {
            prompt.close();
            resolve(/^y(?:es)?$/i.test(answer.trim()));
        });
    });
}

function applicationStatus(application) {
    return application.available === false ? "UNAVAILABLE" : "AVAILABLE";
}

function parseLearnArguments(argv) {
    if (argv.length === 3) return {identifier: argv[2]};
    if (argv.length !== 5 || argv[3] !== "--timeout" || !/^\d+$/.test(argv[4])) {
        throw new CliError("USAGE: nomad app learn <application> [--timeout <seconds>]", 2);
    }
    const timeoutSeconds = Number(argv[4]);
    if (!Number.isSafeInteger(timeoutSeconds)
        || timeoutSeconds * 1000 < MIN_LEARNING_TIMEOUT_MS
        || timeoutSeconds * 1000 > MAX_LEARNING_TIMEOUT_MS) {
        throw new CliError("WINDOW CLASS LEARNING TIMEOUT MUST BE BETWEEN 3 AND 30 SECONDS", 2);
    }
    return {identifier: argv[2], timeoutMs: timeoutSeconds * 1000};
}

function renderRegistration(write, result) {
    write(result.reconciled ? "APPLICATION UPDATED"
        : result.alreadyRegistered ? "APPLICATION ALREADY REGISTERED" : "APPLICATION ADDED");
    write(`ID: ${result.application.id.toUpperCase()}`);
    write(`DESKTOP ID: ${result.candidate.desktopId}`);
    if (!result.application.windowMatchers.length) {
        write("WINDOW CLASS REQUIRED");
        write(`RUN: nomad app learn ${result.application.id}`);
    } else write(`STATUS: ${applicationStatus(result.application)}`);
    write(`REGISTRY: ${result.registryPath}`);
    write("RESTART NOMAD SESSION TO APPLY");
}

function registerInstalledApplication(write, installer, definition) {
    let registration;
    try {
        registration = installer.registerInstalled(definition);
    } catch (error) {
        write("APPLICATION REGISTRATION FAILED");
        throw error;
    }
    if (!registration) {
        write("APPLICATION REGISTRATION FAILED");
        write("DESKTOP ENTRY NOT FOUND AFTER INSTALL");
        write("RUN: nomad app scan");
        write("NO APPLICATION WAS REGISTERED");
        return false;
    }
    write("APPLICATION REGISTERED");
    renderRegistration(write, registration);
    return true;
}

async function runCli(argv, opts = {}) {
    const stdout = opts.stdout || process.stdout;
    const stderr = opts.stderr || process.stderr;
    const stdin = opts.stdin || process.stdin;
    const write = line => stdout.write(`${line}\n`);
    const writeError = line => stderr.write(`${line}\n`);
    let applicationService;
    let installService;
    let repositoryCliService;
    let securityCliService;
    let windowClassLearningService;

    const applications = () => {
        if (!applicationService) applicationService = opts.applicationService || new ApplicationService(opts);
        return applicationService;
    };
    const installer = () => {
        if (!installService) installService = opts.installService || new InstallService(Object.assign({}, opts, {
            applicationService: applications()
        }));
        return installService;
    };
    const learner = () => {
        if (!windowClassLearningService) {
            windowClassLearningService = opts.windowClassLearningService || new WindowClassLearningService(Object.assign({}, opts, {
                applicationService: applications()
            }));
        }
        return windowClassLearningService;
    };
    const repositories = () => {
        if (!repositoryCliService) repositoryCliService = opts.repositoryCliService || new RepositoryCliService(opts);
        return repositoryCliService;
    };
    const security = () => {
        if (!securityCliService) securityCliService = opts.securityCliService || new SecurityCliService(opts);
        return securityCliService;
    };

    try {
        if (!Array.isArray(argv)) throw new TypeError("CLI arguments must be an array");
        if (!argv.length || (argv.length === 1 && ["--help", "-h", "help"].includes(argv[0]))) {
            write(GENERAL_HELP);
            return 0;
        }

        if (argv[0] === "app") {
            if (argv.length === 1 || (argv.length === 2 && ["--help", "-h", "help"].includes(argv[1]))) {
                write(APP_HELP);
                return 0;
            }
            const command = argv[1];

            if (command === "list") {
                if (argv.length !== 2) throw new CliError("USAGE: nomad app list", 2);
                const rows = applications().list().map(application => [
                    application.displayName,
                    application.source,
                    applicationStatus(application)
                ]);
                write("NOMAD APPLICATION REGISTRY");
                write("");
                write(table(["ID", "SOURCE", "STATUS"], rows));
                return 0;
            }

            if (command === "scan") {
                if (argv.length !== 2) throw new CliError("USAGE: nomad app scan", 2);
                const result = applications().scan();
                write("NOMAD APPLICATION CANDIDATES");
                if (!result.candidates.length) {
                    write("");
                    write("NO SUPPORTED DESKTOP APPLICATIONS FOUND");
                }
                result.candidates.forEach(candidate => {
                    write("");
                    write(`ID: ${candidate.id}`);
                    write(`NAME: ${candidate.name}`);
                    write(`DESKTOP ID: ${candidate.desktopId}`);
                    write(`EXECUTABLE: ${candidate.executable || "NOT AVAILABLE"}`);
                    write(`STARTUP WM CLASS: ${candidate.startupWMClass || "NOT AVAILABLE"}`);
                    write(`STATUS: ${candidate.status}${candidate.reason ? ` (${candidate.reason})` : ""}`);
                });
                if (result.errors.length) write(`\nINVALID DESKTOP ENTRIES SKIPPED: ${result.errors.length}`);
                return 0;
            }

            if (command === "add") {
                if (argv.length !== 3) throw new CliError("USAGE: nomad app add <application>", 2);
                renderRegistration(write, applications().add(argv[2]));
                return 0;
            }

            if (command === "learn") {
                const learning = parseLearnArguments(argv);
                const result = await learner().learn(learning.identifier, {timeoutMs: learning.timeoutMs});
                write("WINDOW CLASS LEARNED");
                write(`APPLICATION: ${result.application.id.toUpperCase()}`);
                write(`CLASS: ${result.className}`);
                write(`INSTANCE: ${result.instance}`);
                write("APPLICATION AVAILABLE");
                write("RESTART NOMAD SESSION TO APPLY");
                return 0;
            }

            if (command === "remove") {
                if (argv.length !== 3) throw new CliError("USAGE: nomad app remove <application>", 2);
                const result = applications().remove(argv[2]);
                write("APPLICATION REMOVED");
                write(`ID: ${String(result.application.id).toUpperCase()}`);
                write(`REGISTRY: ${result.registryPath}`);
                write("RESTART NOMAD SESSION TO APPLY");
                return 0;
            }

            if (command === "info") {
                const verbose = argv.includes("--verbose");
                const operands = argv.slice(2).filter(argument => argument !== "--verbose");
                if (operands.length !== 1 || argv.some((argument, index) => index > 1 && argument.startsWith("--") && argument !== "--verbose")) {
                    throw new CliError("USAGE: nomad app info <application> [--verbose]", 2);
                }
                const application = applications().info(operands[0]);
                write("NOMAD APPLICATION INFORMATION");
                write("");
                write(`ID: ${application.id}`);
                write(`NAME: ${application.displayName}`);
                write(`SOURCE: ${application.source}`);
                write(`TYPE: ${application.type.toUpperCase()}`);
                write(`STATUS: ${applicationStatus(application)}`);
                if (application.status) write(`DETAIL: ${application.status}`);
                if (application.desktopId) write(`DESKTOP ID: ${application.desktopId}`);
                if (application.type === "external") {
                    write(`WINDOW MANAGEMENT: ${application.windowMatchers.length ? "MANAGEABLE" : "WINDOW CLASS REQUIRED"}`);
                    write(`WINDOW MATCHERS: ${JSON.stringify(application.windowMatchers || [])}`);
                }
                if (verbose && application.type === "external") {
                    write(`EXECUTABLE: ${application.executable || "NOT AVAILABLE"}`);
                    write(`ARGUMENTS: ${JSON.stringify(application.args || [])}`);
                }
                return 0;
            }

            if (command === "reload") {
                if (argv.length !== 2) throw new CliError("USAGE: nomad app reload", 2);
                const result = applications().reload();
                write("APPLICATION REGISTRY VALID");
                write(`APPLICATIONS: ${result.applications.length}`);
                write("RESTART NOMAD SESSION TO APPLY");
                return 0;
            }

            throw new CliError(`UNKNOWN APP COMMAND: ${command}\nRun 'nomad app --help'.`, 2);
        }

        if (argv[0] === "repo") {
            if (argv.length === 1 || (argv.length === 2 && ["--help", "-h", "help"].includes(argv[1]))) {
                write(REPO_HELP);
                return 0;
            }
            const command = argv[1];

            if (command === "list") {
                if (argv.length !== 2) throw new CliError("USAGE: nomad repo list", 2);
                const result = await repositories().list();
                write("NOMAD REPOSITORIES");
                if (!result.repositories.length) {
                    write("");
                    write(result.status || "NO REPOSITORIES DETECTED");
                    return 0;
                }
                write("");
                write(table(["NAME", "BRANCH", "STATUS", "PULL"], result.repositories.map(repository => [
                    repository.displayName,
                    repository.branch,
                    repository.status,
                    repository.pullState
                ])));
                return 0;
            }

            if (command === "clone") {
                if (argv.length !== 3) throw new CliError("USAGE: nomad repo clone <github-url>", 2);
                const result = await repositories().clone(argv[2]);
                if (!result || !result.ok) throw new CliError(result && result.status ? result.status : "CLONE FAILED", 1);
                write(result.status);
                return 0;
            }

            if (command === "info") {
                if (argv.length !== 3) throw new CliError("USAGE: nomad repo info <repository>", 2);
                const repository = await repositories().info(argv[2]);
                write("NOMAD REPOSITORY INFORMATION");
                write("");
                write(`ID: ${repository.id}`);
                write(`NAME: ${repository.displayName}`);
                write(`BRANCH: ${repository.branch}`);
                write(`STATUS: ${repository.status}`);
                write(`REMOTE: ${repository.remote}`);
                write(`UPSTREAM: ${repository.upstream}`);
                write(`AHEAD: ${repository.ahead === null ? "UNKNOWN" : repository.ahead}`);
                write(`BEHIND: ${repository.behind === null ? "UNKNOWN" : repository.behind}`);
                write(`PULL: ${repository.pullState}`);
                return 0;
            }

            if (command === "pull") {
                if (argv.length !== 3) throw new CliError("USAGE: nomad repo pull <repository>", 2);
                const result = await repositories().pull(argv[2]);
                if (!result || !result.ok) throw new CliError(result && result.status ? result.status : "UPDATE FAILED", 1);
                write(result.status);
                return 0;
            }

            throw new CliError(`UNKNOWN REPO COMMAND: ${command}\nRun 'nomad repo --help'.`, 2);
        }

        if (argv[0] === "security") {
            if (argv.length === 1 || (argv.length === 2 && ["--help", "-h", "help"].includes(argv[1]))) {
                write(SECURITY_HELP);
                return 0;
            }
            const command = argv[1];

            if (command === "status") {
                const verbose = argv.length === 3 && argv[2] === "--verbose";
                if (argv.length > 2 && !verbose) {
                    throw new CliError("USAGE: nomad security status [--verbose]", 2);
                }
                const result = security().status(verbose);
                const checks = new Map(result.checks.map(check => [check.id, check]));
                const rows = [["PROFILE", result.profile.id, result.profile.compliance]];
                [
                    ["repository_execution", "REPOSITORY EXEC"],
                    ["repository_isolation", "REPOSITORY ISOLATION"],
                    ["firewall", "FIREWALL"],
                    ["host_storage", "HOST STORAGE"],
                    ["automount", "AUTOMOUNT"],
                    ["disk_encryption", "DISK ENCRYPTION"],
                    ["swap", "SWAP"],
                    ["secure_boot", "SECURE BOOT"],
                    ["session_type", "SESSION"],
                    ["debug_devtools", "DEBUG / DEVTOOLS"]
                ].forEach(([id, label]) => {
                    const check = checks.get(id);
                    if (check) rows.push([label, check.actual, check.state]);
                });
                write("NOMAD SECURITY STATUS");
                write("");
                write(table(["CHECK", "ACTUAL", "STATE"], rows));
                if (result.profile.systemEnforcementPending) {
                    write("");
                    write("SYSTEM-LEVEL ENFORCEMENT PENDING");
                }
                if (verbose) {
                    write("");
                    write("OBSERVED CHECKS");
                    write("");
                    write(table(["CHECK", "STATE", "DETAIL"], result.checks.map(check => [
                        check.label, check.state, check.detail
                    ])));
                    write("");
                    write("PROFILE POLICY");
                    write("");
                    write(table(["POLICY", "DESIRED", "ACTUAL", "COMPLIANT", "ENFORCEABLE"], result.policy.map(item => [
                        item.label,
                        item.desired,
                        item.actual,
                        item.compliant === null ? "UNKNOWN" : (item.compliant ? "YES" : "NO"),
                        item.enforceable
                    ])));
                    write("");
                    write(`ISOLATION BACKEND: ${result.capabilities.preferredBackend}`);
                    write(`MAXIMUM ISOLATION: ${result.capabilities.maximumLevel}`);
                    if (result.hostStorage) {
                        write(`ROOT FILESYSTEM BACKING: ${result.hostStorage.rootBacking}`);
                        write(`REPOSITORY FILESYSTEM BACKING: ${result.hostStorage.repositoryBacking}`);
                        write(`INTERNAL MOUNTS: ${result.hostStorage.internalMountCount}`);
                        write(`REMOVABLE MOUNTS: ${result.hostStorage.removableMountCount}`);
                    }
                }
                return 0;
            }

            if (command === "audit") {
                if (argv.length !== 2) throw new CliError("USAGE: nomad security audit", 2);
                const result = security().audit();
                write("NOMAD SECURITY AUDIT");
                write("");
                if (!result.findings.length) write("NO ACTIONABLE FINDINGS");
                else write(table(["SEVERITY", "AREA", "FINDING", "REMEDIATION"], result.findings.map(finding => [
                    finding.severity, finding.label, finding.detail, finding.remediation
                ])));
                return 0;
            }

            if (command === "profile") {
                if (argv.length === 2) {
                    const result = security().profile();
                    write("NOMAD SECURITY PROFILE");
                    write("");
                    write(`PROFILE: ${result.profile}`);
                    write(`SOURCE: ${result.source}`);
                    write(`COMPLIANCE: ${result.compliance}`);
                    if (result.systemEnforcementPending) write("SYSTEM-LEVEL ENFORCEMENT PENDING");
                    return 0;
                }
                if (argv.length === 3 && argv[2] === "list") {
                    const rows = security().listProfiles().map(profile => [
                        profile.id,
                        profile.repositoryExecution,
                        profile.minimumRepositoryIsolation,
                        profile.hostStorageAccess,
                        profile.networkPolicy
                    ]);
                    write("NOMAD SECURITY PROFILES");
                    write("");
                    write(table(["PROFILE", "REPOSITORY EXEC", "MIN ISOLATION", "HOST STORAGE", "NETWORK"], rows));
                    return 0;
                }
                if (argv.length === 4 && argv[2] === "set") {
                    const result = security().setProfile(argv[3]);
                    write("PROFILE CHANGED");
                    write(`PROFILE: ${result.profile}`);
                    write(`COMPLIANCE: ${result.compliance}`);
                    if (result.systemEnforcementPending) write("SYSTEM-LEVEL ENFORCEMENT PENDING");
                    return 0;
                }
                throw new CliError("USAGE: nomad security profile [list|set <normal|public|lockdown>]", 2);
            }

            throw new CliError(`UNKNOWN SECURITY COMMAND: ${command}\nRun 'nomad security --help'.`, 2);
        }

        if (argv[0] === "install") {
            const apply = argv.includes("--apply");
            const operands = argv.slice(1).filter(argument => argument !== "--apply");
            if (operands.length !== 1 || argv.some((argument, index) => index > 0 && argument.startsWith("--") && argument !== "--apply")) {
                throw new CliError("USAGE: nomad install <application> [--apply]", 2);
            }

            const definition = installer().definition(operands[0]);
            const installedCandidate = applications().findInstalledCandidate(definition);
            if (installedCandidate) {
                write("APPLICATION ALREADY INSTALLED");
                return registerInstalledApplication(write, installer(), definition) ? 0 : 1;
            }

            const plan = installer().plan(operands[0]);
            write(`APPLICATION: ${plan.displayName}`);
            write(`SOURCE: ${plan.source}${plan.sourceDetail ? ` (${plan.sourceDetail})` : ""}`);
            write(`PACKAGE: ${plan.package}`);
            write("");
            if (plan.requiresAdministrator) write("INSTALL COMMAND REQUIRES ADMINISTRATOR PRIVILEGES");

            if (!apply) {
                write("PLAN ONLY: RUN WITH --apply TO CONTINUE");
                return 0;
            }

            const confirm = opts.confirm || (() => defaultConfirmation(stdin, stdout));
            if (!await confirm(plan)) {
                write("INSTALL CANCELLED");
                return 0;
            }

            await installer().apply(plan);
            write("INSTALL COMPLETE");
            return registerInstalledApplication(write, installer(), definition) ? 0 : 1;
        }

        throw new CliError(`UNKNOWN COMMAND: ${argv[0]}\nRun 'nomad --help'.`, 2);
    } catch (error) {
        writeError("ERROR");
        writeError(error && error.message ? error.message : "UNEXPECTED CLI FAILURE");
        return error instanceof CliError ? error.exitCode : 1;
    }
}

module.exports = {APP_HELP, GENERAL_HELP, REPO_HELP, SECURITY_HELP, runCli};
