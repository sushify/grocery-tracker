// ─── Config ──────────────────────────────────────
const CONFIG = {
  CLIENT_ID: "192264497169-jdoiga0ausbh3mec9ipmgc0l0dbdq90g.apps.googleusercontent.com",
  SHEET_ID: "1droo0jobES_8T_TgIED0WlKYPnOxcpgLat52WgzG9qI",
  SCOPES: "https://www.googleapis.com/auth/spreadsheets",
  STORAGE_KEY: "costco-tracker-edits"
};
const CATEGORIES = ["Produce", "Meat", "Seafood", "Dairy", "Eggs", "Bread & Bakery", "Pantry Staples", "Snacks", "Beverages", "Frozen", "Baby - Diapers/Wipes", "Baby - Food", "Health & Medicine", "Beauty & Personal Care", "Cleaning & Household", "Paper Products", "Kitchen Supplies", "Laundry", "Gift Cards", "Clothing", "Electronics", "Toys & Kids", "Pets", "Other"];
const COLORS = ["#4a7a9b", "#c8a87c", "#6b9e78", "#c47a5a", "#8b7bb8", "#d4a03c", "#5b8a8a", "#b85c6f", "#7a9b4a", "#a07050", "#6a8fc4", "#c4956a", "#8a6b9e", "#4a9b8a"];
const UNIT_GROUPS = {
  weight: {
    label: "Weight",
    units: ["oz", "lb", "g", "kg"],
    factors: {
      oz: 1,
      lb: 16,
      g: 0.035274,
      kg: 35.274
    }
  },
  volume: {
    label: "Volume",
    units: ["fl oz", "cup", "pt", "qt", "gal", "mL", "L"],
    factors: {
      "fl oz": 1,
      cup: 8,
      pt: 16,
      qt: 32,
      gal: 128,
      mL: 0.033814,
      L: 33.814
    }
  },
  count: {
    label: "Count",
    units: ["ct", "pack", "dozen", "pair"],
    factors: {
      ct: 1,
      pack: 1,
      dozen: 12,
      pair: 2
    }
  }
};

// ─── Recharts destructure ────────────────────────
const {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid
} = Recharts;

// ─── Utilities ───────────────────────────────────
function getUnitGroup(unit) {
  if (!unit) return null;
  return Object.values(UNIT_GROUPS).find(g => g.units.includes(unit));
}
function convert(val, from, to) {
  const g = getUnitGroup(from);
  if (!g || !g.factors[from] || !g.factors[to]) return val;
  return val * g.factors[from] / g.factors[to];
}
function getCompatUnits(unit) {
  if (!unit) return [];
  const g = getUnitGroup(unit);
  return g ? g.units.filter(u => u !== unit) : [];
}
function fmt(d) {
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}
function fmtShort(d) {
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit"
  });
}
function $(n) {
  return "$" + n.toFixed(2);
}
function $p(n) {
  return n < 0.01 ? "<$0.01" : n < 1 ? "$" + n.toFixed(3) : "$" + n.toFixed(2);
}
function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pqKey(itemNum, date) {
  return itemNum + "|" + date;
}
function buildCatalog(receipts) {
  const items = {};
  receipts.forEach(r => {
    r.items.forEach(i => {
      if (!items[i.itemNum]) items[i.itemNum] = {
        desc: i.desc,
        appearances: [],
        totalSpent: 0,
        totalDiscount: 0
      };
      items[i.itemNum].appearances.push({
        date: r.date,
        price: i.price,
        discount: i.discount,
        net: i.price - i.discount
      });
      items[i.itemNum].totalSpent += i.price - i.discount;
      items[i.itemNum].totalDiscount += i.discount;
    });
  });
  return items;
}

// ─── Google Sheets API ───────────────────────────
const SheetsAPI = {
  token: null,
  async ensureTabs() {
    // Check if our edit tabs exist, create if not
    try {
      const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}?fields=sheets.properties.title`, {
        headers: {
          Authorization: `Bearer ${this.token}`
        }
      });
      const data = await resp.json();
      const existing = data.sheets?.map(s => s.properties.title) || [];
      const needed = ["ItemEdits", "PurchaseQty", "CompareGroups"];
      const missing = needed.filter(t => !existing.includes(t));
      if (missing.length > 0) {
        const requests = missing.map(title => ({
          addSheet: {
            properties: {
              title
            }
          }
        }));
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}:batchUpdate`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            requests
          })
        });
        // Add headers to new tabs
        const headerMap = {
          ItemEdits: ["itemNum", "friendlyName", "category", "brand", "organic", "pkgQty", "pkgUnit", "notes"],
          PurchaseQty: ["itemNum", "date", "qty"],
          CompareGroups: ["groupId", "groupName", "groupNotes", "itemNum"]
        };
        for (const tab of missing) {
          await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${tab}!A1:H1?valueInputOption=RAW`, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${this.token}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              values: [headerMap[tab]]
            })
          });
        }
      }
    } catch (e) {
      console.error("ensureTabs error:", e);
    }
  },
  async readEdits() {
    const edits = {
      names: {},
      cats: {},
      quantities: {},
      meta: {},
      groups: {},
      purchaseQty: {}
    };
    try {
      // Read ItemEdits
      const ie = await this._readRange("ItemEdits!A2:H");
      if (ie) ie.forEach(row => {
        const num = row[0];
        if (row[1]) edits.names[num] = row[1];
        if (row[2]) edits.cats[num] = row[2];
        if (row[3] || row[4] || row[7]) edits.meta[num] = {
          brand: row[3] || "",
          organic: row[4] === "TRUE",
          notes: row[7] || ""
        };
        if (row[5] && row[6]) edits.quantities[num] = {
          qty: parseFloat(row[5]),
          unit: row[6]
        };
      });
      // Read PurchaseQty
      const pq = await this._readRange("PurchaseQty!A2:C");
      if (pq) pq.forEach(row => {
        if (row[0] && row[1] && row[2]) edits.purchaseQty[pqKey(row[0], row[1])] = parseInt(row[2]);
      });
      // Read CompareGroups
      const cg = await this._readRange("CompareGroups!A2:D");
      if (cg) {
        const gmap = {};
        cg.forEach(row => {
          const gid = row[0];
          if (!gmap[gid]) gmap[gid] = {
            name: row[1] || "",
            notes: row[2] || "",
            items: []
          };
          if (row[3]) gmap[gid].items.push(row[3]);
        });
        edits.groups = gmap;
      }
    } catch (e) {
      console.error("readEdits error:", e);
    }
    return edits;
  },
  async writeAllEdits(edits) {
    try {
      // Write ItemEdits - clear and rewrite
      const ieRows = [];
      const allNums = new Set([...Object.keys(edits.names), ...Object.keys(edits.cats), ...Object.keys(edits.quantities), ...Object.keys(edits.meta)]);
      allNums.forEach(num => {
        const md = edits.meta[num] || {};
        const qd = edits.quantities[num] || {};
        ieRows.push([num, edits.names[num] || "", edits.cats[num] || "", md.brand || "", md.organic ? "TRUE" : "FALSE", qd.qty || "", qd.unit || "", md.notes || ""]);
      });
      await this._clearAndWrite("ItemEdits", ["itemNum", "friendlyName", "category", "brand", "organic", "pkgQty", "pkgUnit", "notes"], ieRows);

      // Write PurchaseQty
      const pqRows = Object.entries(edits.purchaseQty).filter(([, v]) => v > 1).map(([k, v]) => {
        const [itemNum, date] = k.split("|");
        return [itemNum, date, String(v)];
      });
      await this._clearAndWrite("PurchaseQty", ["itemNum", "date", "qty"], pqRows);

      // Write CompareGroups
      const cgRows = [];
      Object.entries(edits.groups).forEach(([gid, g]) => {
        if (g.items.length === 0) cgRows.push([gid, g.name, g.notes, ""]);else g.items.forEach(num => cgRows.push([gid, g.name, g.notes, num]));
      });
      await this._clearAndWrite("CompareGroups", ["groupId", "groupName", "groupNotes", "itemNum"], cgRows);
    } catch (e) {
      console.error("writeAllEdits error:", e);
    }
  },
  async _readRange(range) {
    const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${encodeURIComponent(range)}`, {
      headers: {
        Authorization: `Bearer ${this.token}`
      }
    });
    const data = await resp.json();
    return data.values || null;
  },
  async _clearAndWrite(tab, headers, rows) {
    // Clear existing data
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${tab}!A:H:clear`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json"
      }
    });
    // Write headers + rows
    const values = [headers, ...rows];
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${tab}!A1?valueInputOption=RAW`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        values
      })
    });
  }
};

