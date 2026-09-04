import { ImageResponse } from "next/og";

/**
 * The tab icon, generated rather than hand-drawn.
 *
 * Next.js reads this file by convention and emits the `<link rel="icon">`
 * tag itself - there is no metadata to wire up by hand. `favicon.ico` (also
 * in this directory) carries the same "AC" mark baked into a real .ico
 * container, for the direct `/favicon.ico` request some browsers still make
 * regardless of the `<link>` tag this file produces.
 *
 * Colours are the same two tokens the rest of the interface is built from -
 * `--rzp-navy` and `--rzp-blue` in `globals.css` - so the tab icon is not a
 * third, independently chosen palette.
 */
export const size = {
  width: 32,
  height: 32,
};

export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#02042B",
        color: "#3395FF",
        fontSize: 18,
        fontWeight: 800,
        fontFamily: "system-ui, sans-serif",
        letterSpacing: -1.5,
      }}
    >
      AC
    </div>,
    { ...size },
  );
}
