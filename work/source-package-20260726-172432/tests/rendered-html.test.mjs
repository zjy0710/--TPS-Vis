import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the TPS-Vis application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>TPS-Vis \| PD-L1 Expression Explorer<\/title>/i);
  assert.match(html, /Specimen Explorer/);
  assert.match(html, /Patch Gallery/);
  assert.match(html, /IHC Image View/);
  assert.match(html, /TPS Distribution View/);
  assert.match(html, /Cell-Level View/);
  assert.match(html, /Pathology Insight Agent/);
  assert.match(html, /尚未载入病例图像/);
  assert.match(html, /NO CASE LOADED/);
  assert.doesNotMatch(html, /DI2025-/);
  assert.doesNotMatch(html, /assets\/wsi-overview/);
  assert.doesNotMatch(html, /<img\b/i);
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /react-loading-skeleton/);
});