// ─── localStorage helpers (fast local cache) ─────
function localLoad() {
  try {
    const s = localStorage.getItem(CONFIG.STORAGE_KEY);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}
function localSave(d) {
  try {
    localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(d));
  } catch (e) {
    console.error(e);
  }
}

// ─── Shared UI Components ────────────────────────
function EditField({
  value,
  onSave,
  type = "text",
  options = [],
  placeholder = ""
}) {
  const [e, setE] = React.useState(false);
  const [d, setD] = React.useState(value);
  if (!e) {
    return /*#__PURE__*/React.createElement("span", {
      onClick: () => {
        setD(value);
        setE(true);
      },
      style: {
        cursor: "pointer",
        borderBottom: "1px dashed #bbb"
      }
    }, value || /*#__PURE__*/React.createElement("span", {
      style: {
        color: "#ccc"
      }
    }, placeholder || "tap to edit"));
  }
  if (type === "select") {
    return /*#__PURE__*/React.createElement("select", {
      autoFocus: true,
      value: d,
      onChange: ev => {
        onSave(ev.target.value);
        setE(false);
      },
      onBlur: () => setE(false),
      style: {
        font: "inherit",
        padding: "4px 6px",
        borderRadius: 6,
        border: "1px solid #ccc",
        fontSize: 13,
        maxWidth: "100%"
      }
    }, options.map(o => /*#__PURE__*/React.createElement("option", {
      key: o,
      value: o
    }, o)));
  }
  return /*#__PURE__*/React.createElement("input", {
    autoFocus: true,
    value: d,
    onChange: ev => setD(ev.target.value),
    onBlur: () => {
      onSave(d);
      setE(false);
    },
    onKeyDown: ev => {
      if (ev.key === "Enter") {
        onSave(d);
        setE(false);
      }
      if (ev.key === "Escape") setE(false);
    },
    placeholder: placeholder,
    style: {
      font: "inherit",
      padding: "4px 8px",
      borderRadius: 6,
      border: "1px solid #ccc",
      width: "100%",
      fontSize: 13,
      boxSizing: "border-box"
    }
  });
}
function Badge({
  text,
  color = "#4a7a9b",
  bg = "#edf4f8"
}) {
  return /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      padding: "2px 7px",
      borderRadius: 99,
      background: bg,
      color,
      fontWeight: 500,
      whiteSpace: "nowrap"
    }
  }, text);
}
function Card({
  children,
  style = {}
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#fff",
      borderRadius: 12,
      border: "1px solid #e2e0dc",
      overflow: "hidden",
      marginBottom: 12,
      ...style
    }
  }, children);
}
function Section({
  title,
  children,
  action
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#f8f7f4",
      borderRadius: 8,
      padding: "10px 12px",
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: children ? 6 : 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      fontWeight: 500,
      color: "#666"
    }
  }, title), action), children);
}
function QtyBadge({
  qty,
  onChange
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(String(qty));
  if (editing) {
    return /*#__PURE__*/React.createElement("span", {
      style: {
        display: "inline-flex",
        gap: 3,
        alignItems: "center"
      }
    }, /*#__PURE__*/React.createElement("input", {
      value: draft,
      onChange: e => setDraft(e.target.value),
      type: "number",
      min: "1",
      step: "1",
      autoFocus: true,
      onBlur: () => {
        const v = parseInt(draft);
        if (v > 0) onChange(v);
        setEditing(false);
      },
      onKeyDown: e => {
        if (e.key === "Enter") {
          const v = parseInt(draft);
          if (v > 0) onChange(v);
          setEditing(false);
        }
        if (e.key === "Escape") setEditing(false);
      },
      style: {
        width: 36,
        padding: "2px 4px",
        borderRadius: 4,
        border: "1px solid #4a7a9b",
        fontSize: 12,
        textAlign: "center"
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 10,
        color: "#aaa"
      }
    }, "\xD7"));
  }
  return /*#__PURE__*/React.createElement("span", {
    onClick: () => {
      setDraft(String(qty));
      setEditing(true);
    },
    style: {
      cursor: "pointer",
      fontSize: 11,
      padding: "1px 6px",
      borderRadius: 4,
      background: qty > 1 ? "#edf4f8" : "#f5f3ef",
      color: qty > 1 ? "#4a7a9b" : "#bbb",
      border: "1px solid " + (qty > 1 ? "#c8dde8" : "#e8e6e2")
    }
  }, qty, "\xD7");
}

// ─── Item Detail ─────────────────────────────────
function ItemDetail({
  itemNum,
  catalog,
  state,
  dispatch,
  onBack
}) {
  const item = catalog[itemNum];
  if (!item) return null;
  const {
    names,
    cats,
    quantities,
    meta,
    groups,
    purchaseQty
  } = state;
  const name = names[itemNum] || item.desc;
  const cat = cats[itemNum] || "Other";
  const qd = quantities[itemNum] || {};
  const md = meta[itemNum] || {};
  const sorted = [...item.appearances].sort((a, b) => a.date.localeCompare(b.date));
  const unitPrices = sorted.map(e => {
    const pq = purchaseQty[pqKey(itemNum, e.date)] || 1;
    return {
      ...e,
      pq,
      unitPrice: e.net / pq
    };
  });
  const ups = unitPrices.map(e => e.unitPrice);
  const mn = Math.min(...ups),
    mx = Math.max(...ups),
    avg = ups.reduce((a, b) => a + b, 0) / ups.length,
    med = median(ups);
  const [editPkgSize, setEditPkgSize] = React.useState(false);
  const [draftQty, setDraftQty] = React.useState(qd.qty || "");
  const [draftUnit, setDraftUnit] = React.useState(qd.unit || "oz");
  const [convertUnit, setConvertUnit] = React.useState(null);
  const [editNotes, setEditNotes] = React.useState(false);
  const [draftNotes, setDraftNotes] = React.useState(md.notes || "");
  const [editBrand, setEditBrand] = React.useState(false);
  const [draftBrand, setDraftBrand] = React.useState(md.brand || "");
  const [showGroupPicker, setShowGroupPicker] = React.useState(false);
  const [newGroupName, setNewGroupName] = React.useState("");
  const itemGroup = Object.entries(groups).find(([, g]) => g.items.includes(itemNum));
  const compatUnits = getCompatUnits(qd.unit);
  const chartData = unitPrices.map(e => ({
    date: fmtShort(e.date),
    price: e.unitPrice,
    ...(qd.qty && qd.unit ? {
      ppu: e.unitPrice / qd.qty
    } : {})
  }));
  const chartKey = qd.qty && qd.unit ? "ppu" : "price";
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("button", {
    onClick: onBack,
    style: {
      background: "none",
      border: "none",
      color: "#4a7a9b",
      fontSize: 14,
      cursor: "pointer",
      padding: "0 0 12px",
      fontWeight: 500
    }
  }, "\u2190 Back"), /*#__PURE__*/React.createElement(Card, null, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "#aaa"
    }
  }, "#", itemNum), /*#__PURE__*/React.createElement("h2", {
    style: {
      margin: "2px 0 6px",
      fontSize: 20,
      fontFamily: "'Source Serif 4',Georgia,serif",
      fontWeight: 700
    }
  }, /*#__PURE__*/React.createElement(EditField, {
    value: name,
    onSave: v => dispatch("name", itemNum, v)
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      flexWrap: "wrap",
      alignItems: "center",
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement(EditField, {
    value: cat,
    type: "select",
    options: CATEGORIES,
    onSave: v => dispatch("cat", itemNum, v)
  }), md.organic && /*#__PURE__*/React.createElement(Badge, {
    text: "Organic",
    color: "#2d7a3a",
    bg: "#e6f4e8"
  }), md.brand && /*#__PURE__*/React.createElement(Badge, {
    text: md.brand,
    color: "#666",
    bg: "#f0eeea"
  }), qd.qty && qd.unit && /*#__PURE__*/React.createElement(Badge, {
    text: `${qd.qty} ${qd.unit}`
  })), /*#__PURE__*/React.createElement(Section, {
    title: "Details",
    action: /*#__PURE__*/React.createElement("button", {
      onClick: () => dispatch("meta", itemNum, {
        ...md,
        organic: !md.organic
      }),
      style: {
        padding: "2px 10px",
        borderRadius: 6,
        border: "1px solid " + (md.organic ? "#2d7a3a" : "#ddd"),
        background: md.organic ? "#e6f4e8" : "#fff",
        color: md.organic ? "#2d7a3a" : "#aaa",
        fontSize: 11,
        cursor: "pointer"
      }
    }, md.organic ? "✓ Organic" : "Mark Organic")
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "#aaa"
    }
  }, "Brand: "), editBrand ? /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: draftBrand,
    onChange: e => setDraftBrand(e.target.value),
    onKeyDown: e => {
      if (e.key === "Enter") {
        dispatch("meta", itemNum, {
          ...md,
          brand: draftBrand
        });
        setEditBrand(false);
      }
    },
    placeholder: "e.g. Kirkland",
    style: {
      fontSize: 13,
      padding: "2px 6px",
      borderRadius: 4,
      border: "1px solid #ccc",
      width: 120
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      dispatch("meta", itemNum, {
        ...md,
        brand: draftBrand
      });
      setEditBrand(false);
    },
    style: {
      fontSize: 11,
      padding: "2px 8px",
      borderRadius: 4,
      border: "none",
      background: "#4a7a9b",
      color: "#fff",
      cursor: "pointer"
    }
  }, "Save")) : /*#__PURE__*/React.createElement("span", {
    onClick: () => {
      setDraftBrand(md.brand || "");
      setEditBrand(true);
    },
    style: {
      fontSize: 13,
      cursor: "pointer",
      borderBottom: "1px dashed #bbb"
    }
  }, md.brand || /*#__PURE__*/React.createElement("span", {
    style: {
      color: "#ccc"
    }
  }, "add brand"))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "#aaa"
    }
  }, "Notes: "), editNotes ? /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("textarea", {
    value: draftNotes,
    onChange: e => setDraftNotes(e.target.value),
    placeholder: "Preferences...",
    rows: 3,
    style: {
      width: "100%",
      fontSize: 13,
      padding: 6,
      borderRadius: 6,
      border: "1px solid #ccc",
      boxSizing: "border-box",
      fontFamily: "inherit",
      resize: "vertical"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 4,
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      dispatch("meta", itemNum, {
        ...md,
        notes: draftNotes
      });
      setEditNotes(false);
    },
    style: {
      fontSize: 11,
      padding: "4px 12px",
      borderRadius: 4,
      border: "none",
      background: "#4a7a9b",
      color: "#fff",
      cursor: "pointer"
    }
  }, "Save"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setEditNotes(false),
    style: {
      fontSize: 11,
      padding: "4px 8px",
      borderRadius: 4,
      border: "1px solid #ddd",
      background: "#fff",
      color: "#aaa",
      cursor: "pointer"
    }
  }, "Cancel"))) : /*#__PURE__*/React.createElement("span", {
    onClick: () => {
      setDraftNotes(md.notes || "");
      setEditNotes(true);
    },
    style: {
      fontSize: 13,
      cursor: "pointer",
      borderBottom: "1px dashed #bbb"
    }
  }, md.notes || /*#__PURE__*/React.createElement("span", {
    style: {
      color: "#ccc"
    }
  }, "add notes")))), /*#__PURE__*/React.createElement(Section, {
    title: "Package Size",
    action: /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        setDraftQty(qd.qty || "");
        setDraftUnit(qd.unit || "oz");
        setEditPkgSize(!editPkgSize);
      },
      style: {
        padding: "2px 10px",
        borderRadius: 6,
        border: "1px solid #ddd",
        background: "#fff",
        fontSize: 11,
        color: "#4a7a9b",
        cursor: "pointer"
      }
    }, qd.qty ? "Edit" : "+ Add")
  }, qd.qty && qd.unit && !editPkgSize && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 15,
      fontWeight: 600
    }
  }, qd.qty, " ", qd.unit), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "#4a7a9b",
      marginTop: 2
    }
  }, "Avg: ", $p(avg / qd.qty), "/", qd.unit), compatUnits.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 4,
      marginTop: 6,
      flexWrap: "wrap"
    }
  }, compatUnits.map(u => /*#__PURE__*/React.createElement("button", {
    key: u,
    onClick: () => setConvertUnit(convertUnit === u ? null : u),
    style: {
      padding: "2px 8px",
      borderRadius: 99,
      fontSize: 10,
      cursor: "pointer",
      border: "1px solid " + (convertUnit === u ? "#4a7a9b" : "#ddd"),
      background: convertUnit === u ? "#4a7a9b" : "#fff",
      color: convertUnit === u ? "#fff" : "#888"
    }
  }, u))), convertUnit && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "#666",
      marginTop: 4
    }
  }, convert(qd.qty, qd.unit, convertUnit).toFixed(2), " ", convertUnit, " \u2192 Avg: ", $p(avg / convert(qd.qty, qd.unit, convertUnit)), "/", convertUnit)), editPkgSize && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      marginTop: 4,
      alignItems: "center",
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: draftQty,
    onChange: e => setDraftQty(e.target.value),
    placeholder: "Qty",
    type: "number",
    step: "any",
    style: {
      width: 70,
      padding: "6px 8px",
      borderRadius: 6,
      border: "1px solid #ccc",
      fontSize: 13
    }
  }), /*#__PURE__*/React.createElement("select", {
    value: draftUnit,
    onChange: e => setDraftUnit(e.target.value),
    style: {
      padding: "6px 4px",
      borderRadius: 6,
      border: "1px solid #ccc",
      fontSize: 13
    }
  }, Object.entries(UNIT_GROUPS).map(([gk, g]) => /*#__PURE__*/React.createElement("optgroup", {
    key: gk,
    label: g.label
  }, g.units.map(u => /*#__PURE__*/React.createElement("option", {
    key: u,
    value: u
  }, u))))), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      const q = parseFloat(draftQty);
      if (q > 0) dispatch("qty", itemNum, {
        qty: q,
        unit: draftUnit
      });
      setEditPkgSize(false);
    },
    style: {
      padding: "6px 12px",
      borderRadius: 6,
      background: "#4a7a9b",
      color: "#fff",
      border: "none",
      fontSize: 12,
      cursor: "pointer"
    }
  }, "Save"))), /*#__PURE__*/React.createElement(Section, {
    title: "Compare Group",
    action: !showGroupPicker && /*#__PURE__*/React.createElement("button", {
      onClick: () => setShowGroupPicker(true),
      style: {
        padding: "2px 10px",
        borderRadius: 6,
        border: "1px solid #ddd",
        background: "#fff",
        fontSize: 11,
        color: "#4a7a9b",
        cursor: "pointer"
      }
    }, itemGroup ? "Change" : "+ Assign")
  }, itemGroup && !showGroupPicker && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      fontWeight: 500
    }
  }, itemGroup[1].name), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      const u = {
        ...groups
      };
      u[itemGroup[0]] = {
        ...u[itemGroup[0]],
        items: u[itemGroup[0]].items.filter(x => x !== itemNum)
      };
      dispatch("groups", null, u);
    },
    style: {
      fontSize: 10,
      color: "#c47a5a",
      background: "none",
      border: "none",
      cursor: "pointer"
    }
  }, "Remove")), showGroupPicker && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 4
    }
  }, Object.entries(groups).map(([gid, g]) => /*#__PURE__*/React.createElement("div", {
    key: gid,
    onClick: () => {
      const u = {
        ...groups
      };
      Object.keys(u).forEach(k => {
        u[k] = {
          ...u[k],
          items: u[k].items.filter(x => x !== itemNum)
        };
      });
      u[gid] = {
        ...u[gid],
        items: [...u[gid].items, itemNum]
      };
      dispatch("groups", null, u);
      setShowGroupPicker(false);
    },
    style: {
      padding: "8px 10px",
      background: "#fff",
      borderRadius: 6,
      border: "1px solid #e2e0dc",
      marginBottom: 4,
      cursor: "pointer",
      display: "flex",
      justifyContent: "space-between"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13
    }
  }, g.name), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "#aaa"
    }
  }, g.items.length))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 4,
      marginTop: 6
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: newGroupName,
    onChange: e => setNewGroupName(e.target.value),
    placeholder: "New group name...",
    onKeyDown: e => {
      if (e.key === "Enter" && newGroupName.trim()) {
        const gid = "g_" + Date.now();
        dispatch("groups", null, {
          ...groups,
          [gid]: {
            name: newGroupName.trim(),
            items: [itemNum],
            notes: ""
          }
        });
        setShowGroupPicker(false);
        setNewGroupName("");
      }
    },
    style: {
      flex: 1,
      padding: "6px 8px",
      borderRadius: 6,
      border: "1px solid #ccc",
      fontSize: 13
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      if (!newGroupName.trim()) return;
      const gid = "g_" + Date.now();
      dispatch("groups", null, {
        ...groups,
        [gid]: {
          name: newGroupName.trim(),
          items: [itemNum],
          notes: ""
        }
      });
      setShowGroupPicker(false);
      setNewGroupName("");
    },
    style: {
      padding: "6px 10px",
      borderRadius: 6,
      background: "#4a7a9b",
      color: "#fff",
      border: "none",
      fontSize: 12,
      cursor: "pointer"
    }
  }, "Create")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowGroupPicker(false),
    style: {
      marginTop: 4,
      fontSize: 11,
      color: "#aaa",
      background: "none",
      border: "none",
      cursor: "pointer"
    }
  }, "Cancel"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr 1fr",
      gap: 8
    }
  }, [{
    l: "Bought",
    v: sorted.length + "x"
  }, {
    l: "Average",
    v: $(avg)
  }, {
    l: "Median",
    v: $(med)
  }, {
    l: "Low",
    v: $(mn)
  }, {
    l: "High",
    v: $(mx)
  }, {
    l: "Saved",
    v: $(item.totalDiscount)
  }].map(c => /*#__PURE__*/React.createElement("div", {
    key: c.l,
    style: {
      background: "#faf8f5",
      borderRadius: 8,
      padding: "8px 10px",
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: "#aaa"
    }
  }, c.l), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 600,
      fontFamily: "'DM Mono',monospace"
    }
  }, c.v)))))), sorted.length > 1 && /*#__PURE__*/React.createElement(Card, {
    style: {
      padding: "14px 8px 8px 0"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      paddingLeft: 16,
      fontSize: 13,
      fontWeight: 600,
      marginBottom: 8
    }
  }, qd.qty && qd.unit ? `Per ${qd.unit}` : "Price", " Over Time"), /*#__PURE__*/React.createElement(ResponsiveContainer, {
    width: "100%",
    height: 180
  }, /*#__PURE__*/React.createElement(LineChart, {
    data: chartData
  }, /*#__PURE__*/React.createElement(CartesianGrid, {
    strokeDasharray: "3 3",
    stroke: "#f0eeea"
  }), /*#__PURE__*/React.createElement(XAxis, {
    dataKey: "date",
    tick: {
      fontSize: 10
    }
  }), /*#__PURE__*/React.createElement(YAxis, {
    tick: {
      fontSize: 10
    },
    tickFormatter: v => $p(v),
    width: 44
  }), /*#__PURE__*/React.createElement(Tooltip, {
    formatter: v => $p(v)
  }), /*#__PURE__*/React.createElement(Line, {
    type: "monotone",
    dataKey: chartKey,
    stroke: "#4a7a9b",
    strokeWidth: 2,
    dot: {
      r: 4,
      fill: "#4a7a9b"
    }
  })))), /*#__PURE__*/React.createElement(Card, null, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "12px 16px",
      fontSize: 13,
      fontWeight: 600,
      borderBottom: "1px solid #f0eeea"
    }
  }, "Purchase History ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      fontWeight: 400,
      color: "#aaa",
      float: "right"
    }
  }, "tap qty to edit")), unitPrices.map((e, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: "flex",
      justifyContent: "space-between",
      padding: "10px 16px",
      borderBottom: i < unitPrices.length - 1 ? "1px solid #f5f3ef" : "none",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(QtyBadge, {
    qty: e.pq,
    onChange: v => dispatch("purchaseQty", pqKey(itemNum, e.date), v)
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13
    }
  }, fmt(e.date))), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "right"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "'DM Mono',monospace",
      fontWeight: 600,
      fontSize: 14
    }
  }, $(e.unitPrice), e.pq > 1 && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "#aaa",
      fontWeight: 400
    }
  }, " ea")), e.pq > 1 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: "#aaa"
    }
  }, "receipt: ", $(e.net)), qd.qty && qd.unit && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: "#4a7a9b"
    }
  }, $p(e.unitPrice / qd.qty), "/", qd.unit))))));
}

