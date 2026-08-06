const fs = require('node:fs/promises');
const path = require('node:path');

const { minify } = require('terser');

const JAVASCRIPT_PROTOCOL = 'javascript:';

function assertNonEmptySource(source) {
  if (typeof source !== 'string') {
    throw new TypeError('Bookmarklet source must be a string.');
  }

  if (source.trim().length === 0) {
    throw new Error('Bookmarklet source must not be empty.');
  }
}

function encodeJavaScriptSource(source) {
  assertNonEmptySource(source);

  // encodeURIComponent leaves these characters untouched. Encoding them too
  // keeps quotes and punctuation out of the generated HTML attribute entirely.
  return encodeURIComponent(source).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function createBookmarkletHref(source) {
  return `${JAVASCRIPT_PROTOCOL}${encodeJavaScriptSource(source)}`;
}

function escapeHtmlAttribute(value) {
  if (typeof value !== 'string') {
    throw new TypeError('HTML attribute value must be a string.');
  }

  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function renderPage(source) {
  const href = escapeHtmlAttribute(createBookmarkletHref(source));

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CGV 자동 예매 북마클릿</title>
  <style>
    body { font-family: sans-serif; max-width: 640px; margin: 0 auto; padding: 20px }
    a { padding: 5px 20px; background-color: #8888ff; color: white; text-decoration: none }
  </style>
</head>
<body>
  <h3>아래 버튼을 북마크바에 드래그해 넣으세요</h3>
  <p><a href="${href}">CGV 자동 예매</a></p>
  <h3>사용 방법</h3>
  <ol>
    <li>CGV에서 상영 시간과 관람 인원을 선택합니다.</li>
    <li>좌석 영역의 <strong>선택</strong> 버튼을 눌러 좌석 창을 엽니다.</li>
    <li>북마크를 실행하고 선호 좌석을 순서대로 고른 뒤 감시를 시작합니다.</li>
  </ol>
  <p>좌석 확보 후 결제 화면까지 자동 이동할지는 실행 패널에서 선택할 수 있습니다.</p>
</body>
</html>
`;
}

async function build({
  sourcePath = path.join(__dirname, 'bookmarklet.js'),
  outputPath = path.join(__dirname, 'dist', 'index.html'),
} = {}) {
  const source = await fs.readFile(sourcePath, 'utf8');
  assertNonEmptySource(source);

  const result = await minify(source);
  const minifiedSource = result.code;
  assertNonEmptySource(minifiedSource);

  const html = renderPage(minifiedSource);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, html, 'utf8');

  return { html, minifiedSource, outputPath };
}

if (require.main === module) {
  build()
    .then(({ outputPath }) => {
      process.stdout.write(`Built ${path.relative(process.cwd(), outputPath)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  JAVASCRIPT_PROTOCOL,
  build,
  createBookmarkletHref,
  encodeJavaScriptSource,
  escapeHtmlAttribute,
  renderPage,
};
