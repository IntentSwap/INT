import { LOGO_SIZES, logoSrc, logoSrcSet, type LogoHeight } from "../../../shared/brand.ts";
import { navigate } from "../router.ts";

/**
 * The mark: the owner's logo, as it was supplied. The site serves its own copies, made from the
 * source file by scripts/make-brand.ts at each height it is shown at, for screens of one, two and
 * three device pixels to a pixel. Its width and height are set, so nothing moves when it arrives.
 */
export function Mark({ size = 28 }: { size?: LogoHeight }) {
  const { width, height } = LOGO_SIZES[size];
  return <img className="mark" src={logoSrc(size)} srcSet={logoSrcSet(size)} width={width} height={height} alt="IntentSwap" decoding="async" />;
}

/** The mark and the name, linking home. On a phone the mark is 24 px high; from 768 px it is 28. */
export function Wordmark() {
  const wide = LOGO_SIZES[28];
  return (
    <a
      className="wordmark"
      href="/"
      aria-label="IntentSwap, home"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate("/");
      }}
    >
      <picture>
        <source media="(min-width: 768px)" srcSet={logoSrcSet(28)} width={wide.width} height={wide.height} />
        <Mark size={24} />
      </picture>
      {/* On the narrowest screens, and on a phone once the header fills up, the mark stands alone. */}
      <span className="wordmark-text">IntentSwap</span>
    </a>
  );
}
