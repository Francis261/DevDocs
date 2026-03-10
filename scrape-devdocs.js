#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const cheerio = require('cheerio');

const execFileAsync = promisify(execFile);

const BASE_URL = 'https://devdocs.io';
const DOCS_ORIGIN = 'https://documents.devdocs.io';
const DOCS_CATALOG_URL = 'https://devdocs.io/docs/docs.json';
const DEFAULT_OUTPUT_ROOT = path.join(process.cwd(), 'datas', 'devdocs');
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_RETRIES = 3;

function printUsage() {
  console.error(`Usage:
  node scrape-devdocs.js <category>
  node scrape-devdocs.js <category>/<subCategory>
  node scrape-devdocs.js <category>/<sub1>,<sub2>,<sub3>
  node scrape-devdocs.js <category> <sub1>, <sub2>, <sub3>

Examples:
  node scrape-devdocs.js javascript
  node scrape-devdocs.js javascript/array
  node scrape-devdocs.js javascript/array,classes,math
  node scrape-devdocs.js javascript array, classes, math

Options:
  --limit <n>
  --concurrency <n>
  --retries <n>
  --output <path>
  --force`);
}

function normalizeLookup(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_\-]+/g, '');
}

function sanitizeSegment(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '') || 'untitled';
}

function sanitizeLabel(value) {
  return String(value)
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.\s]+|[-.\s]+$/g, '') || 'untitled';
}

function shortHash(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).slice(0, 8);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    target: null,
    selectors: [],
    limit: null,
    concurrency: DEFAULT_CONCURRENCY,
    retries: DEFAULT_RETRIES,
    outputRoot: DEFAULT_OUTPUT_ROOT,
    force: false,
  };

  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const [flag, rawValue] = token.split('=');
    const nextValue = rawValue ?? args[i + 1];

    if (flag === '--limit' && /^\d+$/.test(nextValue || '')) {
      options.limit = Number(nextValue);
      if (rawValue === undefined) i += 1;
    } else if (flag === '--concurrency' && /^\d+$/.test(nextValue || '')) {
      options.concurrency = Math.max(1, Number(nextValue));
      if (rawValue === undefined) i += 1;
    } else if (flag === '--retries' && /^\d+$/.test(nextValue || '')) {
      options.retries = Math.max(1, Number(nextValue));
      if (rawValue === undefined) i += 1;
    } else if (flag === '--output' && nextValue) {
      options.outputRoot = path.resolve(nextValue);
      if (rawValue === undefined) i += 1;
    } else if (flag === '--force') {
      options.force = true;
    }
  }

  if (positional.length === 0) return options;

  options.target = positional[0];
  const trailing = positional.slice(1).join(' ');
  if (trailing.trim()) {
    options.selectors.push(...trailing.split(',').map((v) => v.trim()).filter(Boolean));
  }

  return options;
}

async function fetchJsonWithCurl(url, retries) {
  let latestError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const { stdout } = await execFileAsync(
        'curl',
        ['--fail', '--silent', '--show-error', '--location', '--retry', '2', '--retry-delay', '1', url],
        { maxBuffer: 120 * 1024 * 1024 },
      );
      return JSON.parse(stdout);
    } catch (error) {
      latestError = error;
      if (attempt < retries) console.warn(`Retry ${attempt}/${retries - 1}: ${url}`);
    }
  }
  throw latestError;
}

async function fetchCategoryIndex(category, retries) {
  return fetchJsonWithCurl(`${DOCS_ORIGIN}/${encodeURIComponent(category)}/index.json`, retries);
}

async function fetchCategoryDb(category, retries) {
  return fetchJsonWithCurl(`${DOCS_ORIGIN}/${encodeURIComponent(category)}/db.json`, retries);
}

async function fetchDocsCatalog(retries) {
  return fetchJsonWithCurl(DOCS_CATALOG_URL, retries);
}

function parseTarget(target) {
  const input = String(target || '').trim();
  if (!input) return { category: null, selectors: [] };

  const slash = input.indexOf('/');
  if (slash === -1) {
    return { category: input, selectors: [] };
  }

  const category = input.slice(0, slash).trim();
  const selectorText = input.slice(slash + 1).trim();
  const selectors = selectorText ? selectorText.split(',').map((v) => v.trim()).filter(Boolean) : [];
  return { category, selectors };
}

