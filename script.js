/* globals bootstrap */
import { render, html } from "https://cdn.jsdelivr.net/npm/lit-html@3/+esm";
import { unsafeHTML } from "https://cdn.jsdelivr.net/npm/lit-html@3/directives/unsafe-html.js";
import { dsvFormat, autoType } from "https://cdn.jsdelivr.net/npm/d3-dsv@3/+esm";
import { Marked } from "https://cdn.jsdelivr.net/npm/marked@13/+esm";
import { markedHighlight } from "https://cdn.jsdelivr.net/npm/marked-highlight@2/+esm";
import hljs from "https://cdn.jsdelivr.net/npm/highlight.js@11/+esm";

// Add this database configuration
const dbConfig = {
  user: 'your_username',
  host: 'your_host',
  database: 'your_database',
  password: 'your_password',
  port: 5432, // default PostgreSQL port
};

// Initialize PostgreSQL client
import pg from 'https://cdn.jsdelivr.net/npm/pg@8/+esm';
const { Pool } = pg;
const pool = new Pool(dbConfig);

// Set up DOM elements
const $demos = document.querySelector("#demos");
const $upload = document.getElementById("upload");
const $tablesContainer = document.getElementById("tables-container");
const $sql = document.getElementById("sql");
const $toast = document.getElementById("toast");
const $result = document.getElementById("result");
const toast = new bootstrap.Toast($toast);
const loading = html`<div class="spinner-border" role="status">
  <span class="visually-hidden">Loading...</span>
</div>`;

let latestQueryResult = [];
// --------------------------------------------------------------------
// Set up Markdown
const marked = new Marked(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : "plaintext";
      return hljs.highlight(code, { language }).value;
    },
  })
);

marked.use({
  renderer: {
    table(header, body) {
      return `<table class="table table-sm">${header}${body}</table>`;
    },
  },
});

// --------------------------------------------------------------------
// Set up LLM tokens

let token;

try {
  token = (await fetch("https://llmfoundry.straive.com/token", { credentials: "include" }).then((r) => r.json())).token;
} catch {
  token = null;
}

render(
  token
    ? html`
        <div class="mb-3">
          <label for="file" class="form-label">Upload CSV (<code>.csv</code>) or SQLite databases (<code>.sqlite3</code>, <code>.db</code>)</label>
          <input class="form-control" type="file" id="file" name="file" accept=".csv,.sqlite3,.db,.sqlite,.s3db,.sl3" multiple />
        </div>
      `
    : html`<a class="btn btn-primary" href="https://llmfoundry.straive.com/">Sign in to upload files</a>`,
  $upload
);

// --------------------------------------------------------------------
// Render demos

fetch("config.json")
  .then((r) => r.json())
  .then(({ demos }) =>
    render(
      demos.map(
        ({ title, body, file, questions }) =>
          html` <div class="col py-3">
            <a class="demo card h-100 text-decoration-none" href="${file}" data-questions=${JSON.stringify(questions ?? [])}>
              <div class="card-body">
                <h5 class="card-title">${title}</h5>
                <p class="card-text">${body}</p>
              </div>
            </a>
          </div>`
      ),
      $demos
    )
  );

$demos.addEventListener("click", async (e) => {
  const $demo = e.target.closest(".demo");
  if ($demo) {
    e.preventDefault();
    const file = $demo.getAttribute("href");
    render(html`<div class="text-center my-3">${loading}</div>`, $tablesContainer);
    await DB.upload(new File([await fetch(file).then((r) => r.blob())], file.split("/").pop()));
    const questions = JSON.parse($demo.dataset.questions);
    if (questions.length) {
      DB.questionInfo.schema = JSON.stringify(DB.schema());
      DB.questionInfo.questions = questions;
    }
    drawTables();
  }
});