// ─── Items Tab ────────────────────────────────────
function ItemsTab({
  catalog,
  state,
  dispatch
}) {
  const {
    names,
    cats,
    quantities,
    meta,
    purchaseQty
  } = state;
  const [search, setSearch] = React.useState("");
  const [selected, setSelected] = React.useState(null);
  const [sortBy, setSortBy] = React.useState("freq");
  const itemList = React.useMemo(() => Object.entries(catalog).map(([num, data]) => {
    const ups = data.appearances.map(a => {
      const pq = purchaseQty[pqKey(num, a.date)] || 1;
      return a.net / pq;
    });
    const avg = ups.reduce((a, b) => a + b, 0) / ups.length;
    const qd = quantities[num];
    const md = meta[num] || {};
    return {
      num,
      name: names[num] || data.desc,
      cat: cats[num] || "Other",
      count: data.appearances.length,
      avg,
      med: median(ups),
      hasQty: !!qd?.qty,
      ppu: qd?.qty ? avg / qd.qty : null,
      unit: qd?.unit,
      organic: md.organic,
      brand: md.brand || "",
      lastDate: data.appearances[data.appearances.length - 1]?.date || ""
    };
  }), [catalog, names, cats, quantities, meta, purchaseQty]);
  const filtered = React.useMemo(() => {
    let list = itemList;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(i => i.name.toLowerCase().includes(q) || i.num.includes(q) || i.cat.toLowerCase().includes(q) || i.brand.toLowerCase().includes(q));
    }
    if (sortBy === "freq") list.sort((a, b) => b.count - a.count);else if (sortBy === "price") list.sort((a, b) => b.avg - a.avg);else if (sortBy === "name") list.sort((a, b) => a.name.localeCompare(b.name));else if (sortBy === "recent") list.sort((a, b) => b.lastDate.localeCompare(a.lastDate));
    return list;
  }, [itemList, search, sortBy]);
  if (selected) return /*#__PURE__*/React.createElement(ItemDetail, {
    itemNum: selected,
    catalog: catalog,
    state: state,
    dispatch: dispatch,
    onBack: () => setSelected(null)
  });
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("input", {
    value: search,
    onChange: e => setSearch(e.target.value),
    placeholder: "Search items, categories, brands...",
    style: {
      width: "100%",
      padding: "10px 14px",
      borderRadius: 10,
      border: "1px solid #e2e0dc",
      fontSize: 14,
      marginBottom: 10,
      boxSizing: "border-box",
      background: "#fff"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      marginBottom: 12,
      flexWrap: "wrap"
    }
  }, [["freq", "Most bought"], ["recent", "Recent"], ["price", "Highest price"], ["name", "A-Z"]].map(([k, l]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    onClick: () => setSortBy(k),
    style: {
      padding: "5px 12px",
      borderRadius: 99,
      border: "1px solid " + (sortBy === k ? "#4a7a9b" : "#e2e0dc"),
      background: sortBy === k ? "#4a7a9b" : "#fff",
      color: sortBy === k ? "#fff" : "#888",
      fontSize: 12,
      cursor: "pointer",
      fontWeight: 500
    }
  }, l))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "#aaa",
      marginBottom: 8
    }
  }, filtered.length, " items"), filtered.slice(0, 60).map(item => /*#__PURE__*/React.createElement("div", {
    key: item.num,
    onClick: () => setSelected(item.num),
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "10px 14px",
      background: "#fff",
      borderRadius: 10,
      border: "1px solid #e2e0dc",
      marginBottom: 6,
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 500,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    }
  }, item.name, item.organic && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 9,
      color: "#2d7a3a",
      marginLeft: 4
    }
  }, "\u25CF")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "#aaa"
    }
  }, item.cat, " \xB7 ", item.count, "x", item.brand ? ` · ${item.brand}` : "", item.hasQty ? " · ✓" : "")), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "right",
      marginLeft: 12,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'DM Mono',monospace",
      fontWeight: 600,
      fontSize: 14
    }
  }, $(item.avg)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: "#aaa"
    }
  }, "avg \xB7 med ", $(item.med)), item.ppu && item.unit && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: "#4a7a9b"
    }
  }, $p(item.ppu), "/", item.unit)))), filtered.length > 60 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: "#aaa",
      fontSize: 12,
      padding: 12
    }
  }, "Showing 60 of ", filtered.length));
}

