import { type ArgumentsHost, BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import * as Sentry from "@sentry/node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AllExceptionsFilter } from "./http-exception.filter";

vi.mock("@sentry/node", () => ({ captureException: vi.fn() }));

function host() {
  const reply = { status: vi.fn().mockReturnThis(), send: vi.fn() };
  const h = { switchToHttp: () => ({ getResponse: () => reply }) } as unknown as ArgumentsHost;
  return { h, reply };
}

describe("AllExceptionsFilter", () => {
  beforeEach(() => vi.mocked(Sentry.captureException).mockClear());

  it("reports an unexpected error to Sentry and answers 500 without the message", () => {
    const { h, reply } = host();
    const err = new Error('relation "users" does not exist');
    new AllExceptionsFilter().catch(err, h);
    expect(Sentry.captureException).toHaveBeenCalledWith(err);
    expect(reply.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(reply.send.mock.calls[0])).not.toContain("users");
  });

  it("does not report a client error", () => {
    const { h, reply } = host();
    new AllExceptionsFilter().catch(new BadRequestException("bad input"), h);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(400);
  });

  it("reports an HttpException that is a server error", () => {
    const { h } = host();
    new AllExceptionsFilter().catch(new ServiceUnavailableException("down"), h);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
