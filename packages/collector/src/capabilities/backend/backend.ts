import {
  httpDeviceRegisterResponseSchema,
  httpDevicesResponseSchema,
  httpErrorSchema,
  httpHealthResponseSchema,
  httpPullResponseSchema,
  httpPushResponseSchema,
  type Bucket,
  type HttpDevice,
  type HttpHealthResponse,
  type HttpPullResponse
} from "@rivus/snorlax-protocol";
import { Context, Data, Duration, Effect, Layer } from "effect";
import * as z from "zod/mini";

import { errorMessage } from "../../core/error-message/error-message.ts";
import type { Ledger } from "../../modules/ledger/ledger.ts";
import { Secrets } from "../secrets/secrets.ts";
import { synchronize, type SyncInput } from "./sync.ts";

/**
 * The backend could not be reached: the request failed, timed out, or the server answered 5xx
 * (plan 3.2.1 `network`).
 */
export class BackendUnreachable extends Data.TaggedError("BackendUnreachable")<{
  readonly message: string;
}> {}

/** The token was refused (HTTP 401). A refresh turns this into sync state `revoked` and still exits 0. */
export class BackendUnauthorized extends Data.TaggedError("BackendUnauthorized")<{
  readonly message: string;
}> {}

/** The token is not allowed to do this (HTTP 403). */
export class BackendForbidden extends Data.TaggedError("BackendForbidden")<{
  readonly message: string;
}> {}

/**
 * The response is not one this client can use: any other 4xx (400, 404, 409 included — plan 3.2.4 has no
 * separate conflict failure), or a 2xx whose body does not match the interface definition.
 */
export class BackendInvalidResponse extends Data.TaggedError("BackendInvalidResponse")<{
  readonly message: string;
}> {}

export type BackendFailure = BackendUnreachable | BackendUnauthorized | BackendForbidden | BackendInvalidResponse;

/** How long one request may run, on the Effect clock, before it is aborted (plan 3.6). */
const REQUEST_TIMEOUT = Duration.seconds(15);

export type BackendFetch = (request: Request) => Promise<Response>;

const liveFetch: BackendFetch = (request) => fetch(request);

interface RawResponse {
  readonly status: number;
  readonly text: string;
}

const detail = (body: unknown, fallback: string): string => {
  const parsed = z.safeParse(httpErrorSchema, body);
  return parsed.success ? parsed.data.error.message : fallback;
};

/** Puts the status in front of the body text, so 403, 404 and 5xx stay distinct after the body parses. */
const described = (status: number, body: unknown, fallback: string): string =>
  `HTTP ${status}: ${detail(body, fallback)}`;

