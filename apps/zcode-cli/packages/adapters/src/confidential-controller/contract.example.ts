import type { PrivateControllerClient } from './contract.js';

/** Only a screened, buffered value may leave the consumer. */
export async function privateControllerExample(client: PrivateControllerClient) {
  return client.use(async ({ version }) => ({ selectedVersion: version }));
}
