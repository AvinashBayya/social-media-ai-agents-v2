import { describe, expect, test } from "bun:test";
import {
  blueskyMediaFromRecord,
  blueskyMediaFromView,
  mastodonMediaFrom,
  redditMediaFrom,
  splitTelegramMessages,
  telegramBlockToPost,
  telegramMediaFrom,
} from "../src/utils/social";

/**
 * Media extraction for the open-social platforms.
 *
 * Every fixture below except Reddit's was captured from a live response on
 * 2026-08-12. That mattered: two shapes do not match what the documentation
 * implies.
 *
 *  - Bluesky ships an `app.bsky.embed.gallery` embed (up to 10 images) whose
 *    fields are `items[].thumbnail`, not the `images[].thumb` of the older
 *    embed. An extractor written from the documented `images` shape silently
 *    drops every carousel post.
 *  - A t.me page carries 85 `background-image` declarations of which 4 are post
 *    photos; the rest are avatars and emoji. An unscoped selector reports a
 *    channel's avatar as evidence.
 *
 * Reddit's fixture is hand-built and marked as such — Reddit refuses
 * unauthenticated requests on every endpoint, so it is the one shape here that
 * could not be captured live.
 */

// ─── Bluesky ───────────────────────────────────────────────────────────────

const DID = "did:plc:z72i7hdynmk6r22z27h6tvur";
const CID = "bafkreig2hq7svgwj4bppizprcv5t3dlg4zbu3a6pvbebftlavbocibuud4";

