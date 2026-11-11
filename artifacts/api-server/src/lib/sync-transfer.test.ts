import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MAX_SYNC_FILE_BYTES, UPLOAD_CHUNK_BYTES, sourceFileStream, uploadChunks } from "./sync-transfer";
import { shufflrrFailureLinks } from "./sync-file-failures";
import { SyncRunJournal } from "./sync-log";
import type { SyncFileFailureStore } from "./sync-file-failures";

function byteStream(total: number) {
  let remaining = total;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!remaining) { controller.close(); return; }
      const bytes = new Uint8Array(Math.min(64 * 1024, remaining));
      remaining -= bytes.length; controller.enqueue(bytes);
    },
  });
}

for (const size of [175_700_000, MAX_SYNC_FILE_BYTES]) test(`streams ${size} bytes in bounded sequential Graph fragments`, async () => {
  let offset = 0; let fragments = 0;
  const result = await uploadChunks({ body: byteStream(size), size }, async (chunk, start, total) => {
    assert.equal(start, offset); assert.equal(total, size);
    assert.ok(chunk.length <= UPLOAD_CHUNK_BYTES);
    offset += chunk.length; fragments++;
    if (offset < size) {
      assert.equal(chunk.length % (320 * 1024), 0);
      return Response.json({ nextExpectedRanges: [`${offset}-`] }, { status: 202 });
    }
    return Response.json({ id: "uploaded", name: "video.mp4", size }, { status: 201 });
  });
  assert.equal(result.size, size); assert.equal(offset, size); assert.ok(fragments > 1);
});
test("rejects over-limit, missing-size and changed-size downloads before uploading", () => {
  assert.throws(() => sourceFileStream(new Response("x"), 300_000_001), /300 MB/);
  assert.throws(() => sourceFileStream(new Response("x")), /unavailable/);
  assert.throws(() => sourceFileStream(new Response("x", { headers: { "content-length": "4" } }), 3), /size changed/);
});
test("nonuniform bytes retain their checksum across source-buffer and upload-fragment boundaries", async () => {
  const size = UPLOAD_CHUNK_BYTES + 87_123;
  const expected = createHash("sha256");
  const transferred = createHash("sha256");
  let position = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (position === size) { controller.close(); return; }
      const chunk = new Uint8Array(Math.min(65_531, size - position));
      for (let index = 0; index < chunk.length; index++) chunk[index] = (position + index) % 251;
      position += chunk.length; expected.update(chunk); controller.enqueue(chunk);
    },
  });
  await uploadChunks({ body, size }, async (chunk, start) => {
    transferred.update(chunk);
    return start + chunk.length === size
      ? Response.json({ id: "x", name: "x", size }, { status: 201 })
      : Response.json({ nextExpectedRanges: [`${start + chunk.length}-`] }, { status: 202 });
  });
  assert.equal(transferred.digest("hex"), expected.digest("hex"));
});
test("truncated and oversized streams cannot submit a final fragment", async () => {
  for (const actual of [2, 4]) {
    let sent = 0;
    await assert.rejects(uploadChunks({ body: byteStream(actual), size: 3 }, async () => {
      sent++; return Response.json({ id: "bad", name: "bad", size: 3 });
    }));
    assert.equal(sent, 0);
  }
});
test("an unexpected fragment acknowledgement or unverified final size is not success", async () => {
  await assert.rejects(uploadChunks({ body: byteStream(UPLOAD_CHUNK_BYTES + 1), size: UPLOAD_CHUNK_BYTES + 1 },
    async () => Response.json({ nextExpectedRanges: ["0-"] }, { status: 202 })), /did not confirm/);
  await assert.rejects(uploadChunks({ body: byteStream(3), size: 3 },
    async () => Response.json({ id: "x", name: "x", size: 2 }, { status: 201 })), /did not confirm/);
});
test("a rejected upload is attempted once, never ambiguously replayed", async () => {
  let calls = 0;
  await assert.rejects(uploadChunks({ body: byteStream(3), size: 3 }, async () => {
    calls++; return new Response(null, { status: 403 });
  }), /403/);
  assert.equal(calls, 1);
});
test("Shufflrr links use portal-native routes, including generic file-history details for videos", () => {
  const links = shufflrrFailureLinks("https://example.shufflrr.com", 12, 34, 56);
  assert.match(links.fileUrl, /historyFile=56/);
  assert.match(links.parentFolderUrl, /folder=12/);
  assert.equal(new URL(links.fileUrl).origin, "https://example.shufflrr.com");
  assert.match(shufflrrFailureLinks("https://example.shufflrr.com", 12, 34).fileUrl, /file=34/);
});
test("unattempted source files receive notices, while intentional exclusions do not", async () => {
  const notices: Array<{ reason: string; status: string; runId: string }> = [];
  const fakeDb = { insert: () => ({ values: async () => {} }) } as unknown as typeof import("@workspace/db")["db"];
  const journal = new SyncRunJournal(fakeDb, "TEST-RUN");
  journal.fileFailures = {
    fail: async (_file: unknown, _path: string, reason: string, status: string, runId: string) => {
      notices.push({ reason, status, runId });
    },
    resolve: async () => {},
  } as unknown as SyncFileFailureStore;
  const event = { status: "skipped" as const, path: "Source/video.mp4", itemType: "file" as const, message: "Parent folder conflicts." };
  await journal.record({ ...event, sourceFile: { id: 3, rootId: 1, parentId: 2, name: "video.mp4", ancestorIds: [1, 2] } });
  await journal.record({ ...event, message: "Intentionally excluded subtree." });
  assert.deepEqual(notices, [{
    reason: "Parent folder conflicts.", status: "skipped", runId: "TEST-RUN",
  }]);
});
