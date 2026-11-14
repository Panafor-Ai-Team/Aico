'use client';

import { defineFixtures, single, variants } from './_helpers';

export default defineFixtures({
  identifier: 'lobe-activator',
  fixtures: {
    activateSkill: variants([
      {
        content:
          'This skill focuses on shipping UI previews fast while keeping the registry easy to extend.',
        label: 'User skill',
        pluginState: {
          description: 'A lightweight workflow for building internal preview harnesses.',
          name: 'Preview Builder',
        },
      },
      {
        // The builtin platform skill's identifier is `lobehub`; users must see a
        // product-neutral label instead.
        args: { name: 'lobehub' },
        content: 'Platform guides are now available.',
        label: 'Builtin platform skill',
        pluginState: { hasResources: true, id: 'lobehub', name: 'lobehub', source: 'builtin' },
      },
    ]),
    activateTools: single({
      // Builtin tool identifiers (`lobe-*`) must render as their localized titles.
      args: {
        identifiers: ['lobe-skill-store', 'lobe-web-browsing'],
        reason: 'Install the requested skill',
      },
      content: 'Successfully activated tools.',
      pluginState: {
        activatedTools: [
          { apiCount: 3, identifier: 'lobe-skill-store', name: 'lobe-skill-store' },
          { apiCount: 2, identifier: 'lobe-web-browsing', name: 'Web Browsing' },
        ],
        alreadyActive: [],
        notFound: ['lobe-unknown-tool'],
      },
    }),
  },
});
