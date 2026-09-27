import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Meter, MeterProvider, MeterOptions } from "@opentelemetry/api";
import { createMetrics } from "../src/metrics.ts";

/** Records the instrument names a meter was asked to create. */
class RecordingMeterProvider implements MeterProvider {
  readonly histograms: string[] = [];
  readonly counters: string[] = [];

  getMeter(_name: string, _version?: string, _options?: MeterOptions): Meter {
    const meter = {
      createHistogram: (name: string) => { this.histograms.push(name); return {} as ReturnType<Meter["createHistogram"]>; },
      createCounter: (name: string) => { this.counters.push(name); return {} as ReturnType<Meter["createCounter"]>; },
      createGauge: () => ({}) as ReturnType<Meter["createGauge"]>,
      createUpDownCounter: () => ({}) as ReturnType<Meter["createUpDownCounter"]>,
      createObservableCounter: () => ({}) as ReturnType<Meter["createObservableCounter"]>,
      createObservableGauge: () => ({}) as ReturnType<Meter["createObservableGauge"]>,
      createObservableUpDownCounter: () => ({}) as ReturnType<Meter["createObservableUpDownCounter"]>,
    } as unknown as Meter;
    return meter;
  }
}

describe("createMetrics instrument names", () => {
  test("1.43 uses the registry time_to_first_chunk metric", () => {
    const p = new RecordingMeterProvider();
    const m = createMetrics(p, "1.43");
    assert.ok(m);
    assert.ok(p.histograms.includes("gen_ai.client.operation.time_to_first_chunk"), "registry TTFC name");
    assert.ok(!p.histograms.includes("pi.llm.time_to_first_token"), "no custom TTFT name in 1.43");
    assert.ok(p.histograms.includes("gen_ai.client.operation.duration"));
    assert.ok(p.histograms.includes("gen_ai.client.token.usage"));
    assert.ok(p.histograms.includes("pi.llm.time_to_completion"), "completion stays custom: no registry metric measures it");
  });

  test("1.37 and 1.36 keep the pi.llm.time_to_first_token name", () => {
    for (const semconv of ["1.36", "1.37"] as const) {
      const p = new RecordingMeterProvider();
      createMetrics(p, semconv);
      assert.ok(p.histograms.includes("pi.llm.time_to_first_token"), `${semconv} keeps its historical name`);
      assert.ok(!p.histograms.includes("gen_ai.client.operation.time_to_first_chunk"), `${semconv} has no registry TTFC`);
    }
  });

  test("returns null without a provider", () => {
    assert.equal(createMetrics(null), null);
    assert.equal(createMetrics(undefined, "1.43"), null);
  });
});
