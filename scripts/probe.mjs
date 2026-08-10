/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */

/**
 * Builds and starts a real Daanse XMLA server for the client to talk to.
 *
 * Not a stand-in any more: the backend is the ROLAP engine over an H2 database
 * this process fills from `probe/data/sales.csv`, described by a mapping built
 * from that csv's own columns. A query against it is parsed, compiled, turned
 * into SQL, run and aggregated by the real engine - so what the client reads
 * back was computed rather than written down.
 *
 *   node scripts/probe.mjs [--port 8090] [--csv path/to/data.csv]
 *
 * Needs the Java repository built once:
 *   mvn -pl server/jdk.httpserver -am -DskipTests -Deditorconfig.skip=true install
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readSources, repoRoot } from './sync-lib.mjs';

const port = argument('--port') ?? '8090';
const contextPath = argument('--path') ?? '/xmla';
/**
 * The JDK to build and run with.
 *
 * Not simply JAVA_HOME. The Daanse artefacts in the local repository are built
 * with Java 25, and a javac older than that refuses their class files with
 * "wrong version 69.0, should be 65.0" - a message that says nothing about
 * which JDK it wanted. `PROBE_JAVA_HOME` overrides; otherwise the newest of the
 * usual locations wins, and JAVA_HOME is the last resort.
 */
const javaHome = pickJavaHome();

function pickJavaHome() {
  const named = process.env['PROBE_JAVA_HOME'];
  if (named !== undefined) {
    return named;
  }
  for (const candidate of ['/usr/lib/jvm/java-25-openjdk', '/usr/lib/jvm/java-25']) {
    if (existsSync(join(candidate, 'bin', 'javac'))) {
      return candidate;
    }
  }
  const inherited = process.env['JAVA_HOME'];
  if (inherited !== undefined) {
    console.warn(`no Java 25 found; using JAVA_HOME=${inherited}, which may be too old for the Daanse jars`);
    return inherited;
  }
  throw new Error('no JDK found - set PROBE_JAVA_HOME');
}
const csv = argument('--csv') ?? join(repoRoot, 'probe', 'data', 'sales.csv');
const sourceRoot = readSources().sourceRoot;

const classesDir = join(repoRoot, 'probe', 'classes');
const classpathFile = join(repoRoot, 'probe', 'classpath.txt');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
}

function classpath() {
  if (existsSync(classpathFile)) {
    return readFileSync(classpathFile, 'utf8').trim();
  }
  console.log('computing the classpath from the Java build...');
  const dependencies = join(repoRoot, 'probe', 'deps.txt');
  execFileSync(
    'mvn',
    [
      '-q', '-o', '-pl', 'server/jdk.httpserver', '-Deditorconfig.skip=true',
      'dependency:build-classpath', `-Dmdep.outputFile=${dependencies}`, '-Dmdep.includeScope=test',
    ],
    { cwd: sourceRoot, stdio: 'inherit', env: { ...process.env, JAVA_HOME: javaHome } },
  );
  // The project's own bundles are not dependencies of the module; they are the
  // build's output, and the probe needs the models among them.
  const own = execFileSync(
    'sh',
    ['-c', `ls ${sourceRoot}/target/project-local-repo/org.eclipse.daanse/*/0.0.1-SNAPSHOT/*.jar | grep -v -- -tests`],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .join(':');

  // The ROLAP engine, H2, the pool and the dialects, plus the connector that
  // bridges an OLAP context to XMLA. Taken from the rolap testkit module
  // because it already depends on all of it - the probe does not use the
  // testkit itself, only its dependency list.
  const rolapRoot = process.env['ROLAP_SOURCE'] ?? join(sourceRoot, '..', 'org.eclipse.daanse.rolap');
  const rolapDeps = join(repoRoot, 'probe', 'rolap-deps.txt');
  execFileSync(
    'mvn',
    [
      '-q', '-o', '-pl', 'testkit/core', '-Deditorconfig.skip=true',
      'dependency:build-classpath', `-Dmdep.outputFile=${rolapDeps}`, '-Dmdep.includeScope=test',
    ],
    { cwd: rolapRoot, stdio: 'inherit', env: { ...process.env, JAVA_HOME: javaHome } },
  );
  const connector = execFileSync(
    'sh',
    ['-c', "ls ~/.m2/repository/org/eclipse/daanse/org.eclipse.daanse.olap.xmla.connector/*/*.jar | grep -v -- -tests | head -1"],
    { encoding: 'utf8' },
  ).trim();

  const full = [readFileSync(dependencies, 'utf8').trim(), own, readFileSync(rolapDeps, 'utf8').trim(), connector]
    .filter((part) => part !== '')
    .join(':');
  writeFileSync(classpathFile, `${full}\n`);
  return full;
}

const cp = classpath();
mkdirSync(classesDir, { recursive: true });
const sources = ['DaanseProbe.java', 'CsvDatabase.java', 'CsvCatalogSupplier.java', 'CsvContext.java'].map(
  (name) => join(repoRoot, 'probe', name),
);
execFileSync(join(javaHome, 'bin', 'javac'), ['-nowarn', '-cp', cp, '-d', classesDir, ...sources], {
  stdio: 'inherit',
});

console.log(`starting the probe on ${port}${contextPath}`);
const child = spawn(
  join(javaHome, 'bin', 'java'),
  [`-Dprobe.csv=${csv}`, '-cp', `${classesDir}:${cp}`, 'DaanseProbe', port, contextPath, String(Number(port) + 1)],
  { stdio: 'inherit' },
);
process.on('SIGINT', () => child.kill('SIGINT'));
child.on('exit', (code) => process.exit(code ?? 0));
