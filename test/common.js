
/* eslint-disable no-console */

const finalPM = require('../');
const tmp = require('tmp');
const path = require('path');
const fs = require('fs');
const util = require('util');
const deepEqual = require('deep-equal');
const rmdir = util.promisify(require('rmdir'));

let exitCode = 0;
let runningDaemons = new Set();
let tmpfiles  = new Set();
let appdirs  = new Set();
let daemonOut = new WeakMap();

process.on("unhandledRejection", (reason) => {
    console.error("unhandled rejection:", reason);
    exitCode = 1;
    throw reason;
});

process.prependListener("exit", (code) => {
    if (code === 0) {
        process.exit(exitCode);
    }
});

exports.daemon = async () => {
    const daemon = new finalPM.daemon();
    const output = [];

    runningDaemons.add(daemon);
    daemonOut.set(daemon, output);

    await daemon.loadBuiltins();

    daemon.on('kill', () => {
        runningDaemons.delete(daemon);
    });

    daemon.on('log', (...args) => {
        output.push(args);
    });

    return daemon;
};

exports.deepEqual = deepEqual;

exports.objectMatches = (toTest, obj) => {
    for (const [key, value] of Object.entries(obj)) {
        if (!Object.prototype.hasOwnProperty.call(toTest, key))
            return false;

        if (!exports.deepEqual(toTest[key], value))
            return false;
    }

    return true;
};

exports.matchingObjects = (array, obj) => {
    return array.filter((test) => {
        return exports.objectMatches(test, obj);
    });
};


exports.daemonWithSamples = async () => {
    const daemon = await exports.daemon();
    const samples = await exports.samples();

    samples.forEach((sample) => {
        daemon.add(sample);
    });

    return daemon;
};


exports.samples = () => {
    return exports.loadConfig(path.resolve(__dirname, '..', 'examples', 'process-config.js'));
};

exports.loadConfig = async (path) => {
    const config = await finalPM.config.getConfig(path);

    config.applications.forEach((app) => {
        // Change each applications CWD to a custom tmp dir.
        // With file-logger their log file will be in this
        // directory.
        app['cwd'] = exports.appdir();
    });

    return config.applications;
};

exports.appdir = () => {
    const dir = exports.tmpdir();
    appdirs.add(dir);
    return dir;
};

exports.tmpdir = () => {
    const dir = exports.tmp();
    fs.mkdirSync(dir);
    return dir;
};

exports.tmp = () => {
    const file = tmp.tmpNameSync();
    tmpfiles.add(file);
    return file;
};

exports.exists = util.promisify(fs.exists);
exports.readFile = util.promisify(fs.readFile);

afterEach(async function() { //eslint-disable-line no-undef
    let hadDaemon = false;
    let failed = this.currentTest.state === 'failed';
    let processes = [];
    let output = [];

    if (runningDaemons.size) {
        for (const daemon of runningDaemons.values()) {
            processes = processes.concat(daemon.info().processes);
            output = output.concat(daemonOut.get(daemon));
            await daemon.killDaemon();
        }

        hadDaemon = true;
    }

    if (failed) {
        for (const dir of appdirs.values()) {
            const logfile = path.resolve(dir, 'log.txt');

            if (await exports.exists(logfile)) {
                console.log(`--- Application log file (${logfile}) ---`);
                const contents = (await exports.readFile(logfile)).toString();
                console.log((contents.trim().length ? contents : '***empty***') + '\n');
            }
        }

        if (output.length) {
            console.log("--- Daemon output ---");

            output.forEach((args) => console.log(args.join(' | ')));

            console.log();
        }

        if (processes.length) {
            console.log("--- Remaining processes ---");

            processes.forEach((proc) => {
                console.log(`${proc['app-name']}/${proc.number} ${proc.generation} ` +
                    `crashes=${proc.crashes} id=${proc.id} pid=${proc.pid}`);
            });
        }
    }

    for (const dir of tmpfiles.values()) {
        if (dir.length < 3) // sanity check...
            continue;

        try {
            await rmdir(dir);
        } catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }

    appdirs.clear();
    tmpfiles.clear();

    if (hadDaemon && !failed) {
        throw new Error("A daemon was still running after the test");
    }
});
