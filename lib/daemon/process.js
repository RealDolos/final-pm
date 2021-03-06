const cluster = require('cluster');
const {EventEmitter} = require('events');

let idCounter = 0;

class Process extends EventEmitter {
    constructor(app, options = {}) {
        super();

        this.app = app;

        this.id = options.id || idCounter++;
        this.number = options.number || 0;
        this.crashCounter = options.crashCounter || 0;
        this.pid = -1;

        if (this.number === 'id') {
            this.number = this.id;
        }

        this.child = null;
        this.ready = false;
        this.killing = false;
        this.stopping = false;
        this.terminated = false;
        this.timeout = false;
        this.cwd = options.cwd || app['cwd'];
        this.args = options.args || app['args'] || [];

        this.generation = null;

        this.startTimeout = null;
        this.stopTimeout = null;
        this.startDelayTimeout = null;

        this.startTime = Date.now();

        if (app['type'] === 'logger') {
            this.loggerKey = JSON.stringify([app['name'], this.cwd, ...this.args]);
        } else {
            this.loggerKey = JSON.stringify([app['logger'], app['cwd'], app['logger-args']]);
        }

        if (options.startDelay) {
            this.startDelayTimeout = setTimeout(() => {
                this.startTimeout = null;
                this._createProcess();
            }, options.startDelay);

            this.startTime += options.startDelay;
        } else {
            setImmediate(() => {
                this._createProcess();
            });
        }

        Object.seal(this);
    }

    _createProcess() {
        if (this.child) return;

        this.child = createProcess(this);

        this.pid = this.child.process.pid;

        // 'close' instead of 'exit' so it always fires after
        // the last STDIO data events.
        this.child.process.on('close', this._onExit.bind(this));

        this.child.process.stdout.on('data', this._onSTDOUT.bind(this));
        this.child.process.stderr.on('data', this._onSTDERR.bind(this));

        const readyOn = this.app['ready-on'];

        if (readyOn === 'message') {
            this.child.on('message', function onMessage(message) {
                if (message !== 'ready') return;

                this.child.removeListener('message', onMessage);

                this._onReady();
            }.bind(this));
        } else {
            this.child.once('listening', this._onReady.bind(this));
        }

        this.child.on('error', this._onError.bind(this));

        this.emit('start');

        const startTimeout = this.app['start-timeout'];

        if (startTimeout === null) {
            return;
        }

        this.startTimeout = setTimeout(this._onStartTimeout.bind(this), startTimeout);
    }

    _onStartTimeout() {
        this.timeout = true;
        this.startTimeout = null;

        if (this.generation) {
            this.generation._startTimeout(this);
        }

        this.emit('timeout', 'start');
    }

    _onSTDOUT(data) {
        this.emit('output', 'stdout', data);
    }

    _onSTDERR(data) {
        this.emit('output', 'stderr', data);
    }

    _onStopTimeout() {
        this.timeout = true;
        this.stopTimeout = null;

        if (this.generation) {
            this.generation._stopTimeout(this);
        }

        this.emit('timeout', 'stop');
    }

    _onReady() {
        if (this.stopping || this.killing || this.timeout) {
            return;
        }

        if (this.startTimeout) {
            clearTimeout(this.startTimeout);
            this.startTimeout = null;
        }

        this.ready = true;

        if (this.generation) {
            this.generation._ready(this);
        }

        this.emit('ready');
    }

    _onExit(code, signal) {
        if (this.startTimeout) {
            clearTimeout(this.startTimeout);
            this.startTimeout = null;
        }

        this.terminated = true;

        if (this.generation) {
            this.generation._exit(this, code, signal);
            this.generation = null;
        }

        this.emit('exit', code, signal);
    }

    _clearTimeouts() {
        if (this.startDelayTimeout) {
            clearTimeout(this.startDelayTimeout);
            this.startDelayTimeout = null;
        }

        if (this.startTimeout) {
            clearTimeout(this.startTimeout);
            this.stopTimeout = null;
        }

        if (this.stopTimeout) {
            clearTimeout(this.stopTimeout);
            this.stopTimeout = null;
        }
    }

    _onError(error) {
        this.emit(error);
    }

    move(generation) {
        const old = this.generation;

        if (this.generation) {
            this.generation._remove(this);
        }

        this.generation = generation;

        if (this.generation) {
            this.generation._add(this);
        }

        this.emit('move', generation, old);
    }

    stop() {
        this.timeout = false;

        if (this.generation) {
            this.generation._stop(this);
        }

        this.emit('stop');
    }

    kill(signal, force) {
        this.timeout = false;

        if (this.generation) {
            this.generation._kill(this, signal, force);
        }

        this.emit('kill', signal, force);
    }

    send(message) {
        if (this.terminated) {
            return;
        }

        if (this.child) {
            return this.child.send(message);
        }

        return false;
    }

    sendStop() {
        if (this.terminated || this.stopping || this.killing) {
            return;
        }

        const signal = this.app['stop-signal'];

        this.stopping = true;

        if (this.child) {

            if (!this.ready) {
                return;
            }

            if (signal === 'disconnect') {
                this.child.disconnect();
            } else {
                this.child.process.kill(signal);
            }

            const stopTimeout = this.app['stop-timeout'];

            if (stopTimeout !== null) {
                this.stopTimeout = setTimeout(this._onStopTimeout.bind(this), stopTimeout);
            }

        } else if (this.startDelayTimeout) {

            clearTimeout(this.startDelayTimeout);
            this.startDelayTimeout = null;

            setImmediate(() => {
                this._onExit(0, signal);
            });

        } else {
            return;
        }

        this.emit('signal', signal, 'stop');
    }

    sendKill(signal, force) {
        if (this.terminated || (this.killing && !force)) {
            return;
        }

        this._clearTimeouts();

        signal = signal || this.app['kill-signal'];

        if (this.child) {
            this.child.process.kill(signal);
        } else if (!this.killing) {
            setImmediate(() => {
                this._onExit(0, signal);
            });
        }

        this.killing = true;

        this.emit('signal', signal, 'kill');
    }

    compare(other) {
        if (this.app.revision !== other.app.revision) {
            return this.app.revision - other.app.revision;
        }

        if (this.startTime !== other.startTime) {
            return this.startTime - other.startTime;
        }

        return this.id - other.id;
    }

    toString() {
        return `[Process=${this.app.name}/${this.number} id=${this.id} pid=${this.pid}]`;
    }
}

function createProcess(process) {
    const app = process.app;

    cluster.setupMaster({
        execArgv: app['node-args'],
        exec: app['run'],
        args: process.args,
        cwd: process.cwd,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });

    const env = Object.assign({}, app['env']);

    if (!app['unique-instances']) {
        Object.assign(env, {
            FINAL_PM_INSTANCE_NUMBER: process.number
        });
    }

    return cluster.fork(env);
}

module.exports = Process;
