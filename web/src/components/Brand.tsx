import { navigate } from "../router.ts";

/**
 * The emblem: two leaves curving round each other. One flat shape, served by the site itself
 * (made from the brand's own vector by scripts/make-brand.ts) and drawn in the colour of the text
 * beside it, so it is right in both themes. It says nothing a screen reader needs: the name does.
 */
export function Mark() {
  return <span className="mark" aria-hidden="true" />;
}

/** The emblem and the name, linking home. */
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
      <Mark />
      {/* The name is one word, in one colour. */}
      <span className="wordmark-text">SaplingDex</span>
    </a>
  );
}
