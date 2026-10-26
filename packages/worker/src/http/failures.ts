import { HTTPException } from "hono/http-exception";

import type { HttpError, HttpErrorCode } from "@rivus/snorlax-protocol";

import { bucketsErrors } from "../buckets/buckets.ts";
import { devicesErrors } from "../devices/devices.ts";

/**
 * The one table from every failure to its HTTP status and error-body code (plan 3.2.4, 3.12.1 rule 3): the
 * errors the use cases throw, by `_tag`, and the failures this layer finds itself in the request. Anything
 * else is a 500 with a fixed body, the original going to the logs only.
 */

const useCaseErrors = [...devicesErrors, ...bucketsErrors] as const;
type UseCaseError = InstanceType<(typeof useCaseErrors)[number]>;

/** Failures found in the request itself, before a use case runs. */
type RequestFailure = "Unauthenticated" | "InvalidBody" | "PayloadTooLarge" | "NoRoute";

interface Answer {
  readonly status: number;
  readonly code: HttpErrorCode;
}

/** A tag without a row here fails the type check. */
const ANSWERS: { readonly [Tag in UseCaseError["_tag"] | RequestFailure | "Internal"]: Answer } = {
  InvalidBody: { status: 400, code: "invalid-body" },
  Unauthenticated: { status: 401, code: "unauthorized" },
  DeviceTokenRejected: { status: 401, code: "unauthorized" },
  ForeignDeviceWrite: { status: 403, code: "forbidden" },
  NoRoute: { status: 404, code: "not-found" },
  DeviceNotFound: { status: 404, code: "not-found" },
  DeviceAlreadyActive: { status: 409, code: "conflict" },
  PayloadTooLarge: { status: 413, code: "payload-too-large" },
  Internal: { status: 500, code: "internal" }
};

const answer = (tag: keyof typeof ANSWERS, message: string): Response => {
  const { status, code } = ANSWERS[tag];
  const body: HttpError = { error: { code, message } };
  return Response.json(body, { status });
};

/** The answer to a failure found in the request: middleware returns it, or hands it to `bearerAuth`. */
export const failureResponse = (failure: RequestFailure, message: string): Response => answer(failure, message);

const isUseCaseError = (error: unknown): error is UseCaseError =>
  useCaseErrors.some((errorClass) => error instanceof errorClass);

/** The answer to anything thrown while handling a request (`app.onError`). */
export const errorResponse = (error: unknown): Response => {
  if (isUseCaseError(error)) {
    return answer(error._tag, error.message);
  }
  if (error instanceof HTTPException) {
    // `bearerAuth` throws the 401 `failureResponse` built for it; Hono's JSON validator throws a bare 400 for
    // a body that is not JSON.
    if (error.res !== undefined) {
      return error.getResponse();
    }
    if (error.status === 400) {
      return answer("InvalidBody", error.message);
    }
  }
  console.error("snorlax-worker: internal error", error);
  return answer("Internal", "internal error");
};
