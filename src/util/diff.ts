/** Minimal line diff (LCS) producing unified-diff style output. Good enough for single objects. */
export function unifiedDiff(a: string, b: string, context = 2, labels: [string, string] = ["before", "after"]): string {
  const A = a.replace(/\r\n/g, "\n").split("\n");
  const B = b.replace(/\r\n/g, "\n").split("\n");
  if (a === b) return "(no changes)";
  const n = A.length;
  const m = B.length;
  if (n * m > 6_000_000) return `(too large to diff: ${n} vs ${m} lines)`;
  // LCS table (row-major, Uint32Array).
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  type Op = { t: " " | "-" | "+"; s: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      ops.push({ t: " ", s: A[i], ai: i, bi: j });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ t: "-", s: A[i], ai: i, bi: j });
      i++;
    } else {
      ops.push({ t: "+", s: B[j], ai: i, bi: j });
      j++;
    }
  }
  while (i < n) ops.push({ t: "-", s: A[i], ai: i++, bi: j });
  while (j < m) ops.push({ t: "+", s: B[j], ai: i, bi: j++ });

  const out: string[] = [`--- ${labels[0]}`, `+++ ${labels[1]}`];
  let k = 0;
  while (k < ops.length) {
    while (k < ops.length && ops[k].t === " ") k++;
    if (k >= ops.length) break;
    const start = Math.max(0, k - context);
    let end = k;
    // Extend the hunk while changes are within 2*context lines of each other.
    for (;;) {
      while (end < ops.length && ops[end].t !== " ") end++;
      let look = end;
      while (look < ops.length && ops[look].t === " " && look - end < 2 * context) look++;
      if (look < ops.length && ops[look].t !== " ") {
        end = look;
        continue;
      }
      break;
    }
    const stop = Math.min(ops.length, end + context);
    const first = ops[start];
    const aCount = ops.slice(start, stop).filter((o) => o.t !== "+").length;
    const bCount = ops.slice(start, stop).filter((o) => o.t !== "-").length;
    out.push(`@@ -${first.ai + 1},${aCount} +${first.bi + 1},${bCount} @@`);
    for (let q = start; q < stop; q++) out.push(`${ops[q].t}${ops[q].s}`);
    k = stop;
  }
  return out.join("\n");
}
