/**
 * DeepSeek's retainMinimumHeightWhenStreaming: the live reply never gets
 * shorter while it streams. The live-text filter withholds a half-written table
 * and a re-parsed block can collapse, which would jump the page under the reader.
 *
 * The minimum is the tallest height seen. It is released by unmounting the
 * element (the caller renders it only while streaming), so the settled message
 * lands in the same commit with nothing left to correct. It sits on the reply,
 * above the SendAnchor end marker, so it only ever adds room the reply had.
 */
export function retainMinHeight(el: HTMLElement): () => void {
  let max = 0;
  const observer = new ResizeObserver(() => {
    const height = el.offsetHeight;
    if (height <= max) return;
    max = height;
    el.style.minHeight = `${max}px`;
  });
  observer.observe(el);
  return () => observer.disconnect();
}