// ─── Trends Tab ──────────────────────────────────
function TrendsTab({
  receipts,
  cats
}) {
  const [period, setPeriod] = React.useState("monthly");
  const monthly = React.useMemo(() => {
    const m = {};
    receipts.forEach(r => {
      const k = r.date.slice(0, 7);
      if (!m[k]) m[k] = {
        spent: 0,
        trips: 0
      };
      m[k].spent += r.total;
      m[k].trips++;
    });
    return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => ({
      month: fmtShort(k + "-01"),
      spent: Math.round(v.spent * 100) / 100
    }));
  }, [receipts]);
  const quarterly = React.useMemo(() => {
    const q = {};
    receipts.forEach(r => {
      const d = new Date(r.date + "T00:00:00");
      const qtr = `${d.getFullYear()} Q${Math.floor(d.getMonth() / 3) + 1}`;
      if (!q[qtr]) q[qtr] = {
        spent: 0
      };
      q[qtr].spent += r.total;
    });
    return Object.entries(q).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => ({
      quarter: k,
      spent: Math.round(v.spent * 100) / 100
    }));
  }, [receipts]);
  const catData = React.useMemo(() => {
    const c = {};
    receipts.forEach(r => r.items.forEach(i => {
      const cat = cats[i.itemNum] || "Other";
      c[cat] = (c[cat] || 0) + (i.price - i.discount);
    }));
    return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([name, value], i) => ({
      name,
      value: Math.round(value * 100) / 100,
      color: COLORS[i % COLORS.length]
    }));
  }, [receipts, cats]);
  const totalSpent = receipts.reduce((s, r) => s + r.total, 0);
  const totalSaved = receipts.reduce((s, r) => s + r.instantSavings + r.items.reduce((a, i) => a + i.discount, 0), 0);
  const chartData = period === "monthly" ? monthly : quarterly;
  const xKey = period === "monthly" ? "month" : "quarter";
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 8,
      marginBottom: 20
    }
  }, [{
    l: "Total Spent",
    v: $(totalSpent)
  }, {
    l: "Total Saved",
    v: $(totalSaved),
    c: "#16a34a"
  }, {
    l: "Avg per Trip",
    v: $(totalSpent / receipts.length)
  }, {
    l: "Trips",
    v: receipts.length
  }].map(c => /*#__PURE__*/React.createElement("div", {
    key: c.l,
    style: {
      background: "#fff",
      border: "1px solid #e2e0dc",
      borderRadius: 10,
      padding: "12px 14px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "#999"
    }
  }, c.l), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 19,
      fontWeight: 700,
      color: c.c || "#1a1a1a",
      fontFamily: "'DM Mono',monospace"
    }
  }, c.v)))), /*#__PURE__*/React.createElement(Card, {
    style: {
      padding: "14px 8px 8px 0"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      paddingLeft: 14,
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      fontWeight: 600
    }
  }, "Spending"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 4
    }
  }, [["monthly", "Monthly"], ["quarterly", "Quarterly"]].map(([k, l]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    onClick: () => setPeriod(k),
    style: {
      padding: "3px 10px",
      borderRadius: 99,
      border: "1px solid " + (period === k ? "#4a7a9b" : "#ddd"),
      background: period === k ? "#4a7a9b" : "#fff",
      color: period === k ? "#fff" : "#999",
      fontSize: 11,
      cursor: "pointer"
    }
  }, l)))), /*#__PURE__*/React.createElement(ResponsiveContainer, {
    width: "100%",
    height: 200
  }, /*#__PURE__*/React.createElement(BarChart, {
    data: chartData
  }, /*#__PURE__*/React.createElement(CartesianGrid, {
    strokeDasharray: "3 3",
    stroke: "#f0eeea"
  }), /*#__PURE__*/React.createElement(XAxis, {
    dataKey: xKey,
    tick: {
      fontSize: 9
    },
    angle: -30,
    textAnchor: "end",
    height: 40
  }), /*#__PURE__*/React.createElement(YAxis, {
    tick: {
      fontSize: 10
    },
    tickFormatter: v => "$" + v,
    width: 45
  }), /*#__PURE__*/React.createElement(Tooltip, {
    formatter: v => $(v)
  }), /*#__PURE__*/React.createElement(Bar, {
    dataKey: "spent",
    fill: "#4a7a9b",
    radius: [4, 4, 0, 0]
  })))), /*#__PURE__*/React.createElement(Card, {
    style: {
      padding: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 600,
      marginBottom: 12
    }
  }, "By Category"), catData.map(({
    name,
    value,
    color
  }) => /*#__PURE__*/React.createElement("div", {
    key: name,
    style: {
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      fontSize: 12,
      marginBottom: 2
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 8,
      height: 8,
      borderRadius: 2,
      background: color,
      display: "inline-block"
    }
  }), name), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "'DM Mono',monospace",
      fontWeight: 500
    }
  }, $(value))), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 6,
      background: "#f0eeea",
      borderRadius: 3,
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: "100%",
      width: `${value / catData[0].value * 100}%`,
      background: color,
      borderRadius: 3
    }
  }))))));
}

