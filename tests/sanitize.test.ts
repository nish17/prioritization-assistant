import { describe, expect, it } from "vitest";
import { isAllowedLink } from "../src/board/render.js";
import { cleanText, cleanUrl, normalizeTitle } from "../src/domain/sanitize.js";

describe("cleanText", () => {
  it("strips tags, including entity-encoded ones, and invisible characters", () => {
    expect(cleanText("<b>Hi</b> &lt;script&gt;x&lt;/script&gt; there", 100)).toBe("Hi x there");
    expect(cleanText("a​b‮c⁦d﻿e", 100)).toBe("abcde");
    expect(cleanText("line one\r\n\tline two", 100)).toBe("line one line two");
  });

  it("caps by code point with an ellipsis, and returns null for blank input", () => {
    const capped = cleanText("😀".repeat(300), 280)!;
    expect(Array.from(capped)).toHaveLength(280);
    expect(capped.endsWith("…")).toBe(true);
    expect(cleanText("   ​ ", 10)).toBeNull();
    expect(cleanText(undefined, 10)).toBeNull();
  });

  it("normalizes to NFC", () => {
    expect(cleanText("é", 10)).toBe("é");
  });

  it("normalizes titles for trigram matching", () => {
    expect(normalizeTitle("Send Q4 roadmap-deck, ASAP!")).toBe("send q4 roadmap deck asap");
  });
});

describe("link allow-list", () => {
  const allowed = [
    "https://mail.google.com/mail/u/0/#all/abc",
    "https://calendar.google.com/calendar/event?eid=x",
    "https://www.google.com/calendar/event?eid=x",
    "https://acme.slack.com/archives/C1/p123",
    "https://app.slack.com/client/T1/C1",
    "https://notes.granola.ai/d/abc",
  ];
  const blocked = [
    "http://mail.google.com/mail",
    "https://www.google.com/search?q=x",
    "https://notslack.com/archives",
    "https://slack.com.evil.example/x",
    "https://mail.google.com@evil.example/x",
    "https://user:pw@mail.google.com/x",
    "https://mail.google.com:8443/x",
    "javascript:alert(1)",
    "data:text/html,hi",
    "not a url",
  ];

  it.each(allowed)("allows %s on the server and the board", (url) => {
    expect(cleanUrl(url).url).not.toBeNull();
    expect(isAllowedLink(url)).toBe(true);
  });

  it.each(blocked)("keeps %s as plain text on the server and blocks it on the board", (url) => {
    const r = cleanUrl(url);
    expect(r.url).toBeNull();
    expect(r.url_text).not.toBeNull();
    expect(isAllowedLink(url)).toBe(false);
  });
});
