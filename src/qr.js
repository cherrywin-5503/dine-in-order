// 二维码生成（不依赖第三方库）：字节模式，纠错等级 M，版本 1~10，输出 SVG。
// 用来生成"店内统一点餐码"（FR-01）。已用 OpenCV 解码器验证。
const EXP = new Array(512), LOG = new Array(256);
(function () { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGen(n) { let g = [1]; for (let i = 0; i < n; i++) { const ng = new Array(g.length + 1).fill(0); for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= mul(g[j], EXP[i]); } g = ng; } return g; }
function rsEncode(data, n) { const g = rsGen(n), r = new Array(n).fill(0); for (const d of data) { const f = d ^ r[0]; r.shift(); r.push(0); for (let i = 0; i < n; i++) r[i] ^= mul(g[i + 1], f); } return r; }

// 版本 1~10、纠错 M：[总码字, 每块纠错码字数, [块数, 每块数据码字数, 块数2, 每块数据码字数2]]
const VER = [null,
  [26, 10, [1, 16]], [44, 16, [1, 28]], [70, 26, [1, 44]], [100, 18, [2, 32]], [134, 24, [2, 43]],
  [172, 16, [4, 27]], [196, 18, [4, 31]], [242, 22, [2, 38, 2, 39]], [292, 22, [3, 36, 2, 37]], [346, 26, [4, 43, 1, 44]]];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

function bch(v, poly, bits) { let d = v << bits; const hb = (x) => 31 - Math.clz32(x); while (hb(d) >= hb(poly)) d ^= poly << (hb(d) - hb(poly)); return (v << bits) | d; }

function build(text) {
  const bytes = [...Buffer.from(text, 'utf8')];
  let ver = 1;
  const cap = (v) => { const [, , b] = VER[v]; return b[0] * b[1] + (b[2] ? b[2] * b[3] : 0); };
  while (ver <= 10 && bytes.length + (ver < 10 ? 2 : 3) > cap(ver)) ver++;
  if (ver > 10) throw new Error('文本太长');
  const [total, ecLen, b] = VER[ver];
  const dataCap = cap(ver);
  // 数据位流
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  put(0b0100, 4); put(bytes.length, ver < 10 ? 8 : 16);
  bytes.forEach((x) => put(x, 8));
  put(0, Math.min(4, dataCap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const cw = []; for (let i = 0; i < bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0; cw.length < dataCap; pad++) cw.push(pad % 2 ? 0x11 : 0xec);
  // 分块 + 纠错
  const blocks = []; let pos = 0;
  [[b[0], b[1]], b[2] ? [b[2], b[3]] : null].filter(Boolean).forEach(([n, len]) => { for (let i = 0; i < n; i++) { const d = cw.slice(pos, pos + len); pos += len; blocks.push({ d, e: rsEncode(d, ecLen) }); } });
  const final = [];
  const maxD = Math.max(...blocks.map((x) => x.d.length));
  for (let i = 0; i < maxD; i++) blocks.forEach((x) => { if (i < x.d.length) final.push(x.d[i]); });
  for (let i = 0; i < ecLen; i++) blocks.forEach((x) => final.push(x.e[i]));
  // 矩阵
  const N = 17 + 4 * ver;
  const M = Array.from({ length: N }, () => new Array(N).fill(null));
  const fn = Array.from({ length: N }, () => new Array(N).fill(false));
  const set = (r, c, v, f = true) => { if (r >= 0 && r < N && c >= 0 && c < N) { M[r][c] = v; if (f) fn[r][c] = true; } };
  const finder = (r, c) => { for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) { const on = i >= 0 && i <= 6 && j >= 0 && j <= 6 && (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4)); set(r + i, c + j, on ? 1 : 0); } };
  finder(0, 0); finder(0, N - 7); finder(N - 7, 0);
  for (let i = 8; i < N - 8; i++) { set(6, i, i % 2 ? 0 : 1); set(i, 6, i % 2 ? 0 : 1); }
  const al = ALIGN[ver];
  for (const r of al) for (const c of al) { if ((r === 6 && c === 6) || (r === 6 && c === al[al.length - 1]) || (c === 6 && r === al[al.length - 1])) continue; for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) set(r + i, c + j, Math.max(Math.abs(i), Math.abs(j)) !== 1 ? 1 : 0); }
  set(N - 8, 8, 1);
  for (let i = 0; i < 9; i++) { fn[8][i] = true; fn[i][8] = true; } for (let i = 0; i < 8; i++) { fn[8][N - 1 - i] = true; fn[N - 1 - i][8] = true; }
  if (ver >= 7) { const v = bch(ver, 0x1f25, 12); for (let i = 0; i < 18; i++) { const bit = (v >> i) & 1; set(Math.floor(i / 3), N - 11 + (i % 3), bit); set(N - 11 + (i % 3), Math.floor(i / 3), bit); } }
  // 数据放置
  const dbits = []; final.forEach((x) => { for (let i = 7; i >= 0; i--) dbits.push((x >> i) & 1); });
  let bi = 0, up = true;
  for (let c = N - 1; c > 0; c -= 2) {
    if (c === 6) c--;
    for (let k = 0; k < N; k++) { const r = up ? N - 1 - k : k; for (let j = 0; j < 2; j++) { const cc = c - j; if (!fn[r][cc]) { M[r][cc] = bi < dbits.length ? dbits[bi++] : 0; } } }
    up = !up;
  }
  const masks = [(r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0, (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0];
  const applyFmt = (G, mask) => {
    const f = bch((0b00 << 3) | mask, 0x537, 10) ^ 0x5412; // 纠错等级 M = 00
    const bit = (i) => (f >> i) & 1;
    for (let i = 0; i < 6; i++) G[i][8] = bit(i); G[7][8] = bit(6); G[8][8] = bit(7); G[8][7] = bit(8);
    for (let i = 9; i < 15; i++) G[8][14 - i] = bit(i);
    for (let i = 0; i < 8; i++) G[8][N - 1 - i] = bit(i); for (let i = 8; i < 15; i++) G[N - 15 + i][8] = bit(i);
    G[N - 8][8] = 1;
  };
  const penalty = (G) => {
    let p = 0;
    for (let a = 0; a < N; a++) for (const row of [true, false]) { let run = 1; for (let i = 1; i < N; i++) { const x = row ? G[a][i] === G[a][i - 1] : G[i][a] === G[i - 1][a]; if (x) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
    for (let r = 0; r < N - 1; r++) for (let c = 0; c < N - 1; c++) if (G[r][c] === G[r][c + 1] && G[r][c] === G[r + 1][c] && G[r][c] === G[r + 1][c + 1]) p += 3;
    const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], pat2 = [...pat].reverse();
    for (let a = 0; a < N; a++) for (let i = 0; i + 11 <= N; i++) for (const row of [true, false]) { const seg = []; for (let k = 0; k < 11; k++) seg.push(row ? G[a][i + k] : G[i + k][a]); if (seg.every((v, k) => v === pat[k]) || seg.every((v, k) => v === pat2[k])) p += 40; }
    let dark = 0; G.forEach((r) => r.forEach((v) => { dark += v; })); p += Math.floor(Math.abs((dark * 100) / (N * N) - 50) / 5) * 10;
    return p;
  };
  let best = null, bestP = Infinity;
  for (let m = 0; m < 8; m++) {
    const G = M.map((r) => r.slice());
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (!fn[r][c] && masks[m](r, c)) G[r][c] ^= 1;
    applyFmt(G, m);
    const p = penalty(G); if (p < bestP) { bestP = p; best = G; }
  }
  return best;
}

function toSvg(text, px = 6) {
  const G = build(text), N = G.length, q = 4, S = (N + q * 2) * px;
  let d = '';
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (G[r][c]) d += `M${(c + q) * px},${(r + q) * px}h${px}v${px}h-${px}z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}"><rect width="${S}" height="${S}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
module.exports = { toSvg, build };
