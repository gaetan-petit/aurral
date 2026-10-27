import { test, afterAll, type TestContext } from "vite-plus/test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { link, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseFile } from "music-metadata";
import taglib from "node-taglib-sharp";

import { readAurralIdentity, writeAudioMetadata } from "../../backend/services/downloadUtils.ts";
import { warmReleaseTrackCredits } from "../../backend/services/trackArtistCredits.ts";
import { getMusicbrainzReleaseTrackCredits } from "../../backend/services/apiClients/musicbrainz.ts";
import { json, stubFetch } from "../helpers/artistStream.ts";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "aurral-audio-tags-"));
const job = {
  trackName: "One More Time",
  artistName: "Daft Punk",
  albumName: "Discovery",
  artistMbid: "056e4f3e-d505-4dad-8ec1-d04f521cbb56",
  albumMbid: "48117b90-a16e-34ca-a514-19c702df1158",
  trackMbid: "60fa767a-d85d-4991-82bc-4294e0b11ae7",
  releaseYear: "2001",
  trackNumber: 1,
};

function makeAudio(name: string, codec: string[]) {
  const filePath = path.join(tempDir, name);
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc",
      "-t",
      "0.2",
      ...codec,
      filePath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return filePath;
}

function tagAsUploader(
  filePath: string,
  build: (file: ReturnType<typeof taglib.File.createFromPath>) => void,
) {
  const file = taglib.File.createFromPath(filePath);
  build(file);
  file.save();
  file.dispose();
}

