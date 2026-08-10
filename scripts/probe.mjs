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
 * Everything that decides what goes on the wire is the Java project's own code -
 * the envelope, the sessions, the inline schema, the rowset serialisation. Only
 * the backend is stood in for, because standing up ROLAP with a catalog and a
 * data source is a different stack in a different repository, and this exists
 * to answer one question: does the client talk to an implementation that is not
 * itself.
 *
 *   node scripts/probe.mjs [--port 8090]
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
const javaHome = process.env['JAVA_HOME'] ?? '/usr/lib/jvm/java-25-openjdk';
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

  const full = `${readFileSync(dependencies, 'utf8').trim()}:${own}`;
  writeFileSync(classpathFile, `${full}\n`);
  return full;
}

const cp = classpath();
mkdirSync(classesDir, { recursive: true });
execFileSync(join(javaHome, 'bin', 'javac'), ['-nowarn', '-cp', cp, '-d', classesDir, join(repoRoot, 'probe', 'DaanseProbe.java')], {
  stdio: 'inherit',
});

console.log(`starting the probe on ${port}${contextPath}`);
const child = spawn(join(javaHome, 'bin', 'java'), ['-cp', `${classesDir}:${cp}`, 'DaanseProbe', port, contextPath], {
  stdio: 'inherit',
});
process.on('SIGINT', () => child.kill('SIGINT'));
child.on('exit', (code) => process.exit(code ?? 0));