// ─── Receipts Tab ─────────────────────────────────
function ReceiptsTab({
  receipts,
  state,
  dispatch
}) {
  const {
    names,
    cats,
    quantities
  } = state;
  const [expanded, setExpanded] = React.useState(null);
  return /*#__PURE__*/React.createElement("div", null, [...receipts].sort((a, b) => b.date.localeCompare(a.date)).map(r => /*#__PURE__*/React.createElement(Card, {
    key: r.id,
    style: {
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: () => setExpanded(expanded === r.id ? null : r.id),
    style: {
      padding: "12px 14px",
      cursor: "pointer",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 600,
      fontSize: 14,
      fontFamily: "'Source Serif 4',Georgia,serif"
    }
  }, fmt(r.date)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "#999"
    }
  }, r.items.length, " items", r.instantSavings > 0 ? ` · saved ${$(r.instantSavings)}` : "")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      fontSize: 17,
      fontFamily: "'DM Mono',monospace"
    }
  }, $(r.total))), expanded === r.id && /*#__PURE__*/React.createElement("div", {
    style: {
      borderTop: "1px solid #f0eeea"
    }
  }, r.items.map((item, idx) => {
    const net = item.price - item.discount;
    const name = names[item.itemNum] || item.desc;
    const cat = cats[item.itemNum] || "Other";
    const qd = quantities[item.itemNum];
    return /*#__PURE__*/React.createElement("div", {
      key: idx,
      style: {
        padding: "8px 14px",
        borderTop: idx > 0 ? "1px solid #f8f7f4" : "none",
        display: "flex",
        justifyContent: "space-between",
        gap: 8
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 13
      }
    }, /*#__PURE__*/React.createElement(EditField, {
      value: name,
      onSave: v => dispatch("name", item.itemNum, v)
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: "#ccc"
      }
    }, "#", item.itemNum, " \xB7 ", cat)), /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "right",
        flexShrink: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: "'DM Mono',monospace",
        fontWeight: 600,
        fontSize: 13
      }
    }, $(net)), item.discount > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: "#16a34a"
      }
    }, "-", $(item.discount))));
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "8px 14px",
      background: "#faf8f5",
      display: "flex",
      justifyContent: "space-between",
      fontSize: 12,
      color: "#888",
      borderTop: "1px solid #f0eeea"
    }
  }, /*#__PURE__*/React.createElement("span", null, "Tax: ", $(r.tax)), /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 600,
      color: "#1a1a1a"
    }
  }, "Total: ", $(r.total)))))));
}