const cover = taglib.Picture.fromFullData(
  taglib.ByteVector.fromString("cover-art", taglib.StringType.Latin1),
  taglib.PictureType.FrontCover,
  "image/jpeg",
  "",
);

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("tagging a download keeps the uploader's release ID, ratings, lyrics, ReplayGain, grouping, and cover art", async () => {
  const filePath = makeAudio("uploaded.mp3", ["-c:a", "libmp3lame"]);
  tagAsUploader(filePath, (file) => {
    const id3 = file.getTag(taglib.TagTypes.Id3v2, true);
    assert.ok(id3 instanceof taglib.Id3v2Tag);
    file.tag.title = "one more time (album version)";
    file.tag.grouping = "Live set";
    file.tag.musicBrainzTrackId = "99999999-9999-4999-8999-999999999999";
    file.tag.musicBrainzReleaseId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    file.tag.pictures = [cover];
    const rating = taglib.Id3v2PopularimeterFrame.fromUser("listener@example.com");
    rating.rating = 255;
    id3.addFrame(rating);
    const lyrics = taglib.Id3v2UnsynchronizedLyricsFrame.fromData("", "eng");
    lyrics.text = "One more time, we're gonna celebrate";
    id3.addFrame(lyrics);
    const gain = taglib.Id3v2UserTextInformationFrame.fromDescription("REPLAYGAIN_TRACK_GAIN");
    gain.text = ["-6.10 dB"];
    id3.addFrame(gain);
  });

  await writeAudioMetadata(filePath, job);

  const metadata = await parseFile(filePath);
  const { common } = metadata;
  assert.equal(common.title, "One More Time");
  assert.equal(common.musicbrainz_recordingid, job.trackMbid);
  assert.equal(common.musicbrainz_releasegroupid, job.albumMbid);
  assert.equal(common.musicbrainz_albumartistid?.[0], job.artistMbid);
  assert.equal(common.musicbrainz_albumid, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  assert.equal(common.grouping, "Live set");
  assert.equal(common.rating?.[0]?.rating, 1);
  assert.match(common.lyrics?.[0]?.text ?? String(common.lyrics?.[0] ?? ""), /celebrate/);
  assert.equal(common.replaygain_track_gain?.dB, -6.1);
  assert.equal(common.picture?.length, 1);
  assert.equal(metadata.native["ID3v2.4"].filter((tag) => tag.id.startsWith("UFID")).length, 1);
  assert.deepEqual(readAurralIdentity(metadata), {
    artistMbid: job.artistMbid,
    albumMbid: job.albumMbid,
    trackMbid: job.trackMbid,
  });
});

test("tagging an M4A keeps its freeform tags and the tags the job has no value for, and drops a release ID from another album", async () => {
  const filePath = makeAudio("uploaded.m4a", ["-c:a", "aac"]);
  tagAsUploader(filePath, (file) => {
    const apple = file.getTag(taglib.TagTypes.Apple, true);
    assert.ok(apple instanceof taglib.Mpeg4AppleTag);
    apple.setItunesStrings("com.apple.iTunes", "replaygain_track_gain", "-4.20 dB");
    file.tag.musicBrainzReleaseGroupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    file.tag.musicBrainzReleaseId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    file.tag.musicBrainzTrackId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    file.tag.track = 7;
  });

  await writeAudioMetadata(filePath, { ...job, trackMbid: null, trackNumber: null });

  const { common } = await parseFile(filePath);
  assert.equal(common.musicbrainz_releasegroupid, job.albumMbid);
  assert.equal(common.musicbrainz_albumid, undefined);
  assert.equal(common.musicbrainz_recordingid, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  assert.equal(common.track.no, 7);
  assert.equal(common.replaygain_track_gain?.dB, -4.2);
  assert.equal(common.year, 2001);
});

test("tagging a hardlinked download leaves the other link as it was", async () => {
  const seeding = makeAudio("seeding.flac", []);
  const imported = path.join(tempDir, "imported.flac");
  await link(seeding, imported);
  const seedingBytes = await readFile(seeding);

  await writeAudioMetadata(imported, job);

  assert.deepEqual(await readFile(seeding), seedingBytes);
  assert.notEqual((await stat(seeding)).ino, (await stat(imported)).ino);
  assert.equal((await parseFile(imported)).common.title, "One More Time");
});

test("tagging a fragmented M4A leaves the file as it was instead of breaking its audio", async () => {
  const filePath = makeAudio("fragmented.m4a", [
    "-c:a",
    "aac",
    "-movflags",
    "frag_keyframe+empty_moov",
  ]);
  const bytes = await readFile(filePath);

  await assert.rejects(writeAudioMetadata(filePath, job), { code: "TAGS_UNSUPPORTED" });

  assert.deepEqual(await readFile(filePath), bytes);
});

test("a download tagged after its release credits were looked up keeps its featured artists", async (t: TestContext) => {
  const releaseMbid = "77777777-7777-4777-8777-777777777777";
  const kendrick = "381086ea-f511-4aba-bdf9-71c753dc5077";
  const sza = "272989c8-5535-492d-a25c-9f58803e027f";
  stubFetch(t, () =>
    json({
      media: [
        {
          tracks: [
            {
              title: "All the Stars",
              "artist-credit": [
                { name: "Kendrick Lamar", joinphrase: " & ", artist: { id: kendrick } },
                { name: "SZA", joinphrase: "", artist: { id: sza } },
              ],
              recording: { id: "a0a38516-c9c3-4a05-a2bf-523b6ca219ab" },
            },
          ],
        },
      ],
    }),
  );
  warmReleaseTrackCredits(releaseMbid);
  await getMusicbrainzReleaseTrackCredits(releaseMbid);
  const download = {
    ...job,
    trackName: "All the Stars",
    artistName: "Kendrick Lamar",
    artistMbid: kendrick,
    releaseMbid,
    trackMbid: "a0a38516-c9c3-4a05-a2bf-523b6ca219ab",
  };

  for (const [name, codec] of [
    ["credit.flac", ["-c:a", "flac"]],
    ["credit.mp3", ["-c:a", "libmp3lame"]],
    ["credit.m4a", ["-c:a", "aac"]],
  ] as const) {
    const filePath = makeAudio(name, [...codec]);
    await writeAudioMetadata(filePath, download);
    const { common } = await parseFile(filePath);
    assert.equal(common.artist, "Kendrick Lamar & SZA", name);
    assert.deepEqual(common.artists, ["Kendrick Lamar", "SZA"], name);
    assert.deepEqual(common.musicbrainz_artistid, [kendrick, sza], name);
    assert.equal(common.albumartist, "Kendrick Lamar", name);
  }
});

test("a download whose release credits were never looked up is tagged with the album artist", async () => {
  const filePath = makeAudio("no-credit.flac", ["-c:a", "flac"]);
  await writeAudioMetadata(filePath, {
    ...job,
    releaseMbid: "88888888-8888-4888-8888-888888888888",
  });
  const { common } = await parseFile(filePath);
  assert.equal(common.artist, "Daft Punk");
  assert.deepEqual(common.musicbrainz_artistid, [job.artistMbid]);
});

test("tagging a download without a credit drops the uploader's list of other artists", async () => {
  for (const [name, codec, tagType] of [
    ["uploader-artists.flac", ["-c:a", "flac"], taglib.TagTypes.Xiph],
    ["uploader-artists.mp3", ["-c:a", "libmp3lame"], taglib.TagTypes.Id3v2],
    ["uploader-artists.m4a", ["-c:a", "aac"], taglib.TagTypes.Apple],
  ] as const) {
    const filePath = makeAudio(name, [...codec]);
    tagAsUploader(filePath, (file) => {
      const tag = file.getTag(tagType, true);
      file.tag.performers = ["Somebody Else"];
      if (tag instanceof taglib.XiphComment) tag.setFieldAsStrings("ARTISTS", "X", "Y");
      if (tag instanceof taglib.Id3v2Tag) {
        const frame = taglib.Id3v2UserTextInformationFrame.fromDescription("ARTISTS");
        frame.text = ["X", "Y"];
        tag.addFrame(frame);
      }
      if (tag instanceof taglib.Mpeg4AppleTag) {
        tag.setItunesStrings("com.apple.iTunes", "ARTISTS", "X", "Y");
      }
    });
    assert.deepEqual((await parseFile(filePath)).common.artists, ["X", "Y"], name);

    await writeAudioMetadata(filePath, job);

    const { common } = await parseFile(filePath);
    assert.equal(common.artist, "Daft Punk", name);
    assert.deepEqual(common.artists, ["Daft Punk"], name);
  }
});