describe("blueskyMediaFromView — AppView shape", () => {
  test("images#view", () => {
    const out = blueskyMediaFromView({
      $type: "app.bsky.embed.images#view",
      images: [
        {
          thumb: `https://cdn.bsky.app/img/feed_thumbnail/plain/${DID}/${CID}`,
          fullsize: `https://cdn.bsky.app/img/feed_fullsize/plain/${DID}/${CID}`,
          alt: "A screenshot demonstrating how to hide reposts.",
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("image");
    expect(out[0].url).toContain("feed_fullsize");
    expect(out[0].thumbnailUrl).toContain("feed_thumbnail");
    expect(out[0].altText).toBe("A screenshot demonstrating how to hide reposts.");
  });

  test("gallery#view uses items[].thumbnail, not images[].thumb", () => {
    // The shape an `images`-only extractor drops entirely.
    const out = blueskyMediaFromView({
      $type: "app.bsky.embed.gallery#view",
      items: [
        { thumbnail: "https://cdn/t1", fullsize: "https://cdn/f1", alt: "one" },
        { thumbnail: "https://cdn/t2", fullsize: "https://cdn/f2" },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0].url).toBe("https://cdn/f1");
    expect(out[0].altText).toBe("one");
    expect(out[1].altText).toBeNull();
  });

  test("video#view keeps the playlist and its poster frame apart", () => {
    const out = blueskyMediaFromView({
      $type: "app.bsky.embed.video#view",
      playlist: "https://video.bsky.app/watch/did/cid/playlist.m3u8",
      thumbnail: "https://video.bsky.app/watch/did/cid/thumbnail.jpg",
      alt: "",
    });
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("video");
    expect(out[0].url).toContain("playlist.m3u8");
    expect(out[0].thumbnailUrl).toContain("thumbnail.jpg");
    // Empty alt is null, not "" — "not described" vs "described as nothing".
    expect(out[0].altText).toBeNull();
  });

  test("recordWithMedia#view recurses into the media half", () => {
    const out = blueskyMediaFromView({
      $type: "app.bsky.embed.recordWithMedia#view",
      media: {
        $type: "app.bsky.embed.images#view",
        images: [{ fullsize: "https://cdn/f", thumb: "https://cdn/t", alt: "quoted" }],
      },
      record: { record: { uri: "at://x" } },
    });
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://cdn/f");
  });

  test("a link card is NOT post media", () => {
    // external#view carries a preview image belonging to the linked page, not
    // to the poster. Counting it would attribute a third party's image to them,
    // and the link itself is already captured by linksFrom.
    const out = blueskyMediaFromView({
      $type: "app.bsky.embed.external#view",
      external: { uri: "https://example.com", title: "t", thumb: "https://cdn/thumb" },
    });
    expect(out).toEqual([]);
  });

  test("a quoted post with no media of its own yields nothing", () => {
    expect(
      blueskyMediaFromView({ $type: "app.bsky.embed.record#view", record: { uri: "at://x" } }),
    ).toEqual([]);
    expect(blueskyMediaFromView(null)).toEqual([]);
    expect(blueskyMediaFromView(undefined)).toEqual([]);
  });
});

describe("blueskyMediaFromRecord — raw Jetstream shape", () => {
  test("composes the CDN URL from the author DID and the blob CID", () => {
    const out = blueskyMediaFromRecord(
      {
        $type: "app.bsky.embed.images",
        images: [{ alt: "described", image: { $type: "blob", ref: { $link: CID } } }],
      },
      DID,
    );
    expect(out).toHaveLength(1);
    // Verified live: this exact composition returned HTTP 200 image/webp.
    expect(out[0].url).toBe(`https://cdn.bsky.app/img/feed_fullsize/plain/${DID}/${CID}`);
    expect(out[0].thumbnailUrl).toBe(`https://cdn.bsky.app/img/feed_thumbnail/plain/${DID}/${CID}`);
  });

  test("gallery items carry blobs the same way", () => {
    const out = blueskyMediaFromRecord(
      {
        $type: "app.bsky.embed.gallery",
        items: [
          { alt: "a", image: { ref: { $link: "cid1" } } },
          { alt: "b", image: { ref: { $link: "cid2" } } },
        ],
      },
      DID,
    );
    expect(out.map((m) => m.altText)).toEqual(["a", "b"]);
  });

  test("video blob becomes an HLS playlist with a URL-encoded DID", () => {
    const out = blueskyMediaFromRecord(
      { $type: "app.bsky.embed.video", video: { ref: { $link: "vcid" } } },
      DID,
    );
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("video");
    expect(out[0].url).toContain(encodeURIComponent(DID));
    expect(out[0].url).toEndWith("playlist.m3u8");
  });

  test("without a DID there is no addressable blob, so nothing is emitted", () => {
    // A URL composed without the DID would 404. Emitting one would be a
    // guessed address presented as a collected asset.
    expect(
      blueskyMediaFromRecord(
        { $type: "app.bsky.embed.images", images: [{ image: { ref: { $link: CID } } }] },
        "",
      ),
    ).toEqual([]);
  });
});

// ─── Mastodon ──────────────────────────────────────────────────────────────

describe("mastodonMediaFrom", () => {
  test("maps attachments and keeps the uploader's description", () => {
    const out = mastodonMediaFrom({
      media_attachments: [
        {
          type: "image",
          url: "https://files.mastodon.social/o/x.jpg",
          preview_url: "https://files.mastodon.social/s/x.jpg",
          description: "Black-and-white photo of a covered pedestrian bridge.",
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("image");
    expect(out[0].altText).toContain("pedestrian bridge");
  });

  test("gifv is video, not image", () => {
    // A silent looping video typed as an image would enter the still-image
    // analysis path and fail there.
    const out = mastodonMediaFrom({
      media_attachments: [{ type: "gifv", url: "https://f/x.mp4", description: null }],
    });
    expect(out[0].type).toBe("video");
    expect(out[0].altText).toBeNull();
  });

  test("an unknown attachment type is 'unknown', not guessed as an image", () => {
    const out = mastodonMediaFrom({
      media_attachments: [{ type: "audio", url: "https://f/a.mp3" }],
    });
    expect(out[0].type).toBe("unknown");
  });

  test("no attachments yields an empty array", () => {
    expect(mastodonMediaFrom({})).toEqual([]);
    expect(mastodonMediaFrom({ media_attachments: [] })).toEqual([]);
  });
});

// ─── Telegram ──────────────────────────────────────────────────────────────

/** Trimmed from a live t.me/s/durov page, keeping one text post, one media-only
 *  post, and a decoy avatar background-image outside any message. */
const TG_PAGE = `
<div class="tgme_header_link"><i class="tgme_page_photo_image" style="background-image:url('https://cdn4.telesco.pe/file/AVATAR')"></i></div>
<div class="tgme_widget_message" data-post="durov/520">
  <div class="tgme_widget_message_text js-message_text">First message with <b>text</b> &amp; an entity</div>
  <time datetime="2026-05-23T13:26:07+00:00"></time>
</div>
<div class="tgme_widget_message" data-post="durov/522">
  <a class="tgme_widget_message_photo_wrap 123 456" href="https://t.me/durov/522" style="width:800px;background-image:url('https://cdn4.telesco.pe/file/PHOTO522')"></a>
  <time datetime="2026-06-01T15:46:12+00:00"></time>
</div>
<div class="tgme_widget_message" data-post="durov/523">
  <div class="tgme_widget_message_text js-message_text">Third message</div>
  <i class="tgme_widget_message_video_thumb" style="background-image:url('https://cdn4.telesco.pe/file/VIDEO523')"></i>
  <video src="https://cdn4.telesco.pe/file/VIDEO523.mp4?token=abc"></video>
  <time datetime="2026-06-09T19:33:51+00:00"></time>
</div>
<div class="tgme_widget_message" data-post="durov/524">
  <a class="tgme_widget_message_reply" href="https://t.me/durov/520">
    <div class="tgme_widget_message_text js-message_reply_text">First message with text &amp; an ent…</div>
  </a>
  <div class="tgme_widget_message_text js-message_text">Reply body &#036;200,000 and&nbsp;more</div>
  <time datetime="2026-06-10T08:00:00+00:00"></time>
</div>
`;

describe("splitTelegramMessages", () => {
  test("one slice per message", () => {
    expect(splitTelegramMessages(TG_PAGE)).toHaveLength(4);
    expect(splitTelegramMessages("")).toEqual([]);
    expect(splitTelegramMessages("<html>no messages</html>")).toEqual([]);
  });
});

describe("telegramBlockToPost", () => {
  const posts = splitTelegramMessages(TG_PAGE)
    .map((b) => telegramBlockToPost(b, "durov"))
    .filter(Boolean) as NonNullable<ReturnType<typeof telegramBlockToPost>>[];

  test("a media-only post survives instead of desynchronising the feed", () => {
    // THE REGRESSION. The old parser built parallel ids/texts/times arrays and
    // zipped by index, so durov/522 — which has no text — shifted durov/523's
    // text up one slot. Post 522 then rendered "Third message" under 522's id,
    // URL and timestamp: real text attributed to the wrong message.
    expect(posts).toHaveLength(4);
    const p522 = posts.find((p) => p.url.endsWith("/522"))!;
    expect(p522.text).toBe("");
    expect(p522.media).toHaveLength(1);
  });

  test("text stays attached to its own message", () => {
    expect(posts.find((p) => p.url.endsWith("/520"))!.text).toBe(
      "First message with text & an entity",
    );
    expect(posts.find((p) => p.url.endsWith("/523"))!.text).toBe("Third message");
  });

  test("each post keeps its own timestamp", () => {
    expect(posts.find((p) => p.url.endsWith("/520"))!.createdAt).toBe("2026-05-23T13:26:07+00:00");
    expect(posts.find((p) => p.url.endsWith("/523"))!.createdAt).toBe("2026-06-09T19:33:51+00:00");
  });

  test("a reply carries its OWN text, not the message it quotes", () => {
    // THE SECOND MISATTRIBUTION. A reply renders
    // `<div class="tgme_widget_message_text js-message_reply_text">` holding a
    // truncated copy of the quoted message, and it appears BEFORE the real
    // js-message_text div. A non-global match on `tgme_widget_message_text[^"]*`
    // returned that first div, so every replying post was collected carrying
    // someone else's words under its own id, permalink and timestamp — exactly
    // what the per-message rewrite was adopted to eliminate. Measured live on
    // t.me/s/varlamov_news: 3 of 12 posts affected.
    const reply = posts.find((p) => p.url.endsWith("/524"))!;
    expect(reply.text).toContain("Reply body");
    expect(reply.text).not.toContain("First message with text");
  });

  test("entities in post text are decoded, including numeric and nbsp", () => {
    // Live: durov/527 was stored as "a &#036;200,000 contest" — raw markup
    // presented as the post's words, and unsearchable for "$200,000".
    const reply = posts.find((p) => p.url.endsWith("/524"))!;
    expect(reply.text).toContain("$200,000");
    expect(reply.text).not.toContain("&#036;");
    expect(reply.text).not.toContain("&nbsp;");
  });

  test("a block with neither text nor media is dropped", () => {
    expect(
      telegramBlockToPost('<div data-post="x/1"><time datetime="t"></time></div>', "x"),
    ).toBeNull();
    expect(telegramBlockToPost("<div>no id</div>", "x")).toBeNull();
  });
});

describe("telegramMediaFrom", () => {
  test("photo and video are both found, and typed apart", () => {
    const all = splitTelegramMessages(TG_PAGE).flatMap(telegramMediaFrom);
    expect(all).toHaveLength(2);
    expect(all.find((m) => m.url.endsWith("PHOTO522"))!.type).toBe("image");
    expect(all.find((m) => m.type === "video")!.type).toBe("video");
  });

  test("video emits the real .mp4, not the poster frame", () => {
    // THE REGRESSION. This emitted the JPEG poster as the asset URL on the
    // strength of a docstring claiming Telegram never serves the file. It does:
    // fetching both URLs for durov/523 gave image/jpeg for the emitted one and
    // video/mp4 for the discarded one. The /social Analyse control sends
    // media[0].url to Module 4, so a provenance verdict was being produced for
    // a Telegram-generated still while the tile beside it read "video".
    const video = splitTelegramMessages(TG_PAGE)
      .flatMap(telegramMediaFrom)
      .find((m) => m.type === "video")!;
    expect(video.url).toEndWith(".mp4?token=abc");
    expect(video.thumbnailUrl).toBe("https://cdn4.telesco.pe/file/VIDEO523");
    // url and thumbnailUrl are now genuinely different assets.
    expect(video.url).not.toBe(video.thumbnailUrl);
  });

  test("the channel avatar is not collected as post media", () => {
    // 85 background-image declarations on a real page, 4 of them posts. An
    // unscoped selector reports the avatar as evidence.
    const all = splitTelegramMessages(TG_PAGE).flatMap(telegramMediaFrom);
    expect(all.some((m) => m.url.includes("AVATAR"))).toBe(false);
  });
});

// ─── Reddit (hand-built fixture — see the header note) ─────────────────────

describe("redditMediaFrom", () => {
  test("unescapes &amp; in preview URLs", () => {
    // The signature parameters are part of the query string; an unescaped URL
    // 403s at the CDN.
    const out = redditMediaFrom({
      preview: {
        images: [
          {
            source: { url: "https://preview.redd.it/a.jpg?width=1080&amp;s=sig" },
            resolutions: [{ url: "https://preview.redd.it/a.jpg?width=108&amp;s=t" }],
          },
        ],
      },
    });
    expect(out[0].url).toBe("https://preview.redd.it/a.jpg?width=1080&s=sig");
    expect(out[0].thumbnailUrl).toBe("https://preview.redd.it/a.jpg?width=108&s=t");
  });

  test("native video is typed video", () => {
    const out = redditMediaFrom({
      media: { reddit_video: { fallback_url: "https://v.redd.it/x/DASH_720.mp4" } },
    });
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("video");
  });

  test("gallery items come from media_metadata values, not indices", () => {
    const out = redditMediaFrom({
      is_gallery: true,
      media_metadata: {
        abc: { s: { u: "https://preview.redd.it/abc.jpg" } },
        def: { s: { u: "https://preview.redd.it/def.jpg" } },
      },
    });
    expect(out).toHaveLength(2);
  });

  test("a bare i.redd.it link is used only when nothing richer exists", () => {
    expect(redditMediaFrom({ url: "https://i.redd.it/x.png" })).toHaveLength(1);
    // A post with a preview block should not also emit the raw link.
    const both = redditMediaFrom({
      url: "https://i.redd.it/x.png",
      preview: { images: [{ source: { url: "https://preview.redd.it/x.png" } }] },
    });
    expect(both).toHaveLength(1);
    expect(both[0].url).toContain("preview.redd.it");
  });

  test("a text post yields no media", () => {
    expect(redditMediaFrom({ title: "t", selftext: "s" })).toEqual([]);
    expect(redditMediaFrom(null)).toEqual([]);
  });

  test("duplicates across preview and gallery are collapsed", () => {
    const out = redditMediaFrom({
      is_gallery: true,
      media_metadata: { a: { s: { u: "https://preview.redd.it/same.jpg" } } },
      preview: { images: [{ source: { url: "https://preview.redd.it/same.jpg" } }] },
    });
    expect(out).toHaveLength(1);
  });
});
