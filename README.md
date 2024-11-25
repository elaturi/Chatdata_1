# DataChat

Interactive tool for exploring and analyzing datasets through natural language conversations.

## Features

- Natural language queries to SQL translation
- Support for multiple data formats:
  - CSV files
  - SQLite databases (.sqlite3, .db)
- Real-time data exploration
- Interactive table previews
- Smart question suggestions
- Pre-built dataset demos:
  - Card Transactions Analysis
  - HR Employee Data
  - Marvel Character Powers
- Dark mode support

## Usage

1. Upload your data files (CSV or SQLite)
2. View table schemas and sample data
3. Ask questions in natural language
4. Get SQL queries and visualized results
5. Try suggested sample questions
6. Explore pre-built demo datasets

## Setup

### Prerequisites

- Modern web browser with ES Modules support
- Web server for local development

### Local Setup

1. Clone this repository:

```bash
git clone https://github.com/gramener/datachat.git
cd datachat
```

2. Serve the files using any static web server. For example, using Python:

```bash
python -m http.server
```

3. Open `http://localhost:8000` in your web browser

## Deployment

On [Cloudflare DNS](https://dash.cloudflare.com), proxy CNAME `datachat.straive.app` to `gramener.github.io`.

On this repository's [page settings](https://github.com/gramener/datachat/settings/pages), set

- Source: `Deploy from a branch`
- Branch: `main`
- Folder: `/`

## Technical Details

### Architecture

- Frontend: Vanilla JavaScript with lit-html for rendering
- Database: SQLite WASM for client-side data processing
- LLM Integration: GPT-4o Mini through LLM Foundry API
- Styling: Bootstrap 5.3.3 with dark mode support

### Dependencies

All dependencies are loaded via CDN:

- [SQLite WASM](https://sqlite.org/wasm) v3.46 - Database operations
- [lit-html](https://lit.dev) v3 - Template rendering
- [Bootstrap](https://getbootstrap.com) v5.3.3 - UI components
- [D3-dsv](https://d3js.org/d3-dsv) v3 - CSV parsing
- [marked](https://marked.js.org/) v13 - Markdown parsing
- [highlight.js](https://highlightjs.org/) v11 - Code syntax highlighting

## License

[MIT](LICENSE)