// ─── Compare Tab ──────────────────────────────────
function CompareTab({
  catalog,
  state,
  dispatch
}) {
  const {
    names,
    quantities,
    meta,
    groups,
    purchaseQty
  } = state;
  const [selected, setSelected] = React.useState(null);
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [convertUnit, setConvertUnit] = React.useState({});
  const groupList = Object.entries(groups).filter(([, g]) => g.items.length > 0).sort((a, b) => a[1].name.localeCompare(b[1].name));
  if (selected) {
    const group = groups[selected];
    if (!group) {
      setSelected(null);
      return null;
    }
    const members = group.items.map(num => {
      const data = catalog[num];
      if (!data) return null;
      const ups = data.appearances.map(a => {
        const pq = purchaseQty[pqKey(num, a.date)] || 1;
        return a.net / pq;
      });
      const avg = ups.reduce((a, b) => a + b, 0) / ups.length;
      const qd = quantities[num] || {};
      const md = meta[num] || {};
      return {
        num,
        name: names[num] || data.desc,
        count: data.appearances.length,
        avg,
        qty: qd.qty,
        unit: qd.unit,
        organic: md.organic,
        brand: md.brand,
        notes: md.notes
      };
    }).filter(Boolean);
    const unitsInGroup = members.filter(m => m.unit).map(m => m.unit);
    const commonGroup = unitsInGroup.length > 0 ? getUnitGroup(unitsInGroup[0]) : null;
    const activeConvert = convertUnit[selected] || (commonGroup ? commonGroup.units[0] : null);
    const withNorm = members.map(m => {
      if (!m.qty || !m.unit || !activeConvert) return {
        ...m,
        normPpu: null
      };
      return {
        ...m,
        normPpu: m.avg / convert(m.qty, m.unit, activeConvert)
      };
    });
    const bestValue = withNorm.filter(m => m.normPpu).sort((a, b) => a.normPpu - b.normPpu)[0];
    return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("button", {
      onClick: () => setSelected(null),
      style: {
        background: "none",
        border: "none",
        color: "#4a7a9b",
        fontSize: 14,
        cursor: "pointer",
        padding: "0 0 12px",
        fontWeight: 500
      }
    }, "\u2190 Back"), /*#__PURE__*/React.createElement(Card, null, /*#__PURE__*/React.createElement("div", {
      style: {
        padding: 16
      }
    }, /*#__PURE__*/React.createElement("h2", {
      style: {
        margin: "0 0 4px",
        fontSize: 20,
        fontFamily: "'Source Serif 4',Georgia,serif"
      }
    }, group.name), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: "#aaa"
      }
    }, members.length, " items"))), commonGroup && /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 4,
        marginBottom: 12,
        flexWrap: "wrap",
        alignItems: "center"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        color: "#aaa"
      }
    }, "Compare per:"), commonGroup.units.map(u => /*#__PURE__*/React.createElement("button", {
      key: u,
      onClick: () => setConvertUnit({
        ...convertUnit,
        [selected]: u
      }),
      style: {
        padding: "3px 10px",
        borderRadius: 99,
        fontSize: 11,
        cursor: "pointer",
        border: "1px solid " + (activeConvert === u ? "#4a7a9b" : "#ddd"),
        background: activeConvert === u ? "#4a7a9b" : "#fff",
        color: activeConvert === u ? "#fff" : "#888"
      }
    }, u))), withNorm.map(m => {
      const isBest = bestValue && m.num === bestValue.num;
      return /*#__PURE__*/React.createElement(Card, {
        key: m.num
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          padding: "12px 14px"
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          justifyContent: "space-between"
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          flex: 1
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 14,
          fontWeight: 600
        }
      }, m.name, isBest && /*#__PURE__*/React.createElement(Badge, {
        text: " Best Value",
        color: "#2d7a3a",
        bg: "#e6f4e8"
      }), m.organic && /*#__PURE__*/React.createElement(Badge, {
        text: " Organic",
        color: "#2d7a3a",
        bg: "#e6f4e8"
      })), /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 11,
          color: "#aaa",
          marginTop: 2
        }
      }, m.brand ? m.brand + " · " : "", m.count, "x", m.qty ? ` · ${m.qty} ${m.unit}` : "")), /*#__PURE__*/React.createElement("div", {
        style: {
          textAlign: "right"
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontFamily: "'DM Mono',monospace",
          fontWeight: 700,
          fontSize: 16
        }
      }, $(m.avg)))), m.normPpu && activeConvert && /*#__PURE__*/React.createElement("div", {
        style: {
          marginTop: 8,
          background: isBest ? "#e6f4e8" : "#faf8f5",
          borderRadius: 6,
          padding: "6px 10px",
          display: "flex",
          justifyContent: "space-between"
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 12,
          color: "#666"
        }
      }, "Per ", activeConvert), /*#__PURE__*/React.createElement("span", {
        style: {
          fontFamily: "'DM Mono',monospace",
          fontWeight: 600,
          fontSize: 13,
          color: isBest ? "#2d7a3a" : "#1a1a1a"
        }
      }, $p(m.normPpu))), m.notes && /*#__PURE__*/React.createElement("div", {
        style: {
          marginTop: 6,
          fontSize: 12,
          color: "#888",
          fontStyle: "italic"
        }
      }, "\"", m.notes, "\"")));
    }), members.length === 0 && /*#__PURE__*/React.createElement(Card, {
      style: {
        padding: 20,
        textAlign: "center"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        color: "#aaa",
        fontSize: 13
      }
    }, "No items yet. Assign items from their detail pages.")));
  }
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 16,
      fontWeight: 600
    }
  }, "Compare Groups"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "#aaa"
    }
  }, "Compare similar items by unit price")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setCreating(true),
    style: {
      padding: "6px 14px",
      borderRadius: 8,
      background: "#4a7a9b",
      color: "#fff",
      border: "none",
      fontSize: 12,
      cursor: "pointer",
      fontWeight: 500
    }
  }, "+ New")), creating && /*#__PURE__*/React.createElement(Card, {
    style: {
      padding: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: newName,
    onChange: e => setNewName(e.target.value),
    placeholder: "e.g. Eggs, Toilet Paper",
    onKeyDown: e => {
      if (e.key === "Enter" && newName.trim()) {
        dispatch("groups", null, {
          ...groups,
          ["g_" + Date.now()]: {
            name: newName.trim(),
            items: [],
            notes: ""
          }
        });
        setNewName("");
        setCreating(false);
      }
    },
    style: {
      flex: 1,
      padding: "8px 10px",
      borderRadius: 6,
      border: "1px solid #ccc",
      fontSize: 13
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      if (!newName.trim()) return;
      dispatch("groups", null, {
        ...groups,
        ["g_" + Date.now()]: {
          name: newName.trim(),
          items: [],
          notes: ""
        }
      });
      setNewName("");
      setCreating(false);
    },
    style: {
      padding: "8px 14px",
      borderRadius: 6,
      background: "#4a7a9b",
      color: "#fff",
      border: "none",
      fontSize: 12,
      cursor: "pointer"
    }
  }, "Create"))), groupList.length === 0 && !creating && /*#__PURE__*/React.createElement(Card, {
    style: {
      padding: 20,
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 28,
      marginBottom: 8
    }
  }, "\u2696\uFE0F"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 500
    }
  }, "No compare groups yet")), groupList.map(([gid, g]) => /*#__PURE__*/React.createElement("div", {
    key: gid,
    onClick: () => setSelected(gid),
    style: {
      padding: "12px 14px",
      background: "#fff",
      borderRadius: 10,
      border: "1px solid #e2e0dc",
      marginBottom: 6,
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 15,
      fontWeight: 600
    }
  }, g.name), /*#__PURE__*/React.createElement(Badge, {
    text: g.items.length + " items"
  })))));
}

