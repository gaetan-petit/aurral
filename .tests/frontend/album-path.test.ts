import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { albumPath, parseAlbumRef } from "../../lib/albumPath.ts";

test("an album ref is a library id when numeric and a release group otherwise", () => {
  assert.deepEqual(parseAlbumRef("42"), { kind: "library", libraryAlbumId: "42" });
  assert.deepEqual(parseAlbumRef(" 7 "), { kind: "library", libraryAlbumId: "7" });
  assert.deepEqual(parseAlbumRef("6f1c3a2e-0000-4000-8000-000000000001"), {
    kind: "release",
    releaseGroupMbid: "6f1c3a2e-0000-4000-8000-000000000001",
  });
  assert.deepEqual(parseAlbumRef("dz-302127"), {
    kind: "release",
    releaseGroupMbid: "dz-302127",
  });
  assert.equal(parseAlbumRef(""), null);
  assert.equal(parseAlbumRef(null), null);
});

test("album paths encode the ref and carry the highlighted track", () => {
  assert.equal(albumPath("rg-1"), "/album/rg-1");
  assert.equal(albumPath(12, { track: 88 }), "/album/12?track=88");
  assert.equal(albumPath("a b", { track: "x/y" }), "/album/a%20b?track=x%2Fy");
  assert.equal(albumPath("rg-1", { track: "" }), "/album/rg-1");
});
