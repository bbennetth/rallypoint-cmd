import type { ContentfulStatusCode } from 'hono/utils/http-status'

// Domain-error class used by handlers. Throwing one of these from any
// handler is the supported way to surface a structured 4xx/5xx response;
// the error-handler middleware converts the throw into the standard
// `{ error: { code, message, details? } }` envelope.

export class ApiError extends Error {
  readonly code: string
  readonly status: ContentfulStatusCode
  readonly details?: Record<string, unknown>

  constructor(input: {
    code: string
    message: string
    status: ContentfulStatusCode
    details?: Record<string, unknown>
  }) {
    super(input.message)
    this.code = input.code
    this.status = input.status
    if (input.details !== undefined) this.details = input.details
    this.name = 'ApiError'
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError
}

export const errors = {
  validation(details: Record<string, unknown>): ApiError {
    return new ApiError({
      code: 'validation_failed',
      message: 'Request body failed validation.',
      status: 400,
      details,
    })
  },
  bodyInvalid(): ApiError {
    return new ApiError({
      code: 'body_invalid',
      message: 'Request body was not valid JSON.',
      status: 400,
    })
  },
  sessionRequired(): ApiError {
    return new ApiError({
      code: 'session_required',
      message: 'A valid session is required.',
      status: 401,
    })
  },
  loginInvalid(): ApiError {
    return new ApiError({
      code: 'login_invalid',
      message: 'Username or password is incorrect.',
      status: 401,
    })
  },
  csrfInvalid(): ApiError {
    return new ApiError({
      code: 'csrf_token_invalid',
      message: 'CSRF token missing or did not match.',
      status: 403,
    })
  },
  forbidden(message = 'Forbidden.'): ApiError {
    return new ApiError({ code: 'forbidden', message, status: 403 })
  },
  notFound(what = 'Resource'): ApiError {
    return new ApiError({ code: 'not_found', message: `${what} not found.`, status: 404 })
  },
  conflict(code: string, message: string): ApiError {
    return new ApiError({ code, message, status: 409 })
  },
  payloadTooLarge(maxBytes: number): ApiError {
    return new ApiError({
      code: 'payload_too_large',
      message: 'Request body is too large.',
      status: 413,
      details: { max_bytes: maxBytes },
    })
  },
  rateLimited(retryAfterSeconds: number, bucket: string): ApiError {
    return new ApiError({
      code: 'rate_limited',
      message: 'Too many requests, try again later.',
      status: 429,
      details: { retry_after_seconds: retryAfterSeconds, bucket },
    })
  },
  // The game/REST layer is down or misbehaving — distinct from a panel bug.
  upstreamUnavailable(message: string): ApiError {
    return new ApiError({ code: 'upstream_unavailable', message, status: 503 })
  },
  internal(message = 'Internal error.'): ApiError {
    return new ApiError({ code: 'internal_error', message, status: 500 })
  },
} as const
