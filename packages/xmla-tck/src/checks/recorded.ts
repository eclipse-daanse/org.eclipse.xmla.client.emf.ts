/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { EventKind, wireNameOf, XmlCursor } from '@daanse/emf-xml';
import { RowsetResolver } from '@daanse/xmla-dynamic';
import { RequestReader } from '@daanse/xmla-io';
import type { RestrictionEntry } from '@daanse/xmla-io';
import { conversations } from '@daanse/xmla-testkit';
import type { Conversation, RecordedMessage } from '@daanse/xmla-testkit';
import type { EObject } from '@emfts/core';

import { notHere, short, text } from '../kit.js';
import type { Check, Context, Sample } from '../kit.js';
import { featureByWireName, read } from '../mdx.js';

/**
 * The recorded conversations, replayed against a live server.
 *
 * Excel, Power BI and SQL Server Management Studio were captured talking to
 * SSAS: 352 requests in five conversations. Each distinct shape of request -
 * the request type, which restrictions it sets, which properties it carries -
 * becomes one check here, sent through this client to whatever server the
 * profile names, with the expectation that a server answers what a real
 * client asks.
 *
 * Sent through the client rather than byte for byte: the recorded bodies name
 * Adventure Works catalogs, cubes and hierarchies, and carry SSAS session ids.
 * So the request is read back into its parts, the names are rewritten to what
 * the target server has, and the client writes it again. What is kept is
 * everything else a real client sends - the properties SSMS and Power BI set,
 * LocaleIdentifier, the activity ids, Content and Format - which is where a
 * server that only ever met this project's own probe would differ.
 */

const MANDATORY = new Set([
  'DISCOVER_DATASOURCES',
  'DISCOVER_PROPERTIES',
  'DISCOVER_SCHEMA_ROWSETS',
  'DISCOVER_ENUMERATORS',
  'DISCOVER_KEYWORDS',
  'DISCOVER_LITERALS',
  'DBSCHEMA_CATALOGS',
  'MDSCHEMA_CUBES',
  'MDSCHEMA_DIMENSIONS',
  'MDSCHEMA_HIERARCHIES',
  'MDSCHEMA_LEVELS',
  'MDSCHEMA_MEASURES',
  'MDSCHEMA_MEMBERS',
  'MDSCHEMA_PROPERTIES',
]);

interface Shape {
  readonly conversation: Conversation;
  /** The first recorded message of this shape; the one that is replayed. */
  readonly message: RecordedMessage;
  readonly count: number;
  readonly requestType: string | null;
  readonly restrictionNames: readonly string[];
  readonly propertyNames: readonly string[];
  /** For an Execute: the statement's first words, for the title. */
  readonly statementHead: string | null;
}

function shapesOf(conversation: Conversation): Shape[] {
  const byKey = new Map<string, { message: RecordedMessage; count: number; statementHead: string | null }>();
  for (const message of conversation.messages) {
    if (message.direction !== 'request') {
      continue;
    }
    const restrictionNames = Object.keys(message.restrictions ?? {}).sort();
    const propertyNames = Object.keys(message.properties ?? {}).sort();
    let statementHead: string | null = null;
    if (message.requestType === undefined) {
      const body = conversation.text(message.file);
      const statement = /<Statement>([\s\S]*?)<\/Statement>/.exec(body)?.[1]?.trim() ?? '';
      statementHead = statement === '' ? '' : statement.replace(/\s+/g, ' ').slice(0, 40);
    }
    const key = JSON.stringify([message.requestType ?? null, restrictionNames, propertyNames, statementHead]);
    const held = byKey.get(key);
    if (held === undefined) {
      byKey.set(key, { message, count: 1, statementHead });
    } else {
      byKey.set(key, { ...held, count: held.count + 1 });
    }
  }
  return [...byKey.values()].map(({ message, count, statementHead }) => ({
    conversation,
    message,
    count,
    requestType: message.requestType ?? null,
    restrictionNames: Object.keys(message.restrictions ?? {}).sort(),
    propertyNames: Object.keys(message.properties ?? {}).sort(),
    statementHead,
  }));
}

