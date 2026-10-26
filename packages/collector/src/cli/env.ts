import { Context } from "effect";

/** A byte sink; `process.stdout` and `process.stderr` satisfy it, tests capture it. */
export interface Sink {
  write(text: string): void;
}

/**
 * The output destinations the CLI framework writes to, injected so tests capture what a command
 * prints. `colors` says whether the destination stream takes ANSI color (a TTY without `NO_COLOR`);
 * human text is plain when it is false.
 */
export class CliEnv extends Context.Service<
  CliEnv,
  {
    readonly stdout: Sink;
    readonly stderr: Sink;
    readonly colors: boolean;
    /**
     * The whole stdin, when a test injects it. Absent, `runCli` reads `process.stdin` when `pair` asks for
     * the admin token. The promise starts only then.
     */
    readonly stdin?: string;
  }
>()("snorlax/cli/CliEnv") {}
