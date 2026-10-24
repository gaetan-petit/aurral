import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { partialMatchKey } from "@tanstack/react-query";

const { queryKeys } = await import("../../frontend/src/queryClient.ts");

test("the latest artist import and a chosen import never share a cache entry", () => {
  for (const id of [0, 1, 42]) {
    assert.equal(partialMatchKey(queryKeys.artistImport(id), queryKeys.latestArtistImport), false);
    assert.equal(partialMatchKey(queryKeys.latestArtistImport, queryKeys.artistImport(id)), false);
  }
});
