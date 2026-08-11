class RepositoryLauncher {
    constructor(opts) {
        if (!opts || !opts.container) throw "Missing options";

        this.container = document.getElementById(opts.container);
        this.repositoryRoot = opts.repositoryRoot;
        this.folderIcon = opts.folderIcon;
        this.onselect = opts.onselect;
    }

    _expandHome(repositoryRoot) {
        if (repositoryRoot === "~") return require("os").homedir();
        if (repositoryRoot.startsWith("~/") || repositoryRoot.startsWith("~\\")) {
            return require("path").join(require("os").homedir(), repositoryRoot.slice(2));
        }
        return repositoryRoot;
    }

    _discover() {
        const fs = require("fs");
        const path = require("path");
        const root = path.resolve(this._expandHome(this.repositoryRoot));

        let children;
        try {
            children = fs.readdirSync(root, {withFileTypes: true});
        } catch (error) {
            if (error.code === "ENOENT" || error.code === "ENOTDIR") {
                return {status: "REPOSITORY ROOT NOT FOUND", repositories: []};
            }
            throw error;
        }

        const repositories = children.reduce((results, child) => {
            const repositoryPath = path.join(root, child.name);
            try {
                if (!fs.statSync(repositoryPath).isDirectory()) return results;
                const gitMetadata = fs.statSync(path.join(repositoryPath, ".git"));
                if (gitMetadata.isDirectory() || gitMetadata.isFile()) {
                    results.push({name: child.name, path: repositoryPath});
                }
            } catch (error) {
                if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
            }
            return results;
        }, []);

        repositories.sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: "base"}));
        return {
            status: repositories.length === 0 ? "NO REPOSITORIES DETECTED" : null,
            repositories
        };
    }

    render() {
        const result = this._discover();
        this.container.replaceChildren();

        if (result.status) {
            const status = document.createElement("p");
            status.className = "repository_status";
            status.textContent = result.status;
            this.container.appendChild(status);
            return;
        }

        result.repositories.forEach(repository => {
            const entry = document.createElement("div");
            entry.className = "repository_entry";
            entry.title = repository.name;
            entry.tabIndex = 0;
            entry.setAttribute("role", "button");

            const icon = this.folderIcon.cloneNode(true);
            const name = document.createElement("h3");
            name.textContent = repository.name;
            entry.append(icon, name);

            const select = () => this.onselect(repository.path);
            entry.addEventListener("click", select);
            entry.addEventListener("keydown", event => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    select();
                }
            });
            this.container.appendChild(entry);
        });
    }

    static terminalCommand(repositoryPath, shell) {
        const shellName = require("path").basename(shell || "").toLowerCase();
        const literalPath = `'${repositoryPath.replace(/'/g, "''")}'`;
        if (shellName === "powershell" || shellName === "powershell.exe" || shellName === "pwsh" || shellName === "pwsh.exe") {
            return `Set-Location -LiteralPath ${literalPath}`;
        }

        const posixPath = `'${repositoryPath.replace(/'/g, `'\\''`)}'`;
        return `cd -- ${posixPath}`;
    }
}
