//! Takes the lock named in argv[2] for this process, says whether it got
//! it, and holds it until its stdin closes: the test closes it once every
//! contender has answered.
import { acquire } from "../../src/util/lock";

const lock = acquire(process.argv[2]);
process.stdout.write(lock.ok ? "ok\n" : "refused\n");
await Bun.stdin.text();
