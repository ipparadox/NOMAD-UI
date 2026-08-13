const {RepositoryIsolationService} = require("../classes/repositoryIsolationService.js");
const {SecurityProfileService} = require("../classes/securityProfileService.js");
const {SecurityService} = require("../classes/securityService.js");
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
        this.securityService = opts.securityService || new SecurityService(Object.assign({}, opts, {
            profileService: this.profileService,
            isolationService: this.isolationService,
            repositoryRoot
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
}

module.exports = {SecurityCliService};
