/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import type { Check, Detail, Result, Run } from './kit.js';

/**
 * The report as one self-contained HTML page.
 *
 * A matrix: one row per check, one column per server, and in each cell what
 * that server answered. Nothing is loaded from anywhere - the page is the
 * report, and it has to open the same way in a year from a build's artefacts.
 */
export function htmlReport(runs: readonly Run[], checks: readonly Check[]): string {
  const byId = new Map<string, Check>(checks.map((check) => [check.id, check]));
  // Every check any run has a result for, in the order the kit runs them.
  const ids = orderedIds(runs, checks);
  const generated = new Date().toISOString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>XMLA TCK Report</title>
<style>
${CSS}
</style>
</head>
<body>
<header>
  <h1>XMLA TCK report</h1>
  <p class="meta">@eclipse-daanse/xmla-tck · ${ids.length} checks · ${runs.length} server${runs.length === 1 ? '' : 's'} · generated ${escape(generated)}</p>
  <div class="summaries">
${runs.map(summaryCard).join('\n')}
  </div>
  <p class="legend">
    <span class="badge pass">ok</span> holds
    <span class="badge warn">warn</span> a <em>should</em> that does not hold
    <span class="badge fail">FAIL</span> a <em>must</em> that does not hold
    <span class="badge blocked">blocked</span> not asked, its prerequisite failed above
    <span class="badge skip">n/a</span> not applicable to this server
  </p>
</header>
<main>
<table>
  <thead>
    <tr>
      <th class="id">Check</th>
${runs.map((run) => `      <th class="server"><span class="name">${escape(run.profile.name)}</span><span class="url">${escape(run.profile.url)}</span></th>`).join('\n')}
    </tr>
  </thead>
  <tbody>
${rows(ids, byId, runs)}
  </tbody>
</table>
</main>
<footer>
  <p>Each check names the section of [MS-SSAS] or of XMLA 1.1 it rests on. A <em>must</em> is what the client cannot work without; a <em>should</em> is what the specification asks for and the client tolerates being without.</p>
</footer>
</body>
</html>
`;
}

function orderedIds(runs: readonly Run[], checks: readonly Check[]): string[] {
  const seen = new Set<string>();
  for (const run of runs) {
    for (const result of run.results) {
      seen.add(result.id);
    }
  }
  const ordered = checks.map((check) => check.id).filter((id) => seen.has(id));
  // Ids no check list knows, should a run come from another version: after the rest.
  for (const id of seen) {
    if (!ordered.includes(id)) {
      ordered.push(id);
    }
  }
  return ordered;
}

function rows(ids: readonly string[], byId: ReadonlyMap<string, Check>, runs: readonly Run[]): string {
  const lines: string[] = [];
  let group: string | null = null;
  for (const id of ids) {
    const anyResult = runs.flatMap((run) => run.results).find((result) => result.id === id);
    const check = byId.get(id);
    const currentGroup = check?.group ?? anyResult?.group ?? '';
    if (currentGroup !== group) {
      group = currentGroup;
      lines.push(`    <tr class="group"><th colspan="${runs.length + 1}">${escape(group)}</th></tr>`);
    }
    const title = check?.title ?? anyResult?.title ?? id;
    const level = check?.level ?? anyResult?.level ?? 'must';
    const spec = check?.spec ?? anyResult?.spec ?? '';
    lines.push('    <tr>');
    lines.push(
      `      <th class="id"><span class="code">${escape(id)}</span> <span class="level ${level}">${level}</span><div class="title">${escape(
        title,
      )}</div><div class="spec">${escape(spec)}</div></th>`,
    );
    for (const run of runs) {
      const result = run.results.find((each) => each.id === id);
      lines.push(`      <td>${result === undefined ? '<span class="badge none">–</span>' : cell(result)}</td>`);
    }
    lines.push('    </tr>');
  }
  return lines.join('\n');
}

function cell(result: Result): string {
  const outcome = result.outcome;
  const took = `<span class="took">${result.millis} ms</span>`;
  switch (outcome.status) {
    case 'pass':
      return `<span class="badge pass">ok</span>${took}${outcome.note === null ? '' : note(outcome.note)}${detailList(outcome.details)}`;
    case 'skip':
      return `<span class="badge skip">n/a</span>${took}${note(outcome.reason)}`;
    case 'blocked':
      return `<span class="badge blocked">blocked</span>${took}${note(outcome.reason)}`;
    case 'fail':
      return result.level === 'must'
        ? `<span class="badge fail">FAIL</span>${took}${note(outcome.reason)}${detailList(outcome.details)}`
        : `<span class="badge warn">warn</span>${took}${note(outcome.reason)}${detailList(outcome.details)}`;
  }
}

/**
 * The assertions inside a check, each with its own badge; the ones that did not
 * hold first, and the whole list folded unless something did not hold.
 */
function detailList(details: readonly Detail[] | undefined): string {
  if (details === undefined || details.length === 0) {
    return '';
  }
  const failed = details.filter((detail) => detail.status === 'fail');
  const passed = details.filter((detail) => detail.status === 'pass');
  const skipped = details.filter((detail) => detail.status === 'skip');
  const ordered = [...failed, ...passed, ...skipped];
  const summary = [
    `${details.length} assertion${details.length === 1 ? '' : 's'}`,
    failed.length === 0 ? null : `${failed.length} failed`,
    `${passed.length} hold`,
    skipped.length === 0 ? null : `${skipped.length} not applicable`,
  ]
    .filter((part) => part !== null)
    .join(' · ');
  const items = ordered
    .map(
      (detail) =>
        `<li><span class="badge ${detail.status === 'pass' ? 'pass' : detail.status === 'fail' ? 'fail' : 'skip'}">${
          detail.status === 'pass' ? 'ok' : detail.status === 'fail' ? 'FAIL' : 'n/a'
        }</span> <span class="dname">${escape(detail.name)}</span>${detail.note === null ? '' : `<span class="dnote">${escape(detail.note)}</span>`}</li>`,
    )
    .join('\n');
  return `<details class="assertions"${failed.length > 0 ? ' open' : ''}><summary>${escape(summary)}</summary><ul>${items}</ul></details>`;
}

/** Short notes inline; a long one folded, its first line showing. */
function note(text: string): string {
  if (text.length <= 160) {
    return `<div class="note">${escape(text)}</div>`;
  }
  return `<details class="note"><summary>${escape(`${text.slice(0, 120)}…`)}</summary><div class="full">${escape(text)}</div></details>`;
}

function summaryCard(run: Run): string {
  const { passed, failed, warned, skipped, blocked } = run.summary;
  const ran = passed + failed + warned;
  const state = run.unreachable ? 'unreachable' : failed > 0 ? 'failed' : warned > 0 ? 'warned' : 'held';
  const headline = run.unreachable ? 'unreachable' : `${passed}/${ran} held`;
  const parts: string[] = [];
  if (failed > 0) {
    parts.push(`${failed} failed`);
  }
  if (warned > 0) {
    parts.push(`${warned} warning${warned === 1 ? '' : 's'}`);
  }
  if (blocked > 0) {
    parts.push(`${blocked} blocked`);
  }
  if (skipped > 0) {
    parts.push(`${skipped} not applicable`);
  }
  const { assertions } = run.summary;
  const inside = assertions.passed + assertions.failed;
  return `    <section class="card ${state}">
      <h2>${escape(run.profile.name)}</h2>
      <p class="url">${escape(run.profile.url)}</p>
      <p class="headline">${escape(headline)}</p>
      <p class="parts">${escape(parts.join(' · ') || 'nothing to add')}</p>
      ${inside === 0 ? '' : `<p class="assertions">${assertions.passed}/${inside} assertions inside the checks hold${assertions.skipped === 0 ? '' : `, ${assertions.skipped} not applicable`}</p>`}
      <p class="when">${escape(run.startedAt)} · ${(run.millis / 1000).toFixed(1)}s</p>
    </section>`;
}

export function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CSS = `
:root {
  --bg: #ffffff; --fg: #1d1d1f; --muted: #6b7280; --line: #e5e7eb; --head: #f6f7f9;
  --pass: #15803d; --pass-bg: #dcfce7; --warn: #b45309; --warn-bg: #fef3c7;
  --fail: #b91c1c; --fail-bg: #fee2e2; --skip: #4b5563; --skip-bg: #f3f4f6;
  --blocked: #6d28d9; --blocked-bg: #ede9fe;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111214; --fg: #e5e7eb; --muted: #9ca3af; --line: #2a2d33; --head: #181a1e;
    --pass: #4ade80; --pass-bg: #14532d; --warn: #fbbf24; --warn-bg: #78350f;
    --fail: #f87171; --fail-bg: #7f1d1d; --skip: #cbd5e1; --skip-bg: #1f2937;
    --blocked: #c4b5fd; --blocked-bg: #4c1d95;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
header, main, footer { padding: 0 16px; max-width: 1400px; margin: 0 auto; }
header { padding-top: 24px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.meta, .legend, footer p { color: var(--muted); font-size: 13px; }
.summaries { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin: 16px 0; }
.card { border: 1px solid var(--line); border-left-width: 5px; border-radius: 8px; padding: 12px 14px; }
.card.held { border-left-color: var(--pass); }
.card.warned { border-left-color: var(--warn); }
.card.failed { border-left-color: var(--fail); }
.card.unreachable { border-left-color: var(--skip); }
.card h2 { font-size: 15px; margin: 0; }
.card p { margin: 2px 0; }
.card .url, .card .when { color: var(--muted); font-size: 12px; word-break: break-all; }
.card .headline { font-size: 20px; font-weight: 600; margin-top: 6px; }
.legend .badge { margin: 0 4px 0 10px; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 32px; }
th, td { border-top: 1px solid var(--line); padding: 8px 10px; vertical-align: top; text-align: left; }
thead th { background: var(--head); position: sticky; top: 0; z-index: 1; }
th.server .name { display: block; font-weight: 600; }
th.server .url { display: block; color: var(--muted); font-size: 11px; font-weight: 400; word-break: break-all; }
tr.group th { background: var(--head); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); padding-top: 14px; }
th.id { width: 34%; font-weight: 400; }
.code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 600; }
.level { font-size: 11px; border-radius: 4px; padding: 0 5px; border: 1px solid var(--line); color: var(--muted); }
.level.must { border-color: var(--fg); color: var(--fg); }
.title { margin-top: 2px; }
.spec { color: var(--muted); font-size: 12px; margin-top: 2px; }
.badge { display: inline-block; font: 600 11px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 0 7px; border-radius: 999px; }
.badge.pass { color: var(--pass); background: var(--pass-bg); }
.badge.warn { color: var(--warn); background: var(--warn-bg); }
.badge.fail { color: var(--fail); background: var(--fail-bg); }
.badge.skip { color: var(--skip); background: var(--skip-bg); }
.badge.blocked { color: var(--blocked); background: var(--blocked-bg); }
.badge.none { color: var(--muted); }
.took { margin-left: 8px; font-size: 11px; color: var(--muted); }
.card .assertions { font-size: 12px; }
.note { margin-top: 4px; font-size: 12px; color: var(--muted); word-break: break-word; }
details.assertions { margin-top: 6px; font-size: 12px; }
details.assertions summary { cursor: pointer; color: var(--muted); }
details.assertions ul { list-style: none; margin: 6px 0 0; padding: 0; max-height: 420px; overflow: auto; border: 1px solid var(--line); border-radius: 6px; }
details.assertions li { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; padding: 4px 8px; border-top: 1px solid var(--line); align-items: start; }
details.assertions li:first-child { border-top: 0; }
details.assertions .dname { font-weight: 500; word-break: break-word; }
details.assertions .dnote { grid-column: 2; color: var(--muted); white-space: pre-wrap; word-break: break-word; }
details.note summary { cursor: pointer; }
details.note .full { margin-top: 6px; white-space: pre-wrap; color: var(--fg); }
@media (max-width: 720px) {
  th.id { width: auto; }
  table, thead, tbody, tr, th, td { display: block; }
  thead { display: none; }
  tr { border-top: 1px solid var(--line); padding: 6px 0; }
  th, td { border: 0; padding: 4px 0; }
}
`;
