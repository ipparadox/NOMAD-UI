const {runCli} = require("./nomadCli.js");
const {createNomadLog} = require("./nomadLog.js");

runCli(process.argv.slice(2), {log: createNomadLog()}).then(exitCode => {
    process.exitCode = exitCode;
}).catch(error => {
    process.stderr.write(`ERROR\n${error && error.message ? error.message : "UNEXPECTED CLI FAILURE"}\n`);
    process.exitCode = 1;
});
