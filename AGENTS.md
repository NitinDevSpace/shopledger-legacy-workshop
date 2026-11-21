# ShopLedger

## Stack

Node.js with CommonJS, Express 4, and `body-parser`. The browser UI uses plain HTML, CSS, and JavaScript. The app persists data in a local JSON file.

## Commands

- `npm install` installs the declared dependencies.
- `npm start` runs `server.js` on port 3000 by default. Set `PORT` to override it.
- `node --check <file>` checks JavaScript syntax.
- `npm test` is a placeholder that exits with status 1.

## Module map

| Path | Responsibility |
| --- | --- |
| `server.js` | Serves the browser UI and printable invoices, and mounts the API routers. |
| `public/` | Browser UI and API calls. |
| `routes/` | Products and coupons, orders, customers and khata settlements, reports, pricing preview, and admin export. |
| `lib/` | Orders, stock, khata balances, pricing, coupons, GST, invoices, reports, and date helpers. `lib/store.js` handles JSON persistence and audit entries. |
| `config.js` | Application settings. |
| `data/db.json` | Tracked application database. |

## Rules

- Write and run characterization tests that capture current behaviour before changing it.
- Change only the module the ticket is about.
- Tests must never read from or write to `data/db.json`. Use separate test fixtures.
- Add no dependencies.