// --------------------------------------------------------------------
// Manage database tables
const DB = {
  schema: async function () {
    let tables = [];
    const query = `
      SELECT 
        table_name as name,
        'CREATE TABLE ' || table_name || ' (' || 
        string_agg(
          column_name || ' ' || data_type || 
          CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END,
          ', '
        ) || ')' as sql
      FROM information_schema.columns 
      WHERE table_schema = 'public'
      GROUP BY table_name;
    `;
    
    const { rows: tableList } = await pool.query(query);
    
    for (const table of tableList) {
      const columnQuery = `
        SELECT 
          column_name as name,
          data_type as type,
          CASE WHEN is_nullable = 'NO' THEN 1 ELSE 0 END as notnull,
          column_default as dflt_value,
          CASE WHEN pk.column_name IS NOT NULL THEN 1 ELSE 0 END as pk
        FROM information_schema.columns c
        LEFT JOIN (
          SELECT ku.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage ku
            ON tc.constraint_name = ku.constraint_name
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_name = $1
        ) pk ON c.column_name = pk.column_name
        WHERE table_name = $1
      `;
      
      const { rows: columns } = await pool.query(columnQuery, [table.name]);
      table.columns = columns;
      tables.push(table);
    }
    return tables;
  },

  questionInfo: {},
  
  questions: async function () {
    if (DB.questionInfo.schema !== JSON.stringify(await DB.schema())) {
      const response = await llm({
        system: "Suggest 5 diverse, useful questions that a user can answer from this dataset using SQL",
        user: (await DB.schema())
          .map(({ sql }) => sql)
          .join("\n\n"),
        schema: {
          type: "object",
          properties: { questions: { type: "array", items: { type: "string" }, additionalProperties: false } },
          required: ["questions"],
          additionalProperties: false,
        },
      });
      if (response.error) DB.questionInfo.error = response.error;
      else DB.questionInfo.questions = response.questions;
      DB.questionInfo.schema = JSON.stringify(await DB.schema());
    }
    return DB.questionInfo;
  },

  insertRows: async function (tableName, result) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Create table by auto-detecting column types
      const cols = Object.keys(result[0]);
      const typeMap = Object.fromEntries(
        cols.map((col) => {
          const sampleValue = result[0][col];
          let sqlType = 'TEXT';
          if (typeof sampleValue === 'number') sqlType = Number.isInteger(sampleValue) ? 'INTEGER' : 'DECIMAL';
          else if (typeof sampleValue === 'boolean') sqlType = 'BOOLEAN';
          else if (sampleValue instanceof Date) sqlType = 'TIMESTAMP';
          return [col, sqlType];
        })
      );

      const createTableSQL = `CREATE TABLE IF NOT EXISTS "${tableName}" (${
        cols.map(col => `"${col}" ${typeMap[col]}`).join(', ')
      })`;
      await client.query(createTableSQL);

      // Insert data
      const values = result.map(row => 
        cols.map(col => row[col] instanceof Date ? row[col].toISOString() : row[col])
      );
      
      const insertSQL = `
        INSERT INTO "${tableName}" (${cols.map(col => `"${col}"`).join(', ')})
        VALUES ${values.map((_, i) => `(${cols.map((_, j) => `$${i * cols.length + j + 1}`).join(', ')})`).join(', ')}
      `;
      
      await client.query(insertSQL, values.flat());
      await client.query('COMMIT');
      notify('success', 'Imported', `Imported table: ${tableName}`);
    } catch (error) {
      await client.query('ROLLBACK');
      notify('danger', 'Error', `Failed to import table: ${error.message}`);
      throw error;
    } finally {
      client.release();
    }
  }
};

$upload.addEventListener("change", async (e) => {
  const uploadPromises = Array.from(e.target.files).map((file) => DB.upload(file));
  await Promise.all(uploadPromises);
  drawTables();
});

// --------------------------------------------------------------------
// Render tables