// ─── Main App ─────────────────────────────────────
function GroceryTracker() {
  const [state, setState] = React.useState({
    names: {},
    cats: {},
    quantities: {},
    meta: {},
    groups: {},
    purchaseQty: {}
  });
  const [tab, setTab] = React.useState("items");
  const [loaded, setLoaded] = React.useState(false);
  const [status, setStatus] = React.useState("");
  const [signedIn, setSignedIn] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const catalog = React.useMemo(() => buildCatalog(RECEIPTS_DATA), []);
  const saveTimer = React.useRef(null);

  // Load from localStorage on mount
  React.useEffect(() => {
    const s = localLoad();
    if (s) {
      setState(s);
      stateRef.current = s;
    }
    setLoaded(true);
  }, []);

  // Google sign-in
  const handleSignIn = React.useCallback(() => {
    if (!window.google?.accounts?.oauth2) {
      setStatus("Google API not loaded");
      return;
    }
    const client = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.CLIENT_ID,
      scope: CONFIG.SCOPES,
      callback: async response => {
        if (response.access_token) {
          SheetsAPI.token = response.access_token;
          setSignedIn(true);
          setSyncing(true);
          setStatus("syncing...");
          try {
            await SheetsAPI.ensureTabs();
            const cloudEdits = await SheetsAPI.readEdits();
            // Merge: cloud wins for non-empty values
            const merged = {
              ...stateRef.current
            };
            Object.keys(cloudEdits).forEach(k => {
              if (typeof cloudEdits[k] === "object" && Object.keys(cloudEdits[k]).length > 0) {
                merged[k] = {
                  ...merged[k],
                  ...cloudEdits[k]
                };
              }
            });
            setState(merged);
            stateRef.current = merged;
            localSave(merged);
            setStatus("synced ✓");
          } catch (e) {
            setStatus("sync failed: " + e.message);
          }
          setSyncing(false);
          setTimeout(() => setStatus(""), 3000);
        }
      }
    });
    client.requestAccessToken();
  }, []);

  // Dispatch edits
  const dispatch = React.useCallback((type, key, value) => {
    setState(prev => {
      let next;
      if (type === "name") next = {
        ...prev,
        names: {
          ...prev.names,
          [key]: value
        }
      };else if (type === "cat") next = {
        ...prev,
        cats: {
          ...prev.cats,
          [key]: value
        }
      };else if (type === "qty") next = {
        ...prev,
        quantities: {
          ...prev.quantities,
          [key]: value
        }
      };else if (type === "meta") next = {
        ...prev,
        meta: {
          ...prev.meta,
          [key]: value
        }
      };else if (type === "groups") next = {
        ...prev,
        groups: value
      };else if (type === "purchaseQty") next = {
        ...prev,
        purchaseQty: {
          ...prev.purchaseQty,
          [key]: value
        }
      };else return prev;
      stateRef.current = next;
      localSave(next);
      // Debounced cloud save
      if (SheetsAPI.token) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          setStatus("saving to cloud...");
          SheetsAPI.writeAllEdits(next).then(() => {
            setStatus("cloud saved ✓");
            setTimeout(() => setStatus(""), 2000);
          }).catch((err) => {
            setStatus("cloud save failed");
            setTimeout(() => setStatus(""), 3000);
          });
        }, 2000);
      }
      return next;
    });
  }, []);
  const {
    names,
    cats,
    quantities,
    meta,
    groups,
    purchaseQty
  } = state;
  const totalEdits = Object.values(state).reduce((a, v) => a + Object.keys(v).length, 0);
  if (!loaded) return /*#__PURE__*/React.createElement("div", {
    className: "loading"
  }, "Loading...");
  const tabs = [{
    id: "items",
    label: "Items",
    icon: "🔍"
  }, {
    id: "compare",
    label: "Compare",
    icon: "⚖️"
  }, {
    id: "trends",
    label: "Trends",
    icon: "📊"
  }, {
    id: "receipts",
    label: "Receipts",
    icon: "🧾"
  }];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      minHeight: "100vh",
      background: "#f5f3ef",
      paddingBottom: 72
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#fff",
      borderBottom: "1px solid #e2e0dc",
      padding: "12px 16px",
      position: "sticky",
      top: 0,
      zIndex: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", {
    style: {
      fontFamily: "'Source Serif 4',Georgia,serif",
      fontSize: 20,
      fontWeight: 700,
      margin: 0
    }
  }, "Grocery Tracker"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "#aaa"
    }
  }, RECEIPTS_DATA.length, " trips \xB7 ", Object.keys(catalog).length, " products", totalEdits > 0 ? ` · ${totalEdits} edits` : "")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      color: "#bbb"
    }
  }, status), /*#__PURE__*/React.createElement("button", {
    onClick: handleSignIn,
    style: {
      padding: "6px 12px",
      borderRadius: 8,
      background: signedIn ? "#e6f4e8" : "#4a7a9b",
      color: signedIn ? "#2d7a3a" : "#fff",
      border: signedIn ? "1px solid #2d7a3a" : "none",
      fontSize: 11,
      cursor: "pointer",
      fontWeight: 500,
      whiteSpace: "nowrap"
    }
  }, signedIn ? "\u2601\uFE0F Synced" : "Sync \u2601\uFE0F")))), /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 600,
      margin: "0 auto",
      padding: "12px 12px 0"
    }
  }, tab === "items" && /*#__PURE__*/React.createElement(ItemsTab, {
    catalog: catalog,
    state: state,
    dispatch: dispatch
  }), tab === "compare" && /*#__PURE__*/React.createElement(CompareTab, {
    catalog: catalog,
    state: state,
    dispatch: dispatch
  }), tab === "trends" && /*#__PURE__*/React.createElement(TrendsTab, {
    receipts: RECEIPTS_DATA,
    cats: cats
  }), tab === "receipts" && /*#__PURE__*/React.createElement(ReceiptsTab, {
    receipts: RECEIPTS_DATA,
    state: state,
    dispatch: dispatch
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "fixed",
      bottom: 0,
      left: 0,
      right: 0,
      background: "#fff",
      borderTop: "1px solid #e2e0dc",
      display: "flex",
      justifyContent: "space-around",
      padding: "5px 0 env(safe-area-inset-bottom, 6px)",
      zIndex: 10
    }
  }, tabs.map(t => /*#__PURE__*/React.createElement("button", {
    key: t.id,
    onClick: () => setTab(t.id),
    style: {
      background: "none",
      border: "none",
      cursor: "pointer",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 1,
      padding: "3px 12px",
      color: tab === t.id ? "#4a7a9b" : "#aaa",
      fontWeight: tab === t.id ? 600 : 400,
      fontSize: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 17
    }
  }, t.icon), t.label))));
}

// ─── Render ──────────────────────────────────────
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(GroceryTracker, null));
