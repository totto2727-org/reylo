// oxlint-disable-next-line rules/no-node-imports, vitest/no-import-node-test -- Nub runs this suite with Node's test runner and provides the runtime used by the SQLite integration tests.
import { test } from "node:test";
// oxlint-disable-next-line rules/no-node-imports -- Nub's Node suite uses native assertions for driver, CLI, and protocol results.
import assert from "node:assert/strict";
// oxlint-disable-next-line rules/no-node-imports -- Resolve certificate and Unix socket paths as the native engine does.
import path from "node:path";
import { reason, refusedLogin, Unreachable } from "#reylo-source/connection.ts";
import { hostUrl } from "#reylo-source/host-url.ts";
import { matchesUndefined } from "#reylo-source/native-predicates.ts";
import { runChild } from "./helpers.ts";
import { mysqlStandIn } from "./mysql-stand-in.ts";
import { closeServer, knock, postgresSocket, socketFor } from "./unix-socket-fixture.ts";

const noUnixSockets = process.platform === "win32" && "Node opens no Unix socket on Windows";

const nativeError = (message: string): Error =>
  // oxlint-disable-next-line rules/require-tagged-error -- Simulate the exact untagged native socket errors consumed by the connection reporter.
  new Error(message);

const aggregateRefusal = (): AggregateError => {
  const errors = [nativeError("connect ECONNREFUSED ::1:1"), nativeError("connect ECONNREFUSED 127.0.0.1:1")];
  // oxlint-disable-next-line rules/require-tagged-error, unicorn/error-message -- The native aggregate has an empty message, so reporting must use the causes.
  return new AggregateError(errors, "");
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("reason reads a refused connection, an AggregateError with no message of its own", () => {
  const refused = Object.assign(aggregateRefusal(), { code: "ECONNREFUSED" });
  assert.equal(reason(refused), "connect ECONNREFUSED ::1:1; connect ECONNREFUSED 127.0.0.1:1");
  const timeout = Object.assign(nativeError(""), { code: "ETIMEDOUT" });
  assert.equal(reason(timeout), "ETIMEDOUT");
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the files a Postgres URL names are resolved from the working directory for the native engine", async () => {
  const { url } = await hostUrl("postgres://u@h/d?sslmode=verify-ca&sslrootcert=certs/root.pem&sslcert=%2Fabs%2Fc.pem&sslkey=k.pem&application_name=a+b");
  const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
  assert.equal(params.get("sslrootcert"), path.resolve("certs/root.pem"));
  assert.equal(params.get("sslcert"), path.resolve("/abs/c.pem"));
  assert.equal(params.get("sslkey"), path.resolve("k.pem"));
  // Every other parameter is passed on as written.
  assert.match(url, /&application_name=a\+b$/u);
  const system = await hostUrl("postgres://u@h/d?sslrootcert=system");
  assert.equal(system.url, "postgres://u@h/d?sslrootcert=system");
  const mysql = await hostUrl("mysql://root@h/d?ssl=true");
  assert.equal(mysql.url, "mysql://root@h/d?ssl=true");
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the native engine works when Node's watch dependency reporting is enabled", async () => {
  // Watch mode sets this variable. A native engine must not report modules to the parent.
  const script = `const { engine } = await import(${JSON.stringify(new URL("../src/engine.ts", import.meta.url).href)});
const c = await (await engine("sqlite")).open(":memory:");
console.log((await c.analyze("select 1 as x")).columns[0].name);
await c.close();`;
  // oxlint-disable-next-line node/no-process-env -- Reproduce Node's actual watch child environment.
  const env = { ...process.env, WATCH_REPORT_DEPENDENCIES: "1" };
  const run = await runChild(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), env, timeout: 30_000 });
  assert.equal(run.stderr, "");
  assert.equal(run.stdout.trim(), "x");
});

interface SocketObservation { connections: number }

const assertPgRejection = async (dir: string, observed: SocketObservation): Promise<void> => {
  const pg = await hostUrl(`postgres://postgres@/app?host=${dir}`);
  try {
    assert.ok(!matchesUndefined(pg.bridge) && pg.url.startsWith("postgres://postgres@127.0.0.1:"), pg.url);
    // A startup message for user postgres, as another local process would send it.
    const startup = Buffer.from("\0\0\0\u0024\0\u0003\0\0user\0postgres\0database\0app\0\0", "latin1");
    const received = await knock(pg.url, Buffer.concat([startup, startup]));
    assert.equal(received.length, 0);
    assert.equal(observed.connections, 0);
  } finally {
    pg.close();
  }
};

