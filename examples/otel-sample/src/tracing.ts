import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";

export interface TracingOptions {
  /** Overturn API base URL, e.g. http://localhost:4000 */
  baseUrl: string;
  apiKey: string;
  serviceName?: string;
  /** Simple (synchronous) export, for tests. */
  simple?: boolean;
}

/** Standard OTel setup: an OTLP/HTTP protobuf exporter pointed at Overturn's /v1/traces. */
export function startTracing(opts: TracingOptions): NodeTracerProvider {
  const exporter = new OTLPTraceExporter({
    url: `${opts.baseUrl.replace(/\/+$/, "")}/v1/traces`,
    headers: { authorization: `Bearer ${opts.apiKey}` },
  });
  if (opts.simple) {
    // SimpleSpanProcessor calls exporter.export() on every span.end() without awaiting the
    // previous in-flight HTTP request; serialize exports so spans reach /v1/traces in end order.
    let queue = Promise.resolve();
    const rawExport = exporter.export.bind(exporter);
    exporter.export = (spans, resultCallback) => {
      queue = queue.then(
        () =>
          new Promise<void>((resolve) => {
            rawExport(spans, (res) => {
              resultCallback(res);
              resolve();
            });
          }),
      );
    };
  }
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": opts.serviceName ?? "otel-sample",
      "service.version": "1.0.0",
    }),
    spanProcessors: [opts.simple ? new SimpleSpanProcessor(exporter) : new BatchSpanProcessor(exporter)],
  });
  provider.register();
  return provider;
}