function resolveTypeSelection(types, selectors) {
  if (!selectors.length) return { selectedTypeNames: new Set(types.map((t) => t.name)), unmatched: [] };

  const byNormalized = new Map();
  for (const type of types) {
    byNormalized.set(normalizeLookup(type.name), type.name);
    byNormalized.set(normalizeLookup(type.slug), type.name);
  }

  const selected = new Set();
  const unmatched = [];
  for (const selector of selectors) {
    const key = normalizeLookup(selector);
    const found = byNormalized.get(key);
    if (found) selected.add(found);
    else unmatched.push(selector);
  }

  return { selectedTypeNames: selected, unmatched };
}

function normalizeWhitespace(text) {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function listToMarkdown($, listNode, depth = 0) {
  const ordered = listNode.tagName.toLowerCase() === 'ol';
  const lines = [];

  $(listNode).children('li').each((idx, li) => {
    const liNode = $(li);
    const textOnly = normalizeWhitespace(liNode.clone().children('ul,ol').remove().end().text());
    const marker = ordered ? `${idx + 1}.` : '-';
    const indent = '  '.repeat(depth);
    if (textOnly) lines.push(`${indent}${marker} ${textOnly}`);

    liNode.children('ul,ol').each((_, nested) => {
      const nestedMd = listToMarkdown($, nested, depth + 1);
      if (nestedMd) lines.push(nestedMd);
    });
  });

  return lines.join('\n');
}

function htmlToMarkdown(html, fallbackTitle) {
  const $ = cheerio.load(`<article>${html}</article>`);

  $('script,style,noscript,nav,aside,form,button,.bc-data,.baseline-indicator,.metadata,.reference-tools,.interactive').remove();

  const blocks = [];
  $('article').find('h1,h2,h3,h4,h5,h6,p,ul,ol,pre').each((_, node) => {
    const tag = node.tagName.toLowerCase();

    if (/^h[1-6]$/.test(tag)) {
      const text = normalizeWhitespace($(node).text());
      if (text) blocks.push(`${'#'.repeat(Number(tag[1]))} ${text}`);
      return;
    }

    if (tag === 'p') {
      const text = normalizeWhitespace($(node).text());
      if (text) blocks.push(text);
      return;
    }

    if (tag === 'pre') {
      const code = $(node).text().replace(/\n+$/g, '');
      if (code.trim()) blocks.push(`\`\`\`\n${code}\n\`\`\``);
      return;
    }

    if (tag === 'ul' || tag === 'ol') {
      const listMd = listToMarkdown($, node, 0);
      if (listMd) blocks.push(listMd);
    }
  });

  const markdown = blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return markdown || `# ${fallbackTitle}\n\nNo parsable content found.`;
}

function stripDuplicateTopHeading(title, markdown) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^#\\s+${escaped}\\n\\n`, 'i');
  return markdown.replace(regex, '');
}

function getEntryHtml(db, entryPath) {
  return db[entryPath] || db[`/${entryPath}`] || null;
}

function buildUniqueOutputPlan(entries, outputRoot, category, typeMap) {
  const usedPaths = new Set();

  return entries.map((entry) => {
    const typeInfo = typeMap.get(entry.type) || { name: entry.type, slug: sanitizeSegment(entry.type) };
    const typeFolder = sanitizeSegment(typeInfo.name || typeInfo.slug || entry.type || 'misc');
    const baseFileName = `${sanitizeLabel(entry.name)}.md`;
    const basePath = path.join(outputRoot, sanitizeSegment(category), typeFolder, baseFileName);

    if (!usedPaths.has(basePath)) {
      usedPaths.add(basePath);
      return { entry, outputPath: basePath, collisionResolved: false };
    }

    const ext = path.extname(basePath);
    const stem = basePath.slice(0, -ext.length);
    let candidate = `${stem}--${shortHash(entry.path)}${ext}`;
    let attempt = 1;
    while (usedPaths.has(candidate)) {
      candidate = `${stem}--${shortHash(`${entry.path}-${attempt}`)}${ext}`;
      attempt += 1;
    }
    usedPaths.add(candidate);
    return { entry, outputPath: candidate, collisionResolved: true };
  });
}

