/**
 * 数据库操作层 - 支持 localStorage / HTTP API / 云端三种模式
 * localStorage: file:// 打开时自动使用
 * HTTP API: 通过 http:// 访问本地服务器时使用
 * 云端: 配置 js/cloud.js 后自动启用
 */

// 检测运行环境
const IS_SERVER = window.location.protocol === "http:" || window.location.protocol === "https:";
const API_BASE = IS_SERVER ? "/api" : "";

// 检测是否配置了云端
const CLOUD_ENABLED = typeof CLOUD_CONFIG !== "undefined" && CLOUD_CONFIG.provider && CLOUD_CONFIG.provider.length > 0;

// ===== localStorage 实现 =====
const STORE_KEYS = ["stores","products","shipments","boxes","box_labels","box_products","daily_sales"];

function lsGetAll(table) {
  try {
    const data = localStorage.getItem("db_" + table);
    return data ? JSON.parse(data) : [];
  } catch (e) { return []; }
}

function lsSave(table, data) {
  localStorage.setItem("db_" + table, JSON.stringify(data));
}

function lsGetNextId(table) {
  const data = lsGetAll(table);
  const maxId = data.reduce(function(max, r) { return Math.max(max, r.id || 0); }, 0);
  return maxId + 1;
}

// ===== HTTP API 实现 =====
async function httpGet(url) {
  const res = await fetch(API_BASE + url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}
async function httpPost(url, data) {
  const res = await fetch(API_BASE + url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}
async function httpPut(url, data) {
  const res = await fetch(API_BASE + url, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}
async function httpDelete(url) {
  const res = await fetch(API_BASE + url, { method: "DELETE" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

// ===== 云端存储辅助 =====
let _cloudCache = null;
async function cloudLoad() {
  if (_cloudCache) return _cloudCache;
  _cloudCache = await CloudStorage.read();
  return _cloudCache;
}
async function cloudSave() {
  if (_cloudCache) await CloudStorage.write(_cloudCache);
}
function cloudGetTable(table) {
  if (!_cloudCache) return [];
  if (!_cloudCache[table]) _cloudCache[table] = [];
  return _cloudCache[table];
}

// ===== 统一 CRUD API =====

async function dbGetAll(storeName) {
  if (CLOUD_ENABLED) {
    await cloudLoad();
    return cloudGetTable(storeName).slice();
  }
  if (IS_SERVER) return httpGet("/" + storeName);
  return lsGetAll(storeName);
}

async function dbGet(storeName, id) {
  if (CLOUD_ENABLED) {
    await cloudLoad();
    return cloudGetTable(storeName).find(function(r) { return r.id === id; }) || null;
  }
  if (IS_SERVER) return httpGet("/" + storeName + "/" + id);
  const data = lsGetAll(storeName);
  return data.find(function(r) { return r.id === id; }) || null;
}

async function dbAdd(storeName, data) {
  if (CLOUD_ENABLED) {
    await cloudLoad();
    const list = cloudGetTable(storeName);
    const maxId = list.reduce(function(max, r) { return Math.max(max, r.id || 0); }, 0);
    data.id = maxId + 1;
    list.push(data);
    await cloudSave();
    return data.id;
  }
  if (IS_SERVER) return httpPost("/" + storeName, data);
  const list = lsGetAll(storeName);
  data.id = lsGetNextId(storeName);
  list.push(data);
  lsSave(storeName, list);
  return data.id;
}

async function dbPut(storeName, data) {
  if (CLOUD_ENABLED) {
    await cloudLoad();
    const list = cloudGetTable(storeName);
    const idx = list.findIndex(function(r) { return r.id === data.id; });
    if (idx === -1) throw new Error("记录不存在");
    list[idx] = data;
    await cloudSave();
    return data;
  }
  if (IS_SERVER) return httpPut("/" + storeName + "/" + data.id, data);
  const list = lsGetAll(storeName);
  const idx = list.findIndex(function(r) { return r.id === data.id; });
  if (idx === -1) throw new Error("记录不存在");
  list[idx] = data;
  lsSave(storeName, list);
  return data;
}

async function dbDelete(storeName, id) {
  if (CLOUD_ENABLED) {
    await cloudLoad();
    const list = cloudGetTable(storeName);
    const idx = list.findIndex(function(r) { return r.id === id; });
    if (idx === -1) throw new Error("记录不存在");
    list.splice(idx, 1);
    await cloudSave();
    return;
  }
  if (IS_SERVER) return httpDelete("/" + storeName + "/" + id);
  const list = lsGetAll(storeName);
  const idx = list.findIndex(function(r) { return r.id === id; });
  if (idx === -1) throw new Error("记录不存在");
  list.splice(idx, 1);
  lsSave(storeName, list);
}

async function dbGetByIndex(storeName, indexName, value) {
  if (CLOUD_ENABLED) {
    await cloudLoad();
    return cloudGetTable(storeName).filter(function(r) { return r[indexName] === value; });
  }
  if (IS_SERVER) return httpGet("/" + storeName + "/index/" + indexName + "/" + encodeURIComponent(value));
  const data = lsGetAll(storeName);
  return data.filter(function(r) { return r[indexName] === value; });
}

async function dbGetByCompoundIndex(storeName, indexName, values) {
  if (CLOUD_ENABLED) {
    await cloudLoad();
    return cloudGetTable(storeName).filter(function(r) {
      const idx = r[indexName];
      return idx && idx.length === values.length && idx.every(function(v, i) { return String(v) === String(values[i]); });
    });
  }
  if (IS_SERVER) return httpGet("/" + storeName + "/composite/" + indexName + "/" + values.map(encodeURIComponent).join(","));
  const data = lsGetAll(storeName);
  return data.filter(function(r) {
    const idx = r[indexName];
    return idx && idx.length === values.length && idx.every(function(v, i) { return String(v) === String(values[i]); });
  });
}

async function dbGetByRange(storeName, indexName, lower, upper) {
  if (CLOUD_ENABLED) {
    await cloudLoad();
    return cloudGetTable(storeName).filter(function(r) {
      const val = r[indexName];
      return val && val >= lower && val <= upper;
    });
  }
  if (IS_SERVER) return httpGet("/" + storeName + "/range/" + indexName + "/" + encodeURIComponent(lower) + "/" + encodeURIComponent(upper));
  const data = lsGetAll(storeName);
  return data.filter(function(r) {
    const val = r[indexName];
    return val && val >= lower && val <= upper;
  });
}

// ===== 业务函数（保持不变）=====

async function getStoreProducts(storeId) {
  return dbGetByIndex("products", "storeId", storeId);
}

async function findProduct(productId) {
  const results = await dbGetByIndex("products", "productId", productId);
  return results[0] || null;
}

async function findProductBySku(sku) {
  const results = await dbGetByIndex("products", "sku", sku);
  return results[0] || null;
}

async function findProductByName(name) {
  const all = await dbGetAll("products");
  return all.find(function(p) { return p.name === name; }) || null;
}

async function autoFillProduct(term) {
  const all = await dbGetAll("products");
  return all.find(function(p) { return p.productId === term || p.sku === term || p.name === term; }) || null;
}

async function getShipmentBoxes(shipmentId) {
  return dbGetByIndex("boxes", "shipmentId", shipmentId);
}

async function getBoxProducts(boxId) {
  return dbGetByIndex("box_products", "boxId", boxId);
}

async function getProductBoxes(productId) {
  return dbGetByIndex("box_products", "productId", productId);
}

async function getProductStock(productId) {
  const boxProducts = await dbGetByIndex("box_products", "productId", productId);
  let total = 0;
  for (const bp of boxProducts) {
    const box = await dbGet("boxes", bp.boxId);
    if (box && box.status !== "full") {
      total += (box.boxCount || 1) * (box.packingCount || 1);
    }
  }
  return total;
}

async function getProductTotalStock(productId) {
  const products = await dbGetByIndex("products", "productId", productId);
  let total = 0;
  for (const p of products) {
    total += await getProductStock(p.id);
  }
  return total;
}

async function getProductTotalCost(productId) {
  const products = await dbGetByIndex("products", "productId", productId);
  let totalCost = 0;
  for (const p of products) {
    if (p.cost) {
      const stock = await getProductStock(p.id);
      totalCost += (p.cost + (p.headCost || 0)) * stock;
    }
  }
  return totalCost;
}

async function getRecentSales(productId, days) {
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - days + 1);
  const startStr = formatDate(start);
  const endStr = formatDate(today);
  const allSales = await dbGetByIndex("daily_sales", "productId", productId);
  return allSales.filter(function(s) { return s.date >= startStr && s.date <= endStr; });
}

async function getMonthlySales(productId) {
  return getRecentSales(productId, 30);
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function todayStr() {
  return formatDate(new Date());
}

async function saveBoxLabel(boxId, label) {
  const record = { boxId: boxId, label: label, timestamp: new Date().toISOString() };
  return dbAdd("box_labels", record);
}

async function getBoxLabelHistory(boxId) {
  return dbGetByIndex("box_labels", "boxId", boxId);
}

async function transferProduct(boxId, fromStoreId, toStoreId, productId, newProductId, newSku, newName) {
  const box = await dbGet("boxes", boxId);
  if (!box) throw new Error("箱子不存在");
  const products = await dbGetByIndex("box_products", "boxId", boxId);
  const sourceProduct = await dbGet("products", productId);
  const newProduct = {
    storeId: toStoreId, productId: newProductId, sku: newSku, name: newName,
    cost: sourceProduct.cost || 0, headCost: sourceProduct.headCost || 0,
    appointmentType: sourceProduct.appointmentType || "", appointmentDate: sourceProduct.appointmentDate || ""
  };
  const newProductId2 = await dbAdd("products", newProduct);
  const shipment = {
    storeId: toStoreId, date: todayStr(),
    totalCbm: box.cbmPerBox * box.boxCount || 0, totalWeight: box.weight * box.boxCount || 0,
    notes: "从店铺#" + fromStoreId + " 调拨", isTransfer: true
  };
  const shipmentId = await dbAdd("shipments", shipment);
  const newBox = {
    shipmentId: shipmentId, boxNumber: box.boxNumber, boxCount: box.boxCount, packingCount: box.packingCount,
    spec: box.spec, weight: box.weight, cbmPerBox: box.cbmPerBox, status: "arrived",
    logisticsCompany: box.logisticsCompany, transferFromStoreId: fromStoreId
  };
  const newBoxId = await dbAdd("boxes", newBox);
  const labels = await getBoxLabelHistory(boxId);
  for (const l of labels) { await saveBoxLabel(newBoxId, l.label); }
  for (const bp of products) {
    await dbAdd("box_products", { boxId: newBoxId, productId: newProductId2, quantity: bp.quantity });
  }
  box.status = "full";
  box.transferToStoreId = toStoreId;
  await dbPut("boxes", box);
  return { newProductId: newProductId2, newBoxId: newBoxId, shipmentId: shipmentId };
}
