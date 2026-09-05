import { expect, it, vi } from "vitest";
import { fetchProxyModels } from "../src/catalog.js";

const chat = {
  id: "chat-model",
  supported_endpoints: ["/v1/chat/completions"],
  max_output_tokens: 8192,
  capabilities: ["text", "tools"],
};
function catalog(data: unknown[]) {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(JSON.stringify({ data }), {
        headers: { "content-type": "application/json" },
      }),
    );
}
it("loads chat models from the same policy-filtered catalog as image and voice tools", async () => {
  const fetcher = catalog([
    { id: "speech-model", supported_endpoints: ["/v1/audio/speech"] },
    chat,
    { id: "image-model", supported_endpoints: ["/v1/images/generations"] },
    {
      id: "transcription-model",
      supported_endpoints: ["/v1/audio/transcriptions"],
    },
  ]);
  expect(
    await fetchProxyModels("http://127.0.0.1:8402", "test", fetcher),
  ).toEqual([
    { id: chat.id, maxOutputTokens: 8192, capabilities: ["text", "tools"] },
  ]);
});
it.each([
  [chat, chat],
  [chat, { id: "bad-model", supported_endpoints: [42] }],
  [{ id: "audio-only", supported_endpoints: ["/v1/audio/speech"] }],
])("rejects malformed, duplicate or chat-empty catalogs", async (...data) => {
  await expect(
    fetchProxyModels("http://127.0.0.1:8402", "test", catalog(data)),
  ).rejects.toThrow();
});
it("keeps the timeout active until the response body has finished", async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn<typeof fetch>(
      async (_url, options) =>
        new Response(
          new ReadableStream({
            start(controller) {
              options?.signal?.addEventListener(
                "abort",
                () => controller.error(new Error("aborted")),
                { once: true },
              );
            },
          }),
        ),
    );
    const pending = fetchProxyModels("http://127.0.0.1:8402", "test", fetcher);
    const rejected = expect(pending).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(10_001);
    await rejected;
  } finally {
    vi.useRealTimers();
  }
});
