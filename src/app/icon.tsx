import { ImageResponse } from "next/og";

/**
 * The tab icon, generated rather than hand-drawn.
 *
 * Next.js reads this file by convention and emits the `<link rel="icon">`
 * tag itself - there is no metadata to wire up by hand. `favicon.ico` (also
 * in this directory) carries the same mark in a real .ico container, for the
 * direct `/favicon.ico` request some browsers still make regardless of the
 * `<link>` tag this file produces.
 *
 * The mark is the one in the header (`BrandMark` in site-header.tsx): a
 * shopping bag with a tick, on the site's red.
 */
export const size = {
  width: 32,
  height: 32,
};

export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    <svg width="32" height="32" viewBox="0 0 32 32">
      <rect width="32" height="32" rx="8" fill="#e3162d" />
      <path
        d="M12.25 12.5V11a3.75 3.75 0 0 1 7.5 0v1.5"
        fill="none"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M8.6 12.5h14.8a1 1 0 0 1 1 .92l.95 11.1a1.8 1.8 0 0 1-1.8 1.98H8.45a1.8 1.8 0 0 1-1.8-1.98l.95-11.1a1 1 0 0 1 1-.92z"
        fill="#fff"
      />
      <path
        d="M12.4 19.3l2.5 2.5 4.8-5"
        fill="none"
        stroke="#e3162d"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>,
    { ...size },
  );
}