/** The restriction, rewritten to name what the target server has; null to drop it. */
function adapt(entry: RestrictionEntry, sample: Sample): RestrictionEntry | null {
  const rewritten: Record<string, string | null> = {
    CATALOG_NAME: sample.catalog,
    TABLE_CATALOG: sample.catalog,
    DATABASE_NAME: sample.catalog,
    CUBE_NAME: sample.cube,
    PERSPECTIVE_NAME: sample.cube,
    DIMENSION_UNIQUE_NAME: sample.dimensionUniqueName,
    HIERARCHY_UNIQUE_NAME: sample.hierarchyUniqueName,
    LEVEL_UNIQUE_NAME: sample.levelUniqueName,
    MEMBER_UNIQUE_NAME: sample.memberUniqueName,
    MEASURE_UNIQUE_NAME: sample.measureUniqueName,
  };
  if (!(entry.name in rewritten)) {
    return entry;
  }
  const value = rewritten[entry.name];
  return value === null || value === undefined ? null : { name: entry.name, value };
}

/**
 * The recorded PropertyList, made fit for this server.
 *
 * The connection's own names go in place of SSAS's. And a property the server
 * does not list in DISCOVER_PROPERTIES is left out: that is what the recorded
 * clients themselves do - they read the property list first, and an SSAS 2012
 * never sees the DbpropMsmdCurrentActivityID a 2016 client would send, which is
 * why they work against it and a replay that sent everything would not.
 */
async function adaptProperties(
  context: Context,
  properties: EObject | null,
  sample: Sample,
): Promise<{ properties: EObject | null; dropped: string[] }> {
  if (properties === null) {
    return { properties: null, dropped: [] };
  }
  const { info } = await context.connected();
  const eClass = properties.eClass();
  const catalog = featureByWireName(eClass, 'Catalog');
  if (catalog !== null && properties.eIsSet(catalog)) {
    properties.eSet(catalog, sample.catalog);
  }
  const dataSourceInfo = featureByWireName(eClass, 'DataSourceInfo');
  if (dataSourceInfo !== null && properties.eIsSet(dataSourceInfo)) {
    if (info.dataSource.info === '') {
      properties.eUnset(dataSourceInfo);
    } else {
      properties.eSet(dataSourceInfo, info.dataSource.info);
    }
  }
  const dropped: string[] = [];
  for (const feature of eClass.getEAllStructuralFeatures()) {
    if (!properties.eIsSet(feature)) {
      continue;
    }
    const name = wireNameOf(feature);
    if (!info.properties.has(name)) {
      properties.eUnset(feature);
      dropped.push(name);
    }
  }
  return { properties, dropped };
}

function moveTo(cursor: XmlCursor, names: readonly string[]): string | null {
  let kind = cursor.next();
  while (kind !== null) {
    if (kind === EventKind.START && names.includes(cursor.localName)) {
      return cursor.localName;
    }
    kind = cursor.next();
  }
  return null;
}

