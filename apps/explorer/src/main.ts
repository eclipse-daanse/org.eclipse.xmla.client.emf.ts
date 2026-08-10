/*
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import { FetchTransport } from '@daanse/xmla-client';
import { bootstrapInBrowser } from '@daanse/xmla-model/browser';
import { EmftsRendererPlugin } from '@emfts/vue-registry';
import { createApp } from 'vue';

import App from './App.vue';
import { ExplorerSession } from './session.js';
import { registerXmlaWidgets } from './widgets.js';

/**
 * The app against a live server.
 *
 * The endpoint comes from the query string so this needs no build to point
 * somewhere else: `?url=http://localhost:8090/xmla`. Credentials are left to
 * the browser, which is why the transport is asked to send what it already
 * holds.
 */
const parameters = new URLSearchParams(globalThis.location.search);
const url = parameters.get('url') ?? '/xmla';

const session = new ExplorerSession({
  url,
  transport: new FetchTransport({ withCredentials: parameters.get('credentials') === 'include' }),
  models: bootstrapInBrowser(),
});

// The registry has to know the XMLType data types before anything is rendered:
// its own editors are keyed on Ecore's, and one restriction in six is not a
// string.
registerXmlaWidgets();

createApp(App, { session }).use(EmftsRendererPlugin).mount('#app');
