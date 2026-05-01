# 🛒 Grocery Tracker

A personal grocery spending tracker built for Costco shopping. Tracks prices, compares products, and visualizes spending trends across trips.

## Features

- **Item Catalog** — 304 products across 38 receipts (Jan 2024–Mar 2026), searchable and sortable
- **Price History** — Tap any item to see price trends over time with interactive charts
- **Item Metadata** — Add friendly names, categories, brands, organic flags, package sizes, and notes
- **Unit Pricing** — Set package sizes (oz, lb, ct, etc.) to see price-per-unit with automatic conversion between units
- **Purchase Quantity** — Adjust for double-buys (e.g., 2 cartons of eggs on one receipt) so averages stay accurate
- **Compare Groups** — Group similar items (e.g., all egg types) and compare unit prices side by side with a "Best Value" badge
- **Spending Trends** — Monthly and quarterly spending charts, category breakdowns, trip history
- **Google Sheets Sync** — Tap "Sync ☁️" to save all your edits to a Google Sheet, accessible from any device

## Tech Stack

- **React 18** (via CDN + Babel standalone)
- **Recharts** for data visualization
- **Google Sheets API** for cloud persistence
- **localStorage** for fast local caching
- **GitHub Pages** for hosting

## Setup

The app is live at: **https://sushify.github.io/grocery-tracker**

### Add to Home Screen (recommended)

On iPhone/iPad: Open the URL in Safari → tap the Share button → "Add to Home Screen"

This makes it look and feel like a native app.

### Google Sheets Sync

The app works offline with localStorage. To enable cross-device sync:

1. Tap the **"Sync ☁️"** button in the top-right corner
2. Sign in with your Google account
3. The app creates ItemEdits, PurchaseQty, and CompareGroups tabs in your linked Google Sheet
4. All edits sync automatically after sign-in

## Data

Receipt data is baked into `data.js`. To add new receipts:

1. Bring receipt PDFs to Claude (in the Grocery Tracker project)
2. Claude parses the receipts and updates `data.js`
3. Push the updated file to this repo

Your annotations (names, categories, brands, notes, package sizes, compare groups, purchase quantities) are stored separately — in localStorage on each device, and in Google Sheets when synced. They persist across receipt data updates.

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell, CSS, script loading |
| `app.js` | React components, UI logic, Google Sheets integration |
| `data.js` | Baked-in receipt data (38 receipts, 582 line items) |
| `manifest.json` | PWA manifest for home screen install |

## Categories

Produce · Meat · Seafood · Dairy · Eggs · Bread & Bakery · Pantry Staples · Snacks · Beverages · Frozen · Baby (Diapers/Wipes) · Baby (Food) · Health & Medicine · Beauty & Personal Care · Cleaning & Household · Paper Products · Kitchen Supplies · Laundry · Gift Cards · Clothing · Electronics · Toys & Kids · Pets · Other
# grocery-tracker