function checkFor(shape: Shape, id: string): Check {
  const { conversation, message, count, requestType } = shape;
  const what =
    requestType !== null
      ? `${requestType}${shape.restrictionNames.length === 0 ? '' : ` [${shape.restrictionNames.join(', ')}]`}`
      : shape.statementHead === ''
        ? 'Execute <Statement/>'
        : `Execute ${JSON.stringify(shape.statementHead)}…`;
  const properties = shape.propertyNames.length === 0 ? 'no properties' : `${shape.propertyNames.length} properties`;
  return {
    id,
    group: 'recorded',
    title: `${conversation.name}: ${what}, ${properties} · ${count} recorded`,
    level: requestType !== null && MANDATORY.has(requestType) ? 'must' : 'should',
    spec: `Recorded ${conversation.recording}, message ${message.position} (${message.file}): what this client asked SSAS, asked of this server`,
    async run(context) {
      const xml = conversation.text(message.file);
      const cursor = XmlCursor.parse(xml);
      const element = moveTo(cursor, ['Discover', 'Execute']);
      if (element === null) {
        throw new Error('the recording carries neither a Discover nor an Execute');
      }
      const reader = new RequestReader(context.models);
      const sample = await context.sample();
      const { client } = await context.connected();

      if (element === 'Discover') {
        const request = reader.readDiscover(cursor);
        const declared = new Set((await context.schemaRowsets()).rows.map((row) => text(row, 'SchemaName')));
        if (!declared.has(request.requestType)) {
          notHere(`this server does not declare ${request.requestType}`);
        }
        const dropped: string[] = [];
        const restrictions: RestrictionEntry[] = [];
        for (const entry of request.restrictions) {
          const adapted = adapt(entry, sample);
          if (adapted === null) {
            dropped.push(entry.name);
          } else {
            restrictions.push(adapted);
          }
        }
        const { properties, dropped: unlisted } = await adaptProperties(context, request.properties, sample);
        const answer = await client.discoverRaw(request.requestType, restrictions, properties);
        const schema = client.schemaOf(answer);
        const resolved = new RowsetResolver(context.catalog, context.profile.url).resolve(request.requestType, schema);
        const rows = client.readRows(answer, resolved.rowClass).rows;
        const columns = [...resolved.rowClass.getEAllStructuralFeatures()].map((feature) => wireNameOf(feature)).length;
        return `${rows.length} row(s), ${columns} columns${schema === null ? ', no inline schema' : ''}${
          dropped.length === 0 ? '' : `; dropped ${dropped.join(', ')}: the target cube has no such thing`
        }${unlisted.length === 0 ? '' : `; left out ${unlisted.join(', ')}: not in this server's DISCOVER_PROPERTIES`}`;
      }

      const request = reader.readExecute(cursor);
      if (request.commandName !== 'Statement' || request.command === null) {
        notHere(`the recording carries a ${request.commandName ?? 'command-less'} Execute, which is not a statement`);
      }
      const statementFeature = request.command.eClass().getEStructuralFeature('statement');
      const statement =
        statementFeature === null || statementFeature === undefined || !request.command.eIsSet(statementFeature)
          ? ''
          : String(request.command.eGet(statementFeature) ?? '').trim();
      if (statement === '') {
        notHere('an empty statement: the session bookkeeping S1 to S3 cover');
      }
      if (!/^\s*SELECT\s[\s\S]*\$SYSTEM\./i.test(statement)) {
        notHere(`a statement against the recorded server's own cubes: ${short(statement.replace(/\s+/g, ' '), 60)}`);
      }
      const { properties, dropped: unlisted } = await adaptProperties(context, request.properties, sample);
      // Power BI sends its DMV statements with parameters - @CubeName in the
      // text, the value in a <Parameters> block this client does not write.
      // The value is put into the text instead, quoted as a DMV wants it.
      const parameters: Record<string, string> = { CubeName: sample.cube, CatalogName: sample.catalog };
      let substituted = 0;
      const rewritten = statement.replace(/@(\w+)/g, (whole, name: string) => {
        const value = parameters[name];
        if (value === undefined) {
          return whole;
        }
        substituted += 1;
        return `'${value.replace(/'/g, "''")}'`;
      });
      if (/@\w+/.test(rewritten)) {
        notHere(`a statement with a parameter this kit cannot value: ${/@\w+/.exec(rewritten)![0]}`);
      }
      const command = request.command;
      if (substituted > 0 && statementFeature !== null && statementFeature !== undefined) {
        command.eSet(statementFeature, rewritten);
      }
      const answer = read(context, await client.execute(command, properties));
      if (answer.readError !== null) {
        throw new Error(`answered, but the answer does not read: ${answer.readError}`);
      }
      return `${answer.tabular ? 'a rowset' : 'a dataset'}, ${answer.cellset?.cells.length ?? 0} cell(s)${
        substituted === 0 ? '' : `; ${substituted} parameter(s) put into the text`
      }${unlisted.length === 0 ? '' : `; left out ${unlisted.join(', ')}: not in this server's DISCOVER_PROPERTIES`}`;
    },
  };
}

/** One check per distinct shape of recorded request, per conversation. */
export const recorded: readonly Check[] = conversations().flatMap((conversation, conversationIndex) =>
  shapesOf(conversation).map((shape, index) =>
    checkFor(shape, `V${conversationIndex + 1}.${String(index + 1).padStart(2, '0')}`),
  ),
);
