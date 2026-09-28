import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from 'storybook/internal/node-logger';
import type { WebComponentsDocgenPayload } from '../../../../renderers/web-components/src/docgen/index.ts';
import { recordArgTypesSnapshot } from '../compare/record-argtypes-snapshot.ts';
import { BASELINE_PATH } from './baseline-path.ts';
import { entryForFixture, runProvider } from './osa-provider.ts';

if (BASELINE_PATH !== 'legacy') {
  throw new Error(
    'web-components-osa-baselines.test.ts gates the server recorder against the legacy runtime baselines; update the recorder or baseline-path.ts'
  );
}

vi.mock('storybook/internal/node-logger', { spy: true });

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '__testfixtures__');

const fixtureCases = readdirSync(fixturesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const readCommitted = (path: string): string | undefined =>
  existsSync(path) ? readFileSync(path, 'utf8') : undefined;

const VARIANTS = [
  { manifest: 'custom-elements.json', osaPrefix: 'osa-', legacyPrefix: '' },
  { manifest: 'custom-elements.v2.json', osaPrefix: 'osa-v2-', legacyPrefix: 'v2-' },
] as const;

beforeEach(() => {
  vi.mocked(logger.warn).mockImplementation(() => {});
  vi.mocked(logger.debug).mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const withoutArgTypes = (payload: WebComponentsDocgenPayload | undefined) => {
  if (!payload) {
    return payload;
  }
  const { argTypes: _argTypes, ...rest } = payload;
  return rest;
};

const hiddenMemberNames = (payload: WebComponentsDocgenPayload): ReadonlySet<string> => {
  const declaration = payload.customElementsManifest?.declaration;
  return new Set(
    (declaration?.members ?? [])
      .filter(
        (member) =>
          member.privacy === 'private' || member.privacy === 'protected' || member.static === true
      )
      .flatMap((member) => (typeof member.name === 'string' ? [member.name] : []))
  );
};

describe('web-components server-side docgen baselines', () => {
  it.each(fixtureCases)('%s', async (fixtureCase) => {
    const testDir = join(fixturesDir, fixtureCase);
    const entry = entryForFixture(fixtureCase, testDir);

    for (const [index, { manifest, osaPrefix, legacyPrefix }] of VARIANTS.entries()) {
      const manifestPath = join(testDir, manifest);
      if (!existsSync(manifestPath)) {
        continue;
      }

      const payload = (await runProvider(testDir, entry, manifestPath)) as
        | WebComponentsDocgenPayload
        | undefined;

      expect(payload, `${fixtureCase}: no OSA payload recorded`).toBeDefined();
      expect(JSON.stringify(withoutArgTypes(payload))).not.toContain(testDir);
      const argTypes = payload?.argTypes;
      expect(argTypes, `${fixtureCase}: no OSA argTypes recorded`).toBeDefined();

      const legacyArgTypesPath = join(testDir, `${legacyPrefix}argtypes.snapshot`);
      const committedLegacyArgTypes = readCommitted(legacyArgTypesPath);
      expect(committedLegacyArgTypes, `missing legacy ${legacyArgTypesPath}`).toBeDefined();
      await recordArgTypesSnapshot({
        path: join(testDir, `${osaPrefix}argtypes.snapshot`),
        label: `${fixtureCase}/${osaPrefix}argtypes.snapshot`,
        candidate: argTypes!,
        extraGates: [
          {
            committed: committedLegacyArgTypes!,
            label: `${fixtureCase}/${legacyPrefix}argtypes.snapshot`,
            legacyBaseline: true,
            legacyManifestRuntime: true,
            waivedArgs: hiddenMemberNames(payload!),
          },
        ],
      });

      await expect(withoutArgTypes(payload)).toMatchFileSnapshot(
        join(testDir, `${osaPrefix}payload.snapshot`)
      );

      if (index === 0) {
        await expect(payload?.description ?? '').toMatchFileSnapshot(
          join(testDir, 'osa-description.snapshot')
        );
      }
    }
  });
});
