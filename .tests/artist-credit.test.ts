import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

import {
  artistCreditFromMusicBrainz,
  artistCreditFromTags,
  findTrackArtistCredit,
  formatArtistCredit,
  isSoleAlbumArtistCredit,
  withFallbackArtistCredits,
} from "../lib/artistCredit.ts";
import { getMusicbrainzReleaseTrackCredits } from "../backend/services/apiClients/musicbrainz.ts";
import { json, stubFetch } from "./helpers/artistStream.ts";
import { useFakeClock } from "./helpers/fakeClock.ts";

useFakeClock();

const HOST = "11111111-1111-4111-8111-111111111111";
const GUEST = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const REC_1 = "99999999-9999-4999-8999-999999999999";

test("MusicBrainz credits keep their join phrases and format back to the credited name", () => {
  const credit = artistCreditFromMusicBrainz([
    { name: "Host", joinphrase: " feat. ", artist: { id: HOST, name: "Host" } },
    { name: "Guest", joinphrase: " & ", artist: { id: GUEST, name: "Guest Artist" } },
    { joinphrase: "", artist: { id: OTHER, name: "Other" } },
  ]);

  assert.deepEqual(credit, [
    { name: "Host", mbid: HOST, joinPhrase: " feat. " },
    { name: "Guest", mbid: GUEST, joinPhrase: " & " },
    { name: "Other", mbid: OTHER, joinPhrase: "" },
  ]);
  assert.equal(formatArtistCredit(credit), "Host feat. Guest & Other");
  assert.equal(artistCreditFromMusicBrainz([]), null);
  assert.equal(formatArtistCredit(null), "");
});

test("tag credits recover join phrases from the display artist and pair artist MBIDs", () => {
  assert.deepEqual(
    artistCreditFromTags({
      artist: "Host feat. Guest & Other",
      artists: ["Host", "Guest", "Other"],
      mbids: [HOST, GUEST, OTHER],
    }),
    [
      { name: "Host", mbid: HOST, joinPhrase: " feat. " },
      { name: "Guest", mbid: GUEST, joinPhrase: " & " },
      { name: "Other", mbid: OTHER, joinPhrase: "" },
    ],
  );
});

test("guests listed only in the artists tag are appended to the main artist", () => {
  assert.deepEqual(
    artistCreditFromTags({
      artist: "Host",
      artists: ["Host", "Guest", "Other"],
      mbids: [HOST, GUEST, OTHER],
    }),
    [
      { name: "Host", mbid: HOST, joinPhrase: ", " },
      { name: "Guest", mbid: GUEST, joinPhrase: " & " },
      { name: "Other", mbid: OTHER, joinPhrase: "" },
    ],
  );
  assert.equal(
    formatArtistCredit(
      artistCreditFromTags({ artist: "Host feat. Guest", artists: ["Host", "Other"] }),
    ),
    "Host feat. Guest & Other",
  );
  assert.equal(
    formatArtistCredit(artistCreditFromTags({ artists: ["Host", "Guest"] })),
    "Host & Guest",
  );
});

test("tag credits leave artists unlinked when the MBID list does not line up", () => {
  const credit = artistCreditFromTags({
    artist: "Host feat. Guest",
    artists: ["Host", "Guest"],
    mbids: [HOST],
  });

  assert.deepEqual(
    credit?.map((entry) => entry.mbid),
    [null, null],
  );
  assert.equal(formatArtistCredit(credit), "Host feat. Guest");
});

test("an ARTISTS list music-metadata copied from ARTIST is still split at the featuring phrase", () => {
  assert.deepEqual(
    artistCreditFromTags({
      artist: "Host feat. Guest",
      artists: ["Host feat. Guest"],
      mbids: [HOST],
    }),
    [
      { name: "Host", mbid: HOST, joinPhrase: " feat. " },
      { name: "Guest", mbid: null, joinPhrase: "" },
    ],
  );
  assert.deepEqual(artistCreditFromTags({ artist: "Host", artists: ["Host"], mbids: [HOST] }), [
    { name: "Host", mbid: HOST, joinPhrase: "" },
  ]);
});

test("artist names only match whole words in the display artist", () => {
  assert.equal(
    formatArtistCredit(artistCreditFromTags({ artist: "Bobby & Bob", artists: ["Bob", "Bobby"] })),
    "Bob & Bobby",
  );
  assert.equal(
    formatArtistCredit(
      artistCreditFromTags({ artist: "MØ feat. Guest", artists: ["mø", "guest"] }),
    ),
    "MØ feat. Guest",
  );
});

test("a display artist alone is split at the featuring phrase", () => {
  assert.deepEqual(artistCreditFromTags({ artist: "Host ft. Guest & Other" }), [
    { name: "Host", mbid: null, joinPhrase: " ft. " },
    { name: "Guest & Other", mbid: null, joinPhrase: "" },
  ]);
  assert.deepEqual(artistCreditFromTags({ artist: "Simon & Garfunkel" }), [
    { name: "Simon & Garfunkel", mbid: null, joinPhrase: "" },
  ]);
  assert.equal(artistCreditFromTags({}), null);
});

