import { spawn, type ChildProcess } from "node:child_process";

type Worker = { name: string; args: string[] };
type Log = {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
};
type State = {
  worker: Worker;
  child?: ChildProcess;
  timer?: NodeJS.Timeout;
  startedAt: number;
  failures: number;
};
type Options = {
  workers: Worker[];
  logger: Log;
  shutdownMs?: number;
  restartBaseMs?: number;
  restartMaxMs?: number;
  stableMs?: number;
  spawnWorker?: (args: string[]) => ChildProcess;
};

/** Supervises direct Node children, never shell commands or background shell jobs. */
export class WorkerSupervisor {
  private readonly states: State[];
  private readonly launch: (args: string[]) => ChildProcess;
  private readonly shutdownMs: number;
  private readonly restartBaseMs: number;
  private readonly restartMaxMs: number;
  private readonly stableMs: number;
  private started = false;
  private stopping = false;
  private forced = false;
  private deadline?: NodeJS.Timeout;
  private finish!: (result: { forced: boolean }) => void;
  readonly done: Promise<{ forced: boolean }>;

  constructor(private readonly options: Options) {
    if (!options.workers.length || new Set(options.workers.map(worker => worker.name)).size !== options.workers.length)
      throw new Error("Choose at least one uniquely named worker.");
    this.states = options.workers.map(worker => ({ worker, startedAt: 0, failures: 0 }));
    this.launch = options.spawnWorker ?? (args => spawn(process.execPath, args, {
      stdio: ["ignore", "inherit", "inherit"], env: process.env, shell: false,
    }));
    this.shutdownMs = options.shutdownMs ?? 35_000;
    this.restartBaseMs = options.restartBaseMs ?? 1000;
    this.restartMaxMs = options.restartMaxMs ?? 60_000;
    this.stableMs = options.stableMs ?? 60_000;
    for (const value of [this.shutdownMs, this.restartBaseMs, this.restartMaxMs, this.stableMs])
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Worker supervision timings must be positive integers.");
    this.done = new Promise(resolve => { this.finish = resolve; });
  }

  start() {
    if (this.started || this.stopping) return;
    this.started = true;
    for (const state of this.states) this.startWorker(state);
  }

  private startWorker(state: State) {
    if (this.stopping) return;
    state.timer = undefined;
    state.startedAt = Date.now();
    let child: ChildProcess;
    try {
      child = this.launch(state.worker.args);
    } catch {
      this.options.logger.error({ event: "worker_spawn_failed", worker: state.worker.name }, "Worker could not be started.");
      this.restart(state);
      return;
    }
    state.child = child;
    child.once("spawn", () => {
      this.options.logger.info({ event: "worker_started", worker: state.worker.name, pid: child.pid }, "Worker process started.");
    });
    child.once("error", () => {
      // Do not print launch arguments or inherited configuration.
      this.options.logger.error({ event: "worker_process_error", worker: state.worker.name }, "Worker process reported a launch or signal error.");
    });
    child.once("close", (exitCode, signal) => {
      state.child = undefined;
      const fields = { event: "worker_exited", worker: state.worker.name, exitCode, signal, stopping: this.stopping };
      if (this.stopping) {
        this.options.logger.info(fields, "Worker process stopped.");
        this.finishIfStopped();
      } else {
        this.options.logger.warn(fields, "Worker exited unexpectedly; only this worker will restart.");
        this.restart(state);
      }
    });
  }

  private restart(state: State) {
    if (this.stopping) return;
    state.failures = Date.now() - state.startedAt >= this.stableMs ? 1 : state.failures + 1;
    const delayMs = Math.min(this.restartMaxMs, this.restartBaseMs * 2 ** Math.min(state.failures - 1, 16));
    this.options.logger.warn({
      event: "worker_restart_scheduled", worker: state.worker.name, delayMs, consecutiveFailures: state.failures,
    }, "Worker restart scheduled with bounded backoff.");
    state.timer = setTimeout(() => this.startWorker(state), delayMs);
  }

  stop(signal: NodeJS.Signals = "SIGTERM") {
    if (this.stopping) return this.done;
    this.stopping = true;
    this.options.logger.info({ event: "worker_supervisor_stopping", signal }, "Stopping both worker processes.");
    for (const state of this.states) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
    }
    this.deadline = setTimeout(() => {
      this.forced = true;
      for (const state of this.states) {
        if (state.child) {
          this.options.logger.error({ event: "worker_shutdown_timeout", worker: state.worker.name }, "Worker exceeded the shutdown deadline; terminating it.");
          state.child.kill("SIGKILL");
        }
      }
      this.finishIfStopped();
    }, this.shutdownMs);
    for (const state of this.states) state.child?.kill(signal);
    this.finishIfStopped();
    return this.done;
  }

  private finishIfStopped() {
    if (!this.stopping || this.states.some(state => state.child)) return;
    if (this.deadline) clearTimeout(this.deadline);
    this.finish({ forced: this.forced });
  }
}
