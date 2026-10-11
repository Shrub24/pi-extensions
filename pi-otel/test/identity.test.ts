import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, asstMsg } from "./helpers.ts";
import { SPAN_LLM_REQUEST } from "../src/attrs.ts";

test("virtual selection stays separate while assistant identity labels generation and metrics", async () => {
  const h = makeHarness();
  h.tracker.startSession(); h.tracker.startInteraction("prompt"); h.tracker.startTurn(0);
  h.tracker.noteProviderRequest("route/worker");
  h.tracker.recordProviderResponse(503, {});
  h.tracker.recordProviderResponse(200, {});
  h.tracker.claimPendingLlm({ model: "physical-a", provider: "anthropic" });
  h.tracker.noteFirstToken({ role: "assistant", model: "physical-a", provider: "anthropic" });
  h.tracker.noteLlmComplete({ role: "assistant", model: "physical-a", provider: "anthropic" });
  h.tracker.completeLlm(asstMsg({ model: "physical-a", provider: "anthropic", responseModel: "response-a" }));
  h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession(); await h.flush();
  const span = h.span(SPAN_LLM_REQUEST);
  assert.equal(span.attributes["gen_ai.request.model"], "physical-a");
  assert.equal(span.attributes["gen_ai.provider.name"], "anthropic");
  assert.equal(span.attributes["gen_ai.response.model"], "response-a");
  assert.equal(span.attributes["pi.route.virtual_model"], "route/worker");
  assert.equal(h.metrics.histograms.ttft?.[0]?.attrs["gen_ai.request.model"], "physical-a");
  assert.equal(h.metrics.histograms.completion?.[0]?.attrs["gen_ai.request.model"], "physical-a");
  assert.equal(h.metrics.histograms.tokens?.[0]?.attrs["gen_ai.request.model"], "physical-a");
  assert.equal(h.metrics.counters.retries?.[0]?.attrs["gen_ai.request.model"], "physical-a");
});

test("completion-only failure resolves physical identity before usage accounting", async () => {
  const h = makeHarness();
  h.tracker.startSession(); h.tracker.startInteraction("prompt"); h.tracker.startTurn(0);
  h.tracker.noteProviderRequest("route/worker"); h.tracker.recordProviderResponse(503, {});
  h.tracker.claimPendingLlm();
  h.tracker.completeLlm(asstMsg({ model: "physical-fallback", provider: "openai", stopReason: "error" }));
  h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession(); await h.flush();
  const span = h.span(SPAN_LLM_REQUEST);
  assert.equal(span.attributes["gen_ai.request.model"], "physical-fallback");
  assert.equal(span.attributes["gen_ai.provider.name"], "openai");
  assert.equal(span.attributes["pi.route.virtual_model"], "route/worker");
  assert.equal(h.metrics.histograms.tokens?.[0]?.attrs["gen_ai.request.model"], "physical-fallback");
  assert.equal(h.metrics.histograms.op?.[0]?.attrs["gen_ai.request.model"], "physical-fallback");
});

test("the activated account labels the physical generation span and metrics without touching the physical model", async () => {
  const h = makeHarness();
  h.tracker.noteRouteAccount("anthropic", "work-key");
  h.tracker.startSession(); h.tracker.startInteraction("prompt"); h.tracker.startTurn(0);
  h.tracker.noteProviderRequest("route/worker"); h.tracker.recordProviderResponse(200, {});
  h.tracker.claimPendingLlm({ model: "physical-a", provider: "anthropic" });
  h.tracker.noteFirstToken({ role: "assistant", model: "physical-a", provider: "anthropic" });
  h.tracker.completeLlm(asstMsg({ model: "physical-a", provider: "anthropic" }));
  h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession(); await h.flush();
  const span = h.span(SPAN_LLM_REQUEST);
  assert.equal(span.attributes["gen_ai.request.model"], "physical-a");
  assert.equal(span.attributes["pi.route.account_id"], "work-key");
  assert.equal(h.metrics.histograms.ttft?.[0]?.attrs["pi.route.account_id"], "work-key");
  assert.equal(h.metrics.histograms.op?.[0]?.attrs["pi.route.account_id"], "work-key");
});

test("generations on a provider without a named account carry no account attribute", async () => {
  const h = makeHarness();
  h.tracker.noteRouteAccount("anthropic", "work-key");
  h.tracker.startSession(); h.tracker.startInteraction("prompt"); h.tracker.startTurn(0);
  h.tracker.noteProviderRequest("route/worker"); h.tracker.recordProviderResponse(200, {});
  h.tracker.claimPendingLlm({ model: "other", provider: "openai" });
  h.tracker.completeLlm(asstMsg({ model: "other", provider: "openai" }));
  h.tracker.endTurn(); h.tracker.endInteraction(); h.tracker.endSession(); await h.flush();
  assert.equal(h.span(SPAN_LLM_REQUEST).attributes["pi.route.account_id"], undefined);
});
