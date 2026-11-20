//! Runs corgi-voice's `main` as a terminal start in a process of its own,
//! for tests that end it from outside (a signal) or from within: with
//! `CV_TEST_CRASH_WHEN` naming a file, an error is thrown outside every catch
//! as soon as that file exists (whisper-server's log, say: the model is
//! loading then).
import { existsSync } from "node:fs";
import { main } from "../../src/main";

const when = process.env.CV_TEST_CRASH_WHEN;
if (when) {
  const timer = setInterval(() => {
    if (!existsSync(when)) return;
    clearInterval(timer);
    throw Error("crashed while the model loads");
  }, 10);
}
process.exit(await main(process.argv.slice(2), { terminal: true }));
