import { Layer } from "effect";

import { Backend } from "../../src/capabilities/backend/backend.ts";
import { Secrets } from "../../src/capabilities/secrets/secrets.ts";

const offlineFetch = (request: Request): Promise<Response> =>
  Promise.reject(new Error(`this test is not paired and must not call the backend (${request.method})`));

/**
 * The token store and backend for a CLI test that never pairs. The store is empty, and a fetch that is
 * reached fails the test: an unpaired run checks `backendUrl` before it reads a token or sends a request.
 */
export const offlineCapabilities = Layer.mergeAll(Secrets.memory({}), Backend.layer(offlineFetch));
