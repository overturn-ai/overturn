import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import * as Sentry from "@sentry/node";
import type { FastifyReply } from "fastify";

/**
 * This filter answers every exception itself, so nothing ever reaches Sentry's own handlers:
 * an unexpected error has to be reported here or it is only a log line. A no-op when Sentry
 * was not initialised.
 */
function report(exception: unknown): void {
  Sentry.captureException(exception);
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("Http");

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status >= 500) report(exception);
      const body = exception.getResponse();
      const payload =
        typeof body === "string"
          ? { statusCode: status, error: exception.name, message: body }
          : { statusCode: status, error: exception.name, ...(body as Record<string, unknown>) };
      void reply.status(status).send(payload);
      return;
    }
    report(exception);
    this.logger.error(
      exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
    );
    void reply
      .status(500)
      .send({ statusCode: 500, error: "Internal Server Error", message: "Internal server error" });
  }
}
