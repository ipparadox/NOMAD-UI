const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    RepositoryGitService,
    RepositoryService,
    normalizeRepositoryId
} = require("../classes/repositoryService.js");

const MAX_SETTINGS_BYTES = 1024 * 1024;

function settingsCandidates(opts = {}) {
    if (typeof opts.settingsPath === "string" && opts.settingsPath) return [opts.settingsPath];
    const home = opts.home || os.homedir();
    const environment = opts.env || process.env;
    if (process.platform === "win32") {
        const appData = environment.APPDATA || path.join(home, "AppData", "Roaming");
        return [path.join(appData, "eDEX-UI", "settings.json"), path.join(appData, "edex-ui", "settings.json")];
    }
    if (process.platform === "darwin") {
        return [
            path.join(home, "Library", "Application Support", "eDEX-UI", "settings.json"),
            path.join(home, "Library", "Application Support", "edex-ui", "settings.json")
        ];
    }
    const configRoot = environment.XDG_CONFIG_HOME || path.join(home, ".config");
    return [path.join(configRoot, "eDEX-UI", "settings.json"), path.join(configRoot, "edex-ui", "settings.json")];
}

function configuredRepositoryRoot(opts = {}) {
    if (typeof opts.repositoryRoot === "string" && opts.repositoryRoot.trim()) return opts.repositoryRoot;
    const environment = opts.env || process.env;
    if (typeof environment.NOMAD_REPOSITORY_ROOT === "string" && environment.NOMAD_REPOSITORY_ROOT.trim()) {
        return environment.NOMAD_REPOSITORY_ROOT;
    }
    for (const candidate of settingsCandidates(opts)) {
        let entry;
        try {
            entry = fs.statSync(candidate);
            if (!entry.isFile() || entry.size > MAX_SETTINGS_BYTES) throw new Error("settings file refused");
            const settings = JSON.parse(fs.readFileSync(candidate, {encoding: "utf8"}));
            if (settings && typeof settings.repositoryRoot === "string" && settings.repositoryRoot.trim()) {
                return settings.repositoryRoot;
            }
        } catch (error) {
            if (error && error.code === "ENOENT") continue;
            throw new Error("NOMAD SETTINGS INVALID");
        }
        return "~/Repositories";
    }
    return "~/Repositories";
}

class RepositoryCliService {
    constructor(opts = {}) {
        this.repositoryService = opts.repositoryService || new RepositoryService({
            repositoryRoot: configuredRepositoryRoot(opts),
            home: opts.home,
            env: opts.env,
            gitExecutable: opts.gitExecutable,
            log: opts.log
        });
        this.gitService = opts.repositoryGitService || new RepositoryGitService({
            repositoryService: this.repositoryService,
            detachedClone: false,
            log: opts.log
        });
    }

    async list() {
        const result = await this.repositoryService.refresh();
        const repositories = await Promise.all(result.repositories.map(async repository => {
            const internal = this.repositoryService.repositories.get(repository.id);
            const capability = internal ? await this.gitService.inspectUpdate(internal) : {state: "UNAVAILABLE"};
            const publicRepository = Object.assign({}, repository, {pullState: capability.state || "UNAVAILABLE"});
            delete publicRepository.githubUrl;
            return publicRepository;
        }));
        return {status: result.status, repositories};
    }

    async resolve(reference) {
        if (typeof reference !== "string" || !reference || reference.length > 255
            || /[\u0000-\u001f\u007f]/.test(reference)) throw new Error("REPOSITORY NOT FOUND");
        await this.repositoryService.refresh();
        let repositoryId = normalizeRepositoryId(reference);
        if (!repositoryId) {
            const exact = Array.from(this.repositoryService.repositories.values())
                .filter(record => record.childName === reference);
            const folded = exact.length ? exact : Array.from(this.repositoryService.repositories.values())
                .filter(record => record.childName.toLowerCase() === reference.toLowerCase());
            if (folded.length !== 1) throw new Error("REPOSITORY NOT FOUND");
            repositoryId = folded[0].id;
        }
        return this.repositoryService.resolveRepository(repositoryId, {refreshMetadata: true});
    }

    async info(reference) {
        const internal = await this.resolve(reference);
        const capability = await this.gitService.inspectUpdate(internal);
        const repository = Object.assign({}, internal.public, {pullState: capability.state || "UNAVAILABLE"});
        delete repository.githubUrl;
        return repository;
    }

    clone(repositoryUrl) {
        return this.gitService.clone(repositoryUrl);
    }

    async pull(reference) {
        const internal = await this.resolve(reference);
        return this.gitService.pull(internal);
    }
}

module.exports = {
    RepositoryCliService,
    configuredRepositoryRoot,
    settingsCandidates
};
