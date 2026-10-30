// 本スキャン要約アプリ — AIプロキシサーバー（依存パッケージなし / Node.js 18+）
// APIキーは環境変数 ANTHROPIC_API_KEY にのみ置く。フロントエンドには一切渡さない。
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const APP_PASSCODE = process.env.APP_PASSCODE || ''; // 任意: 設定すると合言葉なしでは使えない
const PUBLIC_DIR = __dirname;
// 公開してよいファイルだけを配信（server.js などは配信しない）
const PUBLIC_FILES = new Set(['/index.html','/sw.js','/manifest.webmanifest','/icon.svg','/icon-192.png','/icon-512.png']);
const MAX_BODY = 25 * 1024 * 1024; // 25MB

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

// 簡易レート制限（IPごと 1分あたり30回）
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 30;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('送信データが大きすぎます'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('リクエストの形式が不正です'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

async function callClaude({ system, content, maxTokens }) {
  const r = await fetch((process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || `AI APIエラー (${r.status})`;
    throw Object.assign(new Error(msg), { status: r.status === 401 ? 502 : (r.status === 429 ? 429 : 502), upstream: r.status });
  }
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

const OCR_SYSTEM = `あなたは書籍ページのOCR専門アシスタントです。与えられた画像の文字を忠実に書き起こします。
ルール:
- 見えている文字だけを書き起こす。推測で補わない。読めない箇所は「[判読不能]」と書く。
- 見出しは「# 」「## 」で、本文は段落ごとに空行で区切り、読み順を保つ。
- 表は Markdown の表で、図は「[図: 見える範囲の説明]」と書く。読み取れない図表は「[図表: 読み取れませんでした]」。
- ページ番号が画像内に印刷されていれば最初の行に「[印刷ページ番号: N]」と書く。なければ書かない。
- 各画像は「=== 画像 K ===」の行で始め、K は与えられた画像番号とする。
- 書き起こし以外の前置きや感想は書かない。`;

const SUM_SYSTEM = `あなたは大学生の学習を支援するアシスタントです。与えられた本の書き起こしテキストだけを根拠に整理します。
厳守:
- 書き起こしに無い情報を追加しない。一般知識での補足が必要な場合は「(補足)」と明記し、本文由来と区別する。
- 出典は「画像N」で示す（Nは「=== 画像 N ===」の番号）。重要ポイントや用語には必ず出典を付ける。
- [判読不能] の箇所は推測せず、読めなかった旨を扱う。
- 出力は指定されたJSONのみ。説明文やコードフェンスは付けない。`;

function purposeText(p) {
  return ({
    concise: '短く簡潔にまとめる',
    detailed: '詳しくまとめる',
    points: '重要ポイント中心にまとめる',
    lecture: '大学の授業での復習用にまとめる',
    presentation: '発表準備用にまとめる',
    report: 'レポート作成用にまとめる',
    beginner: '初心者にもわかりやすく説明する',
  })[p] || '大学の授業用にまとめる';
}
function lengthText(l) { return ({ short: '短め', normal: '標準', long: '詳しめ' })[l] || '標準'; }

function extractJson(text) {
  const s = text.indexOf('{'); const e = text.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('AIの応答を解析できませんでした');
  return JSON.parse(text.slice(s, e + 1));
}

async function handleApi(req, res, url) {
  const ip = req.socket.remoteAddress || 'x';
  if (url.pathname === '/api/status') {
    return sendJson(res, 200, { aiConfigured: !!API_KEY, needsPasscode: !!APP_PASSCODE });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POSTのみ対応しています' });
  if (rateLimited(ip)) return sendJson(res, 429, { error: 'リクエストが多すぎます。少し待ってからやり直してください。' });
  if (APP_PASSCODE && req.headers['x-app-passcode'] !== APP_PASSCODE) {
    return sendJson(res, 401, { error: '合言葉が違います。' });
  }
  if (!API_KEY) {
    return sendJson(res, 503, { error: 'AIが設定されていません。サーバーの環境変数 ANTHROPIC_API_KEY を設定してください。（AIが動作していないため結果は生成されません）' });
  }
  const body = await readBody(req);

  if (url.pathname === '/api/ocr') {
    // body: { images: [{ index, dataUrl }] }  数枚ずつ送られる
    const imgs = Array.isArray(body.images) ? body.images : [];
    if (!imgs.length || imgs.length > 6) return sendJson(res, 400, { error: '画像は1〜6枚で送ってください。' });
    const content = [];
    for (const im of imgs) {
      const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(im.dataUrl || '');
      if (!m) return sendJson(res, 400, { error: '画像の形式が不正です。' });
      content.push({ type: 'text', text: `画像 ${im.index}:` });
      content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
    }
    content.push({ type: 'text', text: '上の画像を順に書き起こしてください。' });
    const text = await callClaude({ system: OCR_SYSTEM, content, maxTokens: 6000 });
    return sendJson(res, 200, { text });
  }

  if (url.pathname === '/api/summarize') {
    const { stage, text, options = {}, partials } = body;
    if (stage === 'chunk') {
      // 長い資料の部分要約（map）
      if (!text) return sendJson(res, 400, { error: 'テキストがありません。' });
      const prompt = `次は本の一部の書き起こしです。後で全体を統合するための「部分メモ」をJSONで作ってください。
形式: {"summary":"この部分の要約","headings":["見出し"],"points":[{"text":"重要事項","pages":[画像番号]}],"terms":[{"term":"用語","meaning":"本文に基づく意味","pages":[画像番号]}],"unreadable":"読めなかった箇所の説明(なければ空文字)"}

--- 書き起こし ---
${text}`;
      const out = await callClaude({ system: SUM_SYSTEM, content: prompt, maxTokens: 3500 });
      return sendJson(res, 200, { result: extractJson(out) });
    }
    if (stage === 'final') {
      // 統合（reduce）。text か partials のどちらかを根拠にする
      const source = partials ? `部分メモ(JSON配列):\n${JSON.stringify(partials)}` : `書き起こし:\n${text}`;
      const wantSpeech = !!options.speech, wantReport = !!options.report;
      const lenGuide = { short: '各項目は簡潔に', normal: '各項目は標準的な分量で', long: '各項目は詳細に' }[options.length] || '各項目は標準的な分量で';
      const prompt = `次の資料を、目的「${purposeText(options.purpose)}」、長さ「${lengthText(options.length)}」（${lenGuide}）で整理してください。
複数ページを総合して要約し、ページごとの要約の羅列にはしないでください。出典は画像番号の配列で示します。

出力はJSONのみ:
{
 "title":"資料にふさわしいタイトル(30字以内)",
 "overall":"①全体の要約",
 "chapters":[{"heading":"章・見出し","summary":"要約","pages":[画像番号]}],
 "points":[{"text":"重要ポイント(3〜7個)","pages":[画像番号]}],
 "terms":[{"term":"用語","meaning":"わかりやすい説明","pages":[画像番号]}],
 "explanation":"⑤大学生向けの詳しい解説(難しい内容を噛み砕く)",
 "presentation":"⑥発表用まとめ(自然な文章)",
 "speech":${wantSpeech ? '{"m1":"1分(約300字)の原稿","m3":"3分(約900字)の原稿","m5":"5分(約1500字)の原稿"}' : 'null'},
 "report":${wantReport ? '{"theme":"テーマ","issues":["論点"],"outline":[{"section":"章立て","content":"書く内容"}]}' : 'null'},
 "unreadable":"読み取れなかった箇所があれば説明、なければ空文字"
}

${source}`;
      const out = await callClaude({ system: SUM_SYSTEM, content: prompt, maxTokens: 8000 });
      return sendJson(res, 200, { result: extractJson(out) });
    }
    return sendJson(res, 400, { error: 'stageが不正です。' });
  }
  return sendJson(res, 404, { error: '見つかりません' });
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  if (!PUBLIC_FILES.has(p)) { res.writeHead(404); return res.end('Not found'); }
  const file = path.join(PUBLIC_DIR, p);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' || p === '/sw.js' ? 'no-cache' : 'public, max-age=3600' });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e.message);
    sendJson(res, e.status || 500, { error: e.message || 'サーバーエラーが発生しました。' });
  }
}).listen(PORT, () => {
  console.log(`起動しました: http://localhost:${PORT}  (AI: ${API_KEY ? '設定済み' : '未設定'})`);
});
