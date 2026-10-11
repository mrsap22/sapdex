import { LOGO_SIZES, logoSrc, logoSrcSet, type LogoHeight } from "../../../shared/brand.ts";
import { navigate } from "../router.ts";

/**
 * The mark: the project's logo, as it was supplied. The site serves its own copies, made from the
 * source file by scripts/make-brand.ts at each height it is shown at, for screens of one, two and
 * three device pixels to a pixel. Its width and height are set, so nothing moves when it arrives.
 */
export function Mark({ size = 28 }: { size?: LogoHeight }) {
  const { width, height } = LOGO_SIZES[size];
  return <img className="mark" src={logoSrc(size)} srcSet={logoSrcSet(size)} width={width} height={height} alt="SaplingDex" decoding="async" />;
}

/** The name, linking home. */
export function Wordmark() {
  return (
    <a
      className="wordmark"
      href="/"
      aria-label="SaplingDex, home"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate("/");
      }}
    >
      {/* The name is the wordmark: one word, in one colour, with nothing drawn beside it. */}
      <span className="wordmark-text">SaplingDex</span>
    </a>
  );
}
