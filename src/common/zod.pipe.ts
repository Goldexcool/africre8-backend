import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { ErrorCode } from './errors.js';

export class ZodPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      throw new BadRequestException({
        message: 'Please check your details and try again.',
        code: ErrorCode.Validation,
        errors: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return r.data;
  }
}