async function drawTables() {
  const schema = DB.schema();

  const tables = html`
    <div class="accordion narrative mx-auto" id="table-accordion" style="--bs-accordion-btn-padding-y: 0.5rem">
      ${schema.map(
        ({ name, sql, columns }) => html`
          <div class="accordion-item">
            <h2 class="accordion-header">
              <button
                class="accordion-button collapsed"
                type="button"
                data-bs-toggle="collapse"
                data-bs-target="#collapse-${name}"
                aria-expanded="false"
                aria-controls="collapse-${name}"
              >${name}</button>
            </h2>
            <div
              id="collapse-${name}"
              class="accordion-collapse collapse"
              data-bs-parent="#table-accordion"
            >
              <div class="accordion-body">
                <pre style="white-space: pre-wrap">${sql}</pre>
                <table class="table table-striped table-sm">
                  <thead>
                    <tr>
                      <th>Column Name</th>
                      <th>Type</th>
                      <th>Not Null</th>
                      <th>Default Value</th>
                      <th>Primary Key</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${columns.map(
                      (column) => html`
                        <tr>
                          <td>${column.name}</td>
                          <td>${column.type}</td>
                          <td>${column.notnull ? "Yes" : "No"}</td>
                          <td>${column.dflt_value ?? "NULL"}</td>
                          <td>${column.pk ? "Yes" : "No"}</td>
                        </tr>
                      `
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      `
      )}
    </div>
  `;

  const query = html`
    <form class="mt-4 narrative mx-auto">
      <div class="mb-3">
        <label for="query" class="form-label fw-bold">Ask a question about your data:</label>
        <textarea class="form-control" name="query" id="query" rows="3"></textarea>
      </div>
      <button type="submit" class="btn btn-primary">Submit</button>
    </form>
  `;

  render([tables, ...(schema.length ? [html`<div class="text-center my-3">${loading}</div>`, query] : [])], $tablesContainer);
  if (!schema.length) return;

  const $query = $tablesContainer.querySelector("#query");
  $query.scrollIntoView({ behavior: "smooth", block: "center" });
  $query.focus();
  DB.questions().then(({ questions, error }) => {
    if (error) return notify("danger", "Error", JSON.stringify(error));
    render(
      [
        tables,
        html`<div class="mx-auto narrative my-3">
          <h2 class="h6">Sample questions</h2>
          <ul>
            ${questions.map((q) => html`<li><a href="#" class="question">${q}</a></li>`)}
          </ul>
        </div>`,
        query,
      ],
      $tablesContainer
    );
    $query.focus();
  });
}

// --------------------------------------------------------------------
// Handle chat

$tablesContainer.addEventListener("click", async (e) => {
  const $question = e.target.closest(".question");
  if ($question) {
    e.preventDefault();
    $tablesContainer.querySelector("#query").value = $question.textContent;
    $tablesContainer.querySelector('form button[type="submit"]').click();
  }
});

$tablesContainer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const formData = new FormData(e.target);
  const query = formData.get("query");
  render(html`<div class="text-center my-3">${loading}</div>`, $sql);
  render(html``, $result);
  const result = await llm({
    system: `You'll answer the user's question based on this SQLite schema:

${DB.schema()
  .map(({ sql }) => sql)
  .join("\n\n")}

1. Guess my objective in asking this.
2. Describe the steps to achieve this objective in SQL.
3. Write SQL to answer the question. Use SQLite sytax.

Replace generic filter values (e.g. "a location", "specific region", etc.) by querying a random value from data.
Wrap columns with spaces inside [].`,
    user: query,
  });
  render(html`${unsafeHTML(marked.parse(result))}`, $sql);

  // Extract everything inside {lang?}...```
  const sql = result.match(/```.*?\n(.*?)```/s)?.[1] ?? result;
  const data = (await pool.query(sql)).rows;

  // Render the data using the utility function
  if (data.length > 0) {
    latestQueryResult = data;
    const downloadButton = html`
      <button id="download-button" type="button" class="btn btn-primary">
        <i class="bi bi-filetype-csv"></i>
        Download CSV
      </button>
    `;
    const tableHtml = renderTable(data.slice(0, 100));
    render([downloadButton, tableHtml], $result);
  } else {
    render(html`<p>No results found.</p>`, $result);
  }
});

// --------------------------------------------------------------------
// Utilities

function notify(cls, title, message) {
  $toast.querySelector(".toast-title").textContent = title;
  $toast.querySelector(".toast-body").textContent = message;
  const $toastHeader = $toast.querySelector(".toast-header");
  $toastHeader.classList.remove("text-bg-success", "text-bg-danger", "text-bg-warning", "text-bg-info");
  $toastHeader.classList.add(`text-bg-${cls}`);
  toast.show();
}

async function llm({ system, user, schema }) {
  const response = await fetch("https://llmfoundry.straive.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}:datachat` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      ...(schema ? { response_format: { type: "json_schema", json_schema: { name: "response", strict: true, schema } } } : {}),
    }),
  }).then((r) => r.json());
  if (response.error) return response;
  const content = response.choices?.[0]?.message?.content;
  try {
    return schema ? JSON.parse(content) : content;
  } catch (e) {
    return { error: e };
  }
}

// Utility function to render a table
function renderTable(data) {
  const columns = Object.keys(data[0]);
  return html`
    <table class="table table-striped table-hover">
      <thead>
        <tr>
          ${columns.map((col) => html`<th>${col}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${data.map(
          (row) => html`
            <tr>
              ${columns.map((col) => html`<td>${row[col]}</td>`)}
            </tr>
          `
        )}
      </tbody>
    </table>
  `;
}

$result.addEventListener("click", (e) => {
  const $downloadButton = e.target.closest("#download-button");
  if ($downloadButton && latestQueryResult.length > 0) {
    download(dsvFormat(",").format(latestQueryResult), "datachat.csv", "text/csv");
  }
});

// --------------------------------------------------------------------
// Function to download CSV file
function download(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// Add this cleanup function to close the database connection when needed
window.addEventListener('beforeunload', () => {
  pool.end();
});