test("only credits that add something beyond the album artist are shown", () => {
  const albumArtist = { mbid: HOST, name: "Host" };

  assert.equal(isSoleAlbumArtistCredit(null, albumArtist), true);
  assert.equal(
    isSoleAlbumArtistCredit([{ name: "Host", mbid: HOST, joinPhrase: "" }], albumArtist),
    true,
  );
  assert.equal(
    isSoleAlbumArtistCredit([{ name: "host", mbid: null, joinPhrase: "" }], albumArtist),
    true,
  );
  assert.equal(
    isSoleAlbumArtistCredit([{ name: "Host", mbid: OTHER, joinPhrase: "" }], albumArtist),
    false,
  );
  assert.equal(
    isSoleAlbumArtistCredit(
      [
        { name: "Host", mbid: HOST, joinPhrase: " feat. " },
        { name: "Guest", mbid: GUEST, joinPhrase: "" },
      ],
      albumArtist,
    ),
    false,
  );
});

test("release credits are read per recording, preferring the track credit", async (t: import("vite-plus/test").TestContext) => {
  const releaseMbid = "44444444-4444-4444-8444-444444444444";
  const requests: URL[] = [];
  stubFetch(t, (url) => {
    requests.push(url);
    return json({
      media: [
        {
          tracks: [
            {
              "artist-credit": [
                { name: "Host", joinphrase: " feat. ", artist: { id: HOST, name: "Host" } },
                { name: "Guest", joinphrase: "", artist: { id: GUEST, name: "Guest" } },
              ],
              title: "First",
              recording: {
                id: REC_1,
                "artist-credit": [{ name: "Host", joinphrase: "", artist: { id: HOST } }],
              },
            },
            {
              title: "Second",
              recording: {
                id: "66666666-6666-4666-8666-666666666666",
                "artist-credit": [{ name: "Other", joinphrase: "", artist: { id: OTHER } }],
              },
            },
          ],
        },
      ],
    });
  });

  const credits = await getMusicbrainzReleaseTrackCredits(releaseMbid);

  assert.equal(requests[0].pathname, `/ws/2/release/${releaseMbid}`);
  assert.equal(requests[0].searchParams.get("inc"), "recordings+artist-credits");
  assert.equal(
    formatArtistCredit(findTrackArtistCredit(credits, { mbid: REC_1 })),
    "Host feat. Guest",
  );
  assert.equal(formatArtistCredit(findTrackArtistCredit(credits, { title: "Second" })), "Other");

  await getMusicbrainzReleaseTrackCredits(releaseMbid);
  assert.equal(requests.length, 1);
});

test("a failed release credits lookup returns no credits and is retried after a few minutes", async (t: import("vite-plus/test").TestContext) => {
  const releaseMbid = "55555555-5555-4555-8555-555555555555";
  let calls = 0;
  stubFetch(t, () => {
    calls += 1;
    return json({ error: "unavailable" }, 503);
  });

  assert.deepEqual(await getMusicbrainzReleaseTrackCredits(releaseMbid), []);
  assert.deepEqual(await getMusicbrainzReleaseTrackCredits(releaseMbid), []);
  assert.equal(calls, 1);

  vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
  assert.deepEqual(await getMusicbrainzReleaseTrackCredits(releaseMbid), []);
  assert.equal(calls, 2);
});

test("library tracks tagged with only the album artist take the release credit", () => {
  const albumArtist = { mbid: HOST, name: "Host" };
  const releaseCredits = [
    {
      recordingId: REC_1,
      title: "With Guest",
      artistCredit: [
        { name: "Host", mbid: HOST, joinPhrase: " & " },
        { name: "Guest", mbid: GUEST, joinPhrase: "" },
      ],
    },
    {
      recordingId: "66666666-6666-4666-8666-666666666666",
      title: "Solo",
      artistCredit: [{ name: "Host", mbid: HOST, joinPhrase: "" }],
    },
  ];
  const tagged = [
    { name: "Host", mbid: HOST, joinPhrase: " feat. " },
    { name: "Other", mbid: OTHER, joinPhrase: "" },
  ];
  const tracks = [
    {
      mbid: REC_1,
      title: "With Guest",
      artistCredit: [{ name: "Host", mbid: HOST, joinPhrase: "" }],
    },
    { mbid: null, title: "with guest", artistCredit: null },
    { mbid: null, title: "Solo", artistCredit: null },
    { mbid: REC_1, title: "Own Tags", artistCredit: tagged },
  ];

  const filled = withFallbackArtistCredits(tracks, releaseCredits, albumArtist);

  assert.equal(formatArtistCredit(filled[0].artistCredit), "Host & Guest");
  assert.equal(formatArtistCredit(filled[1].artistCredit), "Host & Guest");
  assert.equal(filled[2], tracks[2]);
  assert.equal(filled[3].artistCredit, tagged);
});
