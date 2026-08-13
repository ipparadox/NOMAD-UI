const os = require("os");
const path = require("path");
const {ApplicationPolicyService} = require("../classes/applicationPolicyService.js");
const {SecurityEnforcementService} = require("../classes/securityEnforcementService.js");
const {SecurityFirewallService} = require("../classes/securityFirewallService.js");
const {SecurityPathPolicyService} = require("../classes/securityPathPolicyService.js");
const {SecurityPermissionsService} = require("../classes/securityPermissionsService.js");
const {RepositoryIsolationService} = require("../classes/repositoryIsolationService.js");
const {SecurityProfileService} = require("../classes/securityProfileService.js");
const {SecurityService} = require("../classes/securityService.js");
const {AutomountPolicyController, SecurityStoragePolicyService} = require("../classes/securityStoragePolicyService.js");
const {configuredRepositoryRoot} = require("./repositoryCliService.js");

class SecurityCliService {
    constructor(opts = {}) {
        this.profileService = opts.profileService || new SecurityProfileService(opts);
        this.isolationService = opts.isolationService || new RepositoryIsolationService(opts);
        let repositoryRoot = opts.repositoryRoot;
        if (typeof repositoryRoot !== "string") {
            try {
                repositoryRoot = configuredRepositoryRoot(opts);
            } catch (error) {
                repositoryRoot = null;
            }
        }
        const home = opts.home || os.homedir();
        if (repositoryRoot === "~") repositoryRoot = home;
        else if (typeof repositoryRoot === "string" && repositoryRoot.startsWith("~/")) {
            repositoryRoot = path.join(home, repositoryRoot.slice(2));
        }
        const appRoot = opts.appRoot || path.resolve(__dirname, "..", "..");
        this.pathPolicyService = opts.pathPolicyService || new SecurityPathPolicyService(opts);
        this.firewallService = opts.firewallService || new SecurityFirewallService({
            env: opts.env,
            platform: opts.platform,
            spawnSync: opts.spawnSync,
            runner: opts.commandRunner,
            resolveExecutable: opts.resolveExecutable
        });
        const pathPolicy = this.pathPolicyService.resolve("NORMAL");
        this.storageService = opts.storageService || new SecurityStoragePolicyService(Object.assign({}, opts, {
            runner: opts.commandRunner,
            protectedPaths: [
                appRoot,
                repositoryRoot,
                pathPolicy.configRoot,
                pathPolicy.persistentStateRoot
            ].filter(value => typeof value === "string" && path.isAbsolute(value))
        }));
        this.automountController = opts.automountController || new AutomountPolicyController(Object.assign({}, opts, {
            runner: opts.commandRunner
        }));
        this.enforcementService = opts.enforcementService || new SecurityEnforcementService(Object.assign({}, opts, {
            profileService: this.profileService,
            firewallService: this.firewallService,
            pathPolicyService: this.pathPolicyService,
            storageService: this.storageService,
            automountController: this.automountController
        }));
        this.permissionsService = opts.permissionsService || new SecurityPermissionsService(opts);
        this.applicationPolicyService = opts.applicationPolicyService || new ApplicationPolicyService({
            getSecurityProfile: () => this.profileService.get().profile
        });
        this.securityService = opts.securityService || new SecurityService(Object.assign({}, opts, {
            profileService: this.profileService,
            isolationService: this.isolationService,
            repositoryRoot,
            appRoot,
            firewallService: this.firewallService,
            pathPolicyService: this.pathPolicyService,
            enforcementStatusProvider: () => this.enforcementService.verify()
        }));
    }

    status(verbose = false) {
        return this.securityService.status({verbose: verbose === true});
    }

    audit() {
        return this.securityService.audit();
    }

    profile() {
        return this.securityService.profile();
    }

    setProfile(profile) {
        return this.securityService.setProfile(profile);
    }

    listProfiles() {
        return this.securityService.listProfiles();
    }

    externalApplicationPolicy() {
        return this.applicationPolicyService.evaluate({id: "nomad-cli-external", type: "external"});
    }

    plan(profile, verbose = false) {
        return this.enforcementService.plan(profile, {verbose: verbose === true});
    }

    enforce(profile, authorized = false, verbose = false) {
        return this.enforcementService.apply(profile, {authorized: authorized === true, verbose: verbose === true});
    }

    verify(systemAuthorized = false) {
        return this.enforcementService.verify({systemAuthorized: systemAuthorized === true});
    }

    restore(apply = false, authorized = false) {
        return this.enforcementService.restore({apply: apply === true, authorized: authorized === true});
    }

    permissions(verbose = false) {
        return this.permissionsService.inspect(verbose === true);
    }

    repairPermissions(apply = false, authorized = false, verbose = false) {
        return this.permissionsService.repair({
            apply: apply === true,
            authorized: authorized === true,
            verbose: verbose === true
        });
    }
}

module.exports = {SecurityCliService};