/** Empty text is an empty body. Text that is not JSON stays `undefined` so the status can still decide. */
const looseBody = (text: string): unknown => {
  if (text === "") {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const failureForStatus = (status: number, body: unknown): BackendFailure | undefined => {
  if (status === 401) {
    return new BackendUnauthorized({ message: described(status, body, "the backend refused the token") });
  }
  if (status === 403) {
    return new BackendForbidden({ message: described(status, body, "the backend forbade the request") });
  }
  if (status >= 500) {
    return new BackendUnreachable({ message: described(status, body, `the backend returned ${status}`) });
  }
  return undefined;
};

const parseSuccess = <S extends z.core.$ZodType>(
  raw: RawResponse,
  status: number,
  schema: S
): Effect.Effect<z.output<S>, BackendFailure> =>
  Effect.gen(function* () {
    const body = looseBody(raw.text);
    const failed = failureForStatus(raw.status, body);
    if (failed !== undefined) {
      return yield* failed;
    }
    if (raw.status !== status) {
      return yield* new BackendInvalidResponse({
        message: described(raw.status, body, `the backend returned ${raw.status}`)
      });
    }
    const parsed = z.safeParse(schema, body);
    if (!parsed.success) {
      return yield* new BackendInvalidResponse({
        message: `the backend returned ${raw.status} that does not match the interface definition: ${z.prettifyError(parsed.error)}`
      });
    }
    return parsed.data;
  });

/**
 * Joins `path` onto `baseUrl` without dropping a base path. `path` is relative (`v1/health`); a leading
 * slash would replace the base path. A base that is not a URL is a sync failure, not a defect: `config.json`
 * rejects it, and a caller that still passes one (7b `pair` included) gets `BackendUnreachable`.
 */
const endpoint = (baseUrl: string, path: string): Effect.Effect<URL, BackendUnreachable> =>
  Effect.try({
    try: () => new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`),
    catch: (error) =>
      new BackendUnreachable({
        message: `the backend URL "${baseUrl}" cannot be used: ${errorMessage(error)}`
      })
  });

/**
 * One HTTP call. The body is read before the effect completes, and the abort runs only when the call is
 * interrupted, so a successful response can still be parsed. The 15s limit is the Effect clock
 * (`Effect.timeoutOrElse`), never `AbortSignal.timeout`, so tests advance `TestClock`.
 */
const send = (
  fetchImpl: BackendFetch,
  url: string,
  method: string,
  token: string | undefined,
  json: unknown
): Effect.Effect<RawResponse, BackendUnreachable> =>
  Effect.callback<RawResponse, BackendUnreachable>((resume) => {
    const controller = new AbortController();
    const headers = new Headers();
    if (token !== undefined) {
      headers.set("authorization", `Bearer ${token}`);
    }
    let body: string | undefined;
    if (json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(json);
    }
    const finished = fetchImpl(new Request(url, { method, headers, body, signal: controller.signal })).then(
      async (response) => ({ status: response.status, text: await response.text() })
    );
    let settled = false;
    const finish = (effect: Effect.Effect<RawResponse, BackendUnreachable>): void => {
      if (!settled) {
        settled = true;
        resume(effect);
      }
    };
    void finished.then(
      (raw) => finish(Effect.succeed(raw)),
      (error: unknown) =>
        finish(Effect.fail(new BackendUnreachable({ message: `cannot reach the backend: ${errorMessage(error)}` })))
    );
    return Effect.sync(() => {
      if (!settled) {
        settled = true;
        controller.abort();
      }
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT,
      orElse: () => Effect.fail(new BackendUnreachable({ message: "the backend did not answer within 15s" }))
    })
  );

type BackendShape = {
  /** `GET /v1/health`. The route takes no token. */
  readonly health: (baseUrl: string) => Effect.Effect<HttpHealthResponse, BackendFailure>;
  /** `POST /v1/devices` with the admin token. The device token is returned once. */
  readonly registerDevice: (
    baseUrl: string,
    adminToken: string,
    device: { readonly deviceId: string; readonly name: string }
  ) => Effect.Effect<{ readonly deviceToken: string }, BackendFailure>;
  /** `PUT /v1/devices/:id/buckets`. `buckets` is 1–200 rows for this device. */
  readonly pushBuckets: (
    baseUrl: string,
    deviceToken: string,
    deviceId: string,
    buckets: readonly Bucket[]
  ) => Effect.Effect<{ readonly seq: number }, BackendFailure>;
  /** `GET /v1/buckets?after&limit`. `limit` defaults to the API maximum, 1000. */
  readonly pullBuckets: (
    baseUrl: string,
    deviceToken: string,
    after: number,
    limit?: number
  ) => Effect.Effect<HttpPullResponse, BackendFailure>;
  /** `GET /v1/devices`. */
  readonly listDevices: (baseUrl: string, deviceToken: string) => Effect.Effect<readonly HttpDevice[], BackendFailure>;
  /** `DELETE /v1/devices/:id` with the admin token. 204 has no body. */
  readonly revokeDevice: (baseUrl: string, adminToken: string, deviceId: string) => Effect.Effect<void, BackendFailure>;
};

const createClient = (fetchImpl: BackendFetch): Context.Service.Shape<typeof Backend> => ({
  health: (baseUrl) =>
    Effect.gen(function* () {
      const url = yield* endpoint(baseUrl, "v1/health");
      const raw = yield* send(fetchImpl, url.toString(), "GET", undefined, undefined);
      return yield* parseSuccess(raw, 200, httpHealthResponseSchema);
    }),
  registerDevice: (baseUrl, adminToken, device) =>
    Effect.gen(function* () {
      const url = yield* endpoint(baseUrl, "v1/devices");
      const raw = yield* send(fetchImpl, url.toString(), "POST", adminToken, device);
      const body = yield* parseSuccess(raw, 201, httpDeviceRegisterResponseSchema);
      return { deviceToken: body.deviceToken };
    }),
  pushBuckets: (baseUrl, deviceToken, deviceId, buckets) =>
    Effect.gen(function* () {
      const url = yield* endpoint(baseUrl, `v1/devices/${encodeURIComponent(deviceId)}/buckets`);
      const raw = yield* send(fetchImpl, url.toString(), "PUT", deviceToken, { buckets });
      return yield* parseSuccess(raw, 200, httpPushResponseSchema);
    }),
  pullBuckets: (baseUrl, deviceToken, after, limit = 1000) =>
    Effect.gen(function* () {
      const url = yield* endpoint(baseUrl, "v1/buckets");
      url.searchParams.set("after", String(after));
      url.searchParams.set("limit", String(limit));
      const raw = yield* send(fetchImpl, url.toString(), "GET", deviceToken, undefined);
      return yield* parseSuccess(raw, 200, httpPullResponseSchema);
    }),
  listDevices: (baseUrl, deviceToken) =>
    Effect.gen(function* () {
      const url = yield* endpoint(baseUrl, "v1/devices");
      const raw = yield* send(fetchImpl, url.toString(), "GET", deviceToken, undefined);
      const body = yield* parseSuccess(raw, 200, httpDevicesResponseSchema);
      return body.devices;
    }),
  revokeDevice: (baseUrl, adminToken, deviceId) =>
    Effect.gen(function* () {
      const url = yield* endpoint(baseUrl, `v1/devices/${encodeURIComponent(deviceId)}`);
      const raw = yield* send(fetchImpl, url.toString(), "DELETE", adminToken, undefined);
      const body = looseBody(raw.text);
      const failed = failureForStatus(raw.status, body);
      if (failed !== undefined) {
        return yield* failed;
      }
      if (raw.status !== 204) {
        return yield* new BackendInvalidResponse({
          message: described(raw.status, body, `the backend returned ${raw.status}`)
        });
      }
    })
});

/**
 * The sync HTTP client (plan 3.2.4, 3.13). One implementation: `fetch` is injected, and tests pass the
 * Worker's `app.fetch` over an in-memory database. `src/` never imports the worker, so the published bundle
 * does not contain it.
 */
export class Backend extends Context.Service<Backend, BackendShape>()("snorlax/backend/Backend") {
  static layer(fetchImpl: BackendFetch = liveFetch): Layer.Layer<Backend> {
    return Layer.succeed(Backend, Backend.of(createClient(fetchImpl)));
  }

  static readonly live: Layer.Layer<Backend> = Backend.layer();
}

export { PUSH_BATCH } from "./sync.ts";

/**
 * The sync step of a refresh or rebuild (plan 3.4.1 step 6). The caller passes the function into
 * `scanAndCommit`, because `modules/` cannot import `capabilities/` (plan 3.13 rule 1). Backend failures
 * and a keychain that cannot be read stay inside the step and become a sync report, so the snapshot is
 * still written. The `keychain` failure code is for `pair`, `unpair` and `doctor`.
 */
export const pairedSync = (input: SyncInput) =>
  Effect.gen(function* () {
    const secrets = yield* Secrets;
    const backend = yield* Backend;
    return (ledger: Ledger) => synchronize({ ...input, secrets, backend, ledger });
  });
