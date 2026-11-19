/**
 * Headline words that sharpen in one after another (the locked "blur-in
 * headline" text effect).
 *
 * Pure CSS on purpose: the words are in the server HTML and the animation runs
 * from the stylesheet, so the headline is readable before React hydrates and
 * with JavaScript off. Under prefers-reduced-motion the animation never
 * applies and the words simply render. See `.blur-in-word` in motion.css.
 */
export function BlurInText({ children, delayMs = 0 }) {
  const words = String(children).split(/(\s+)/);
  let index = 0;
  return words.map((part, i) => {
    if (/^\s+$/.test(part) || part === '') return part;
    const style = { '--i': index, '--d': `${delayMs}ms` };
    index += 1;
    return (
      <span key={i} className="blur-in-word" style={style}>
        {part}
      </span>
    );
  });
}
