// Literal Nu/parseCommandArgs implementation captured from OMP's native
// AgentSession.#ri dispatch path. Default mode deliberately preserves backslashes.
function Nu(e, t) {
  const s = [];
  let o = "";
  let n = null;
  let r = false;
  for (let i = 0;i < e.length; i++) {
    const a = e[i];
    if (t?.strict && a === "\\" && n !== "'") {
      const l = e[i + 1];
      if (l === undefined)
        throw new Error("Incomplete command escape.");
      if (n === null || l === '"' || l === "\\" || l === "$" || l === "`") {
        o += l;
        r = true;
        i++;
        continue;
      }
    }
    if (n) {
      if (a === n) {
        n = null;
      } else {
        o += a;
      }
    } else if (a === '"' || a === "'") {
      n = a;
      r = true;
    } else if (a === " " || a === "\t") {
      if (o || t?.strict && r) {
        s.push(o);
        o = "";
        r = false;
      }
    } else {
      o += a;
      r = true;
    }
  }
  if (t?.strict && n)
    throw new Error("Unterminated command quote.");
  if (o || t?.strict && r) {
    s.push(o);
  }
  return s;
}
export { Nu as parseNativeCommandArgs };
