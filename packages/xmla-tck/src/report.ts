/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import type { Check, Result, Run } from './kit.js';

/**
 * The report, as text for a terminal and as JSON for whatever reads it next.
 *
 * Both say the same things. The text is for someone watching; the JSON is
 * for a build that keeps the run and diffs it against the last one.
 */

/**
 * One line per result, as the run prints it while it goes - and, for a check
 * that stands for many assertions, the ones that did not hold beneath it.
 */
export function line(result: Result): string {
  const id = result.id.padEnd(5);
  switch (result.outcome.status) {
    case 'pass':
      return `  ok    ${id} ${result.title}${result.outcome.note === null ? '' : ` — ${result.outcome.note}`}`;
    case 'skip':
      return `  --    ${id} ${result.title}: ${result.outcome.reason}`;
    case 'blocked':
      return `  !!    ${id} ${result.title}: ${cut(result.outcome.reason)}`;
    case 'fail': {
      const head =
        result.level === 'must'
          ? `  FAIL  ${id} ${result.title}: ${cut(result.outcome.reason)}\n        ${result.spec}`
          : `  warn  ${id} ${result.title}: ${cut(result.outcome.reason)}\n        ${result.spec}`;
      const failed = (result.outcome.details ?? []).filter((detail) => detail.status === 'fail');
      if (failed.length === 0) {
        return head;
      }
      const shown = failed.slice(0, 12).map((detail) => `          · ${detail.name}${detail.note === null ? '' : `: ${cut(detail.note, 200)}`}`);
      if (failed.length > 12) {
        shown.push(`          · … and ${failed.length - 12} more`);
      }
      return `${head}\n${shown.join('\n')}`;
    }
  }
}

/** A terminal line's worth. The JSON keeps the whole reason. */
function cut(reason: string, length = 400): string {
  return reason.length > length ? `${reason.slice(0, length)}…` : reason;
}

export function summaryLine(run: Run): string {
  if (run.unreachable) {
    return `${run.profile.name}: unreachable at ${run.profile.url}`;
  }
  const { passed, failed, warned, skipped, blocked } = run.summary;
  const ran = passed + failed + warned;
  const parts = [`${passed}/${ran} held`];
  if (failed > 0) {
    parts.push(`${failed} failed`);
  }
  if (warned > 0) {
    parts.push(`${warned} warning${warned === 1 ? '' : 's'}`);
  }
  if (blocked > 0) {
    parts.push(`${blocked} blocked by a failure above`);
  }
  if (skipped > 0) {
    parts.push(`${skipped} not applicable to this server`);
  }
  const { assertions } = run.summary;
  const inside = assertions.passed + assertions.failed;
  if (inside > 0) {
    parts.push(`${assertions.passed}/${inside} assertions inside them`);
  }
  return `${run.profile.name}: ${parts.join(', ')} (${(run.millis / 1000).toFixed(1)}s)`;
}

/** The whole run as text, grouped as the checks are. */
export function textReport(run: Run): string {
  const lines = [`${run.profile.name} — ${run.profile.url}`, ''];
  let group: string | null = null;
  for (const result of run.results) {
    if (result.group !== group) {
      group = result.group;
      lines.push(`${group}`);
    }
    lines.push(line(result));
  }
  lines.push('', summaryLine(run));
  return lines.join('\n');
}

/** The checks themselves, for `--list`: what would be asked, and on whose authority. */
export function listing(checks: readonly Check[]): string {
  const lines: string[] = [];
  let group: string | null = null;
  for (const check of checks) {
    if (check.group !== group) {
      group = check.group;
      lines.push(`${group}`);
    }
    lines.push(`  ${check.id.padEnd(5)} ${check.level.padEnd(6)} ${check.title}`);
    lines.push(`       ${check.spec}`);
  }
  return lines.join('\n');
}

export function jsonReport(runs: readonly Run[]): string {
  return JSON.stringify({ tck: '@eclipse-daanse/xmla-tck', runs }, null, 2);
}