const loginFixture = (): Buffer => {
  const login = Buffer.alloc(36);
  login.writeUIntLE(32, 0, 3);
  login[3] = 1;
  login.writeUInt32LE(0x82_00, 4);
  return login;
};

const assertMySqlRejection = async (filename: string, standIn: Awaited<ReturnType<typeof mysqlStandIn>>): Promise<void> => {
  const mysql = await hostUrl(`mysql://root@localhost/app?socketPath=${encodeURIComponent(filename)}`);
  try {
    assert.ok(!matchesUndefined(mysql.bridge) && mysql.url.startsWith("mysql://root@127.0.0.1:"), mysql.url);
    // A login with no connection attributes, after the greeting the bridge passes on.
    const login = loginFixture();
    const greeting = await knock(mysql.url, login);
    assert.ok(greeting.length > 4 && greeting[4] === 10, "the greeting reached the client");
    // The greeting's capabilities offer no TLS, so the login that answers it is read in plain text.
    // After the protocol byte and the version, the connection id (4), the scramble's first part (8) and a filler byte.
    const capabilities = greeting.readUInt16LE(greeting.indexOf(0, 5) + 1 + 4 + 8 + 1);
    // oxlint-disable-next-line eslint/no-bitwise -- Check the TLS capability bit in the real MySQL protocol greeting.
    assert.equal(capabilities & 0x08_00, 0);
    assert.deepEqual(standIn.tried, []);
  } finally {
    mysql.close();
  }
};

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("the bridge to a Unix socket closes a connection that does not carry its token, before the server reads it", { skip: noUnixSockets }, async () => {
  const observed = { connections: 0 };
  const postgres = await postgresSocket(() => {observed.connections += 1;});
  // MySQL: the server speaks first, so the stand-in is reached, but no login reaches it.
  const standIn = await mysqlStandIn({ version: "8.4.6" });
  const my = await socketFor(`mysql://root@127.0.0.1:${standIn.port}`, "mysql.sock");
  try {
    await assertPgRejection(postgres.dir, observed);
    await assertMySqlRejection(my.filename, standIn);
  } finally {
    await Promise.all([closeServer(postgres.server), closeServer(my.server), standIn.close()]);
  }
});

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("PGHOST names the socket's directory where the URL names no host, as libpq reads it", async () => {
  // As on a system with Unix sockets: the bridge itself is a TCP server, which every system opens.
  const bridged = await hostUrl("postgres://u@/d", { PGHOST: "/var/run/postgresql", PGPORT: "5433" }, "linux");
  assert.ok(!matchesUndefined(bridged.bridge));
  assert.match(bridged.url, /^postgres:\/\/u@127\.0\.0\.1:\d+\/d$/u);
  bridged.close();
  // A host in the URL, or a TCP host in PGHOST, is no socket.
  const urlHost = await hostUrl("postgres://u@db/d", { PGHOST: "/var/run/postgresql" });
  assert.equal(urlHost.bridge, undefined);
  const environmentHost = await hostUrl("postgres://u@/d", { PGHOST: "db.internal" });
  assert.equal(environmentHost.bridge, undefined);
  // Node opens no Unix socket on Windows, so the URL is refused with what to write instead.
  await assert.rejects(hostUrl("postgres://u@/d?host=/var/run/postgresql", {}, "win32"), (error: Error) => error instanceof Unreachable && /names the Unix socket \/var\/run\/postgresql\/\.s\.PGSQL\.5432, which Node cannot open on Windows: name the server's host and port/u.test(error.message));
});

const postgresFailure = (code: string): Unreachable =>
  new Unreachable(Object.assign(nativeError("password authentication failed"), { code, severity: "FATAL" }));

// oxlint-disable-next-line typescript/no-floating-promises -- Nub's Node test runner owns this registration and observes its Promise.
test("a refused login is told apart from a server that cannot be reached, on Postgres and MySQL", () => {
  assert.ok(refusedLogin(postgresFailure("28P01")));
  assert.ok(refusedLogin(postgresFailure("28000")));
  assert.ok(!refusedLogin(postgresFailure("3D000")));
  const denied = Object.assign(nativeError("Access denied"), { code: "ER_ACCESS_DENIED_ERROR", errno: 1045 });
  const refused = Object.assign(nativeError("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  assert.ok(refusedLogin(new Unreachable(denied)));
  assert.ok(!refusedLogin(new Unreachable(refused)));
});
