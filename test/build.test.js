const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  JAVASCRIPT_PROTOCOL,
  TARGETS,
  build,
  buildAll,
  createBookmarkletHref,
  escapeHtmlAttribute,
  renderPage,
} = require('../build');

test('build targets map each bookmarklet source to its public page', () => {
  assert.deepEqual(
    TARGETS.map(({ id, sourceFile, outputFile }) => ({
      id,
      sourceFile,
      outputFile,
    })),
    [
      {
        id: 'cgv',
        sourceFile: 'bookmarklet.js',
        outputFile: 'index.html',
      },
      {
        id: 'megabox',
        sourceFile: 'megabox-bookmarklet.js',
        outputFile: 'megabox.html',
      },
    ],
  );
});

test('bookmarklet href round-trips the complete JavaScript source', () => {
  const source = `(() => { const selector = "#seat"; return selector + '&'; })();`;
  const href = createBookmarkletHref(source);

  assert.ok(href.startsWith(JAVASCRIPT_PROTOCOL));
  assert.equal(
    decodeURIComponent(href.slice(JAVASCRIPT_PROTOCOL.length)),
    source,
  );
});

test('bookmarklet href encodes fragments and both kinds of quote', () => {
  const href = createBookmarkletHref(`location.hash = "#screen's-seat";`);

  assert.doesNotMatch(href, /[#"']/);
  assert.match(href, /%23/);
  assert.match(href, /%22/);
  assert.match(href, /%27/);
});

test('HTML attribute escaping covers all attribute-significant characters', () => {
  assert.equal(
    escapeHtmlAttribute(`&<>"'`),
    '&amp;&lt;&gt;&quot;&#39;',
  );
});

test('empty bookmarklet source is rejected', () => {
  assert.throws(() => createBookmarkletHref(''), /must not be empty/);
  assert.throws(() => renderPage(' \n\t'), /must not be empty/);
});

test('rendered page contains one safe, reversible bookmarklet attribute', () => {
  const source = `alert('\"><img src=x onerror=alert(1)>#seat&done');`;
  const html = renderPage(source);
  const hrefMatch = html.match(/<a href="([^"]+)">CGV 자동 예매<\/a>/);

  assert.match(html, /^<!doctype html>/);
  assert.ok(hrefMatch, 'bookmarklet link should be present');
  assert.doesNotMatch(hrefMatch[1], /[#"'<>]/);
  assert.equal(
    decodeURIComponent(hrefMatch[1].slice(JAVASCRIPT_PROTOCOL.length)),
    source,
  );
  assert.doesNotMatch(html, /<img src=x/);
});

test('each target renders its own branding and a reversible bookmarklet', () => {
  const source = `(() => { location.hash = "#screen's-seat&done"; })();`;

  for (const target of TARGETS) {
    const html = renderPage(source, target);
    const linkPattern = new RegExp(
      `<a href="([^"]+)">${target.linkText}<\\/a>`,
    );
    const hrefMatch = html.match(linkPattern);

    assert.match(html, new RegExp(`<title>${target.title}<\\/title>`));
    assert.ok(hrefMatch, `${target.id} bookmarklet link should be present`);
    assert.equal(
      decodeURIComponent(hrefMatch[1].slice(JAVASCRIPT_PROTOCOL.length)),
      source,
    );
    assert.ok(
      target.instructions.every((instruction) => html.includes(instruction)),
      `${target.id} instructions should be present`,
    );
  }

  assert.doesNotMatch(renderPage(source, TARGETS[1]), /CGV 자동 예매/);
});

test('build minifies source and writes a complete HTML document', async (context) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cgv-bot-build-'));
  context.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));

  const sourcePath = path.join(temporaryDirectory, 'bookmarklet.js');
  const outputPath = path.join(temporaryDirectory, 'nested', 'index.html');
  await fs.writeFile(sourcePath, 'function greet(name) { return "hello " + name; } greet("CGV");');

  const result = await build({ sourcePath, outputPath });
  const writtenHtml = await fs.readFile(outputPath, 'utf8');

  assert.equal(writtenHtml, result.html);
  assert.ok(result.minifiedSource.length > 0);
  assert.ok(result.minifiedSource.length < 67);
  assert.match(writtenHtml, /<\/html>\n$/);
  assert.match(writtenHtml, /href="javascript:/);
});

test('buildAll writes the CGV and Megabox pages to a configurable directory', async (context) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cgv-bot-build-all-'));
  context.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));

  const results = await buildAll({ outputDirectory: temporaryDirectory });
  const outputNames = results.map(({ outputPath }) => path.basename(outputPath));
  const writtenNames = await fs.readdir(temporaryDirectory);

  assert.deepEqual(outputNames, ['index.html', 'megabox.html']);
  assert.deepEqual(writtenNames.sort(), ['index.html', 'megabox.html']);

  for (const [index, target] of TARGETS.entries()) {
    const outputPath = path.join(temporaryDirectory, target.outputFile);
    const writtenHtml = await fs.readFile(outputPath, 'utf8');
    const hrefMatch = writtenHtml.match(/<a href="([^"]+)">/);

    assert.equal(results[index].outputPath, outputPath);
    assert.equal(results[index].html, writtenHtml);
    assert.match(writtenHtml, new RegExp(`<title>${target.title}<\\/title>`));
    assert.match(writtenHtml, new RegExp(`>${target.linkText}<\\/a>`));
    assert.ok(hrefMatch, `${target.id} bookmarklet link should be present`);
    assert.ok(hrefMatch[1].startsWith(JAVASCRIPT_PROTOCOL));
    assert.equal(
      decodeURIComponent(hrefMatch[1].slice(JAVASCRIPT_PROTOCOL.length)),
      results[index].minifiedSource,
    );
  }
});
