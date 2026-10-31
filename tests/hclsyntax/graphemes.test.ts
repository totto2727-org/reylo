// Copyright (c) 2017 Martin Atkins
// SPDX-License-Identifier: MIT
// Complete Unicode 15 go-textseg/v15 v15.0.0 grapheme_clusters_test.go table.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { graphemeClusters } from '../../src/hclsyntax/scanner.ts';

interface GraphemeFixture { source: string; clusters: string[] }
const fixtures = JSON.parse(readFileSync(new URL('./grapheme-fixtures.json', import.meta.url), 'utf8')) as GraphemeFixture[];
const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8')) as { graphemes: { cases: number; version: string; unicode: string } };
for (const [index, fixture] of fixtures.entries()) test(`official Unicode 15 TestScanGraphemeClusters #${index}`, () => {
  const source = Buffer.from(fixture.source, 'base64');
  assert.deepEqual(graphemeClusters(source).map(cluster => Buffer.from(cluster)), fixture.clusters.map(cluster => Buffer.from(cluster, 'base64')));
});
test('grapheme fixture manifest retains the complete pinned Unicode table', () => {
  assert.equal(fixtures.length, manifest.graphemes.cases);
  assert.equal(manifest.graphemes.version, 'v15.0.0');
  assert.equal(manifest.graphemes.unicode, '15.0.0');
});