async function withConcurrency(items, concurrency, worker) {
  let pointer = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (pointer < items.length) {
      const index = pointer;
      pointer += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function readManifest(manifestPath) {
  try {
    return JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch {
    return { entries: {}, category: null, docMtime: null };
  }
}

async function run() {
  const args = parseArgs(process.argv);
  if (!args.target) {
    printUsage();
    process.exit(1);
  }

  const parsedTarget = parseTarget(args.target);
  const category = sanitizeSegment(parsedTarget.category || '');
  if (!category) {
    printUsage();
    process.exit(1);
  }

  const selectorList = [...parsedTarget.selectors, ...args.selectors];
  await fs.mkdir(args.outputRoot, { recursive: true });

  const [docsCatalog, indexJson, dbJson] = await Promise.all([
    fetchDocsCatalog(args.retries),
    fetchCategoryIndex(category, args.retries),
    fetchCategoryDb(category, args.retries),
  ]);

  const docInfo = Array.isArray(docsCatalog)
    ? docsCatalog.find((d) => normalizeLookup(d.slug) === normalizeLookup(category) || normalizeLookup(d.name) === normalizeLookup(category))
    : null;

  const typeMap = new Map((indexJson.types || []).map((t) => [t.name, t]));
  const { selectedTypeNames, unmatched } = resolveTypeSelection(indexJson.types || [], selectorList);
  if (selectorList.length && selectedTypeNames.size === 0) {
    throw new Error(`None of the requested sub-categories were found: ${selectorList.join(', ')}`);
  }
  if (unmatched.length > 0) {
    console.warn(`Warning: these sub-categories were not found and were ignored: ${unmatched.join(', ')}`);
  }

  const visited = new Set();
  let entries = (indexJson.entries || []).filter((entry) => {
    const key = `${category}/${entry.path}`;
    if (visited.has(key)) return false;
    visited.add(key);
    if (!selectorList.length) return true;
    return selectedTypeNames.has(entry.type);
  });

  if (args.limit) entries = entries.slice(0, args.limit);

  const plans = buildUniqueOutputPlan(entries, args.outputRoot, category, typeMap);
  const collisions = plans.filter((p) => p.collisionResolved).length;

  const categoryRoot = path.join(args.outputRoot, sanitizeSegment(category));
  const manifestPath = path.join(categoryRoot, '_manifest.json');
  const oldManifest = await readManifest(manifestPath);
  const newManifest = {
    category,
    docMtime: docInfo?.mtime ?? null,
    generatedAt: new Date().toISOString(),
    entries: {},
  };

  console.log(`Category=${category} | pages=${entries.length} | concurrency=${args.concurrency} | retries=${args.retries}`);
  if (selectorList.length) console.log(`Selected sub-categories: ${[...selectedTypeNames].join(', ')}`);
  if (collisions > 0) console.warn(`Resolved ${collisions} filename collisions by appending stable hash suffixes.`);

  let success = 0;
  let skipped = 0;
  let failed = 0;
  const failedEntries = [];

  await withConcurrency(plans, args.concurrency, async (plan, idx) => {
    const { entry, outputPath } = plan;
    const sourceUrl = `${BASE_URL}/${category}/${entry.path}`;
    const relativePath = path.relative(process.cwd(), outputPath);

    try {
      const html = getEntryHtml(dbJson, entry.path);
      if (!html) throw new Error('content missing from db.json');

      const htmlHash = shortHash(html);
      newManifest.entries[entry.path] = { hash: htmlHash, file: relativePath, updatedAt: new Date().toISOString() };

      const existsAndSame =
        !args.force
        && oldManifest.entries
        && oldManifest.entries[entry.path]
        && oldManifest.entries[entry.path].hash === htmlHash
        && oldManifest.entries[entry.path].file === relativePath;

      if (existsAndSame) {
        try {
          await fs.access(outputPath);
          skipped += 1;
          process.stdout.write(`[${idx + 1}/${entries.length}] ${entry.path} ... skipped\n`);
          return;
        } catch {
          // file missing, write again
        }
      }

      process.stdout.write(`[${idx + 1}/${entries.length}] ${entry.path} ... `);
      let markdownBody = htmlToMarkdown(html, entry.name || entry.path);
      const extractedHeading = markdownBody.match(/^#\s+(.+)$/m)?.[1];
      const title = extractedHeading || entry.name || entry.path;
      markdownBody = stripDuplicateTopHeading(title, markdownBody);

      const finalContent = `# ${title}\n\nSource: ${sourceUrl}\n\n${markdownBody}\n`;
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, finalContent, 'utf8');

      success += 1;
      console.log(`saved ${relativePath}`);
    } catch (error) {
      failed += 1;
      failedEntries.push({ path: entry.path, error: error.message });
      console.log(`[${idx + 1}/${entries.length}] ${entry.path} ... failed (${error.message})`);
    }
  });

  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(newManifest, null, 2), 'utf8');

  if (failedEntries.length > 0) {
    const failedReportPath = path.join(categoryRoot, '_failed-pages.json');
    await fs.writeFile(failedReportPath, JSON.stringify(failedEntries, null, 2), 'utf8');
    console.log(`Failed page report written to ${path.relative(process.cwd(), failedReportPath)}`);
  }

  console.log(`\nCompleted. Saved: ${success}, Skipped unchanged: ${skipped}, Failed: ${failed}, Total matched: ${entries.length}.`);
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
