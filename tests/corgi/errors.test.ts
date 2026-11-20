import { test, expect } from "bun:test";
import { reasonFor, notFound, no_answer, mapping, ssh_patterns } from "../../src/corgi/errors";

test("missing panes read as pane gone", () => {
  for (const name of ["NoPane", "PaneExited", "NoSuchPane"]) {
    expect(reasonFor(`corgi: ${name}\n`, "local", 2)).toBe("pane gone");
    expect(reasonFor(name, "marovo", 1)).toBe("pane gone");
  }
});

test("machine failures name the machine as unreachable", () => {
  for (const name of ["UnknownMachine", "RequestTimedOut", "ConnectionRefused", "NoRuntime"])
    expect(reasonFor(`corgi: ${name}\n`, "marovo", 1)).toBe("marovo unreachable");
  expect(reasonFor("ssh: connect to host marovo port 22: Connection refused\n", "marovo", 255)).toBe(
    "marovo unreachable",
  );
  expect(reasonFor("corgi: NoRuntime\n", "local", 1)).toBe("local unreachable");
  // What ssh prints when it cannot log in.
  expect(
    reasonFor(
      'sign_and_send_pubkey: signing failed for ED25519 "/x" from agent\nroland@marovo: Permission denied (publickey).\n',
      "marovo",
      255,
    ),
  ).toBe("marovo unreachable");
  expect(reasonFor("ssh: Could not resolve hostname marovo: nodename nor servname provided\n", "marovo", 255)).toBe(
    "marovo unreachable",
  );
});

test("the experimental notice before the error is skipped", () => {
  const notice = "Remote machines are experimental; bug reports are appreciated (corgi bugreport).\n";
  expect(reasonFor(notice + "corgi: NoPane\n", "marovo", 2)).toBe("pane gone");
  expect(reasonFor(notice + "corgi: Bogus thing\n", "marovo", 1)).toBe("Bogus thing");
  expect(reasonFor(notice, "marovo", 3)).toBe("corgi exited with code 3");
});

test("anything else is its first line without the corgi: prefix, at most 60 columns", () => {
  expect(reasonFor("corgi: InvalidPaneId\nmore detail\n", "local", 2)).toBe("InvalidPaneId");
  expect(reasonFor("something odd happened\n", "local", 1)).toBe("something odd happened");
  const long = "corgi: " + "x".repeat(100);
  const reason = reasonFor(long, "local", 1);
  expect(Bun.stringWidth(reason)).toBe(60);
  expect(reason.endsWith("…")).toBe(true);
  // Controls never reach the history.
  expect(reasonFor("bad\x1b[31m red\n", "local", 1)).toBe("bad [31m red");
});

test("empty output with a non-zero exit says the code", () => {
  expect(reasonFor("", "local", 1)).toBe("corgi exited with code 1");
  expect(reasonFor("  \n\n", "local", 7)).toBe("corgi exited with code 7");
  expect(reasonFor("", "local", null)).toBe("corgi exited with a signal");
});

test("the fixed reasons", () => {
  expect(no_answer).toBe("no answer in time; may have been typed");
  expect(notFound("/opt/corgi")).toBe("corgi not found: /opt/corgi");
});

test("the error table lives in one constant", () => {
  expect(Object.keys(mapping).sort()).toEqual(
    ["ConnectionRefused", "NoPane", "NoRuntime", "NoSuchPane", "PaneExited", "RequestTimedOut", "UnknownMachine"].sort(),
  );
});

test("every ssh pattern is covered, each on a line of its own", () => {
  const samples = [
    "ssh: connect to host marovo port 22: Operation timed out",
    "user@marovo: Permission denied (publickey).",
    "ssh: Could not resolve hostname marovo: nodename nor servname provided",
    "Could not resolve hostname marovo: Name or service not known",
    "Connection timed out during banner exchange",
    "Connection refused by 10.0.0.5",
    "Connection closed by 10.0.0.5 port 22",
    "Host key verification failed.",
    "sign_and_send_pubkey: signing failed for ED25519",
  ];
  for (const sample of samples) expect(reasonFor(`${sample}\n`, "marovo", 255)).toBe("marovo unreachable");
  // No pattern goes untested: each matches a sample that does not start with "ssh:" where it can.
  for (const pattern of ssh_patterns) expect(samples.some(s => pattern.test(s))).toBe(true);
  for (const pattern of ssh_patterns.filter(p => p.source !== "^ssh:"))
    expect(samples.some(s => !s.startsWith("ssh:") && pattern.test(s))).toBe(true);
});
