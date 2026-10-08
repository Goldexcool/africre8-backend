import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { BaseWsExceptionFilter } from '@nestjs/websockets';
import type { Response } from 'express';
import { ErrorCode, UNKNOWN_ERROR } from './errors.js';

const DEFAULT_CODE: Record<number, string> = {
  400: ErrorCode.Validation,
  401: ErrorCode.Unauthenticated,
  403: ErrorCode.Forbidden,
  404: ErrorCode.NotFound,
  409: ErrorCode.Conflict,
  429: ErrorCode.RateLimited,
};

const DEFAULT_MESSAGE: Record<number, string> = {
  400: "We couldn't understand that request. Please check it and try again.",
  401: 'Please sign in to continue.',
  403: "You don't have permission to do that.",
  404: "We couldn't find what you were looking for.",
  429: 'Too many attempts. Please wait a minute and try again.',
};

/** Every error leaves the API as { statusCode, message, code, errors? }. 5xx never leaks internals. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') return new BaseWsExceptionFilter().catch(exception, host);
    const req = host.switchToHttp().getRequest<{ method: string; url: string }>();
    const res = host.switchToHttp().getResponse<Response>();

    const status = statusOf(exception);
    if (status >= 500) this.log.error(`${req.method} ${req.url}`, exception instanceof Error ? exception.stack : String(exception));

    const raw = exception instanceof HttpException ? exception.getResponse() : undefined;
    const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const given = typeof raw === 'string' ? raw : Array.isArray(obj.message) ? String(obj.message[0]) : (obj.message as string | undefined);

    // Nest's own default texts ("Forbidden", "Cannot GET /x", "Validation failed (uuid is expected)") are not for users.
    const generic = status === 429 || !given || given === 'Forbidden' || given === 'Unauthorized' || given === 'Not Found' || given.startsWith('Cannot ') || given.startsWith('Validation failed (');
    const message = status >= 500 ? UNKNOWN_ERROR : generic ? (DEFAULT_MESSAGE[status] ?? UNKNOWN_ERROR) : given;
    const code = (obj.code as string | undefined) ?? (status >= 500 ? ErrorCode.Internal : (DEFAULT_CODE[status] ?? ErrorCode.Validation));

    res.status(status).json({ statusCode: status, message, code, ...(status < 500 && obj.errors ? { errors: obj.errors } : {}) });
  }
}

/** HttpException, or a 4xx raised by middleware (e.g. malformed JSON body); anything else is a 500. */
function statusOf(e: unknown): number {
  if (e instanceof HttpException) return e.getStatus();
  const s = (e as { status?: unknown; statusCode?: unknown } | null)?.status ?? (e as { statusCode?: unknown } | null)?.statusCode;
  return typeof s === 'number' && s >= 400 && s < 500 ? s : 500;
}
