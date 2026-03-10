# DevDocs Scraper

Download DevDocs documentation as structured markdown files for AI datasets / RAG ingestion.

## Install

```bash
npm install
```

## Run

```bash
node scrape-devdocs.js javascript
node scrape-devdocs.js html
node scrape-devdocs.js css
node scrape-devdocs.js node
```

Optional arguments:

```bash
node scrape-devdocs.js javascript 200
node scrape-devdocs.js javascript --limit 200 --concurrency 8 --retries 4
node scrape-devdocs.js javascript --output datas/devdocs
```

## Output

Files are saved under:

```text
datas/devdocs/<category>/...
```

Each markdown file includes:
- Title
- Source URL
- Main documentation content (headings, paragraphs, lists, code blocks)

The scraper excludes UI/navigation elements and preserves code blocks.
