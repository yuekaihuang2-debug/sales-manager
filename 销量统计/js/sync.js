/**
 * 数据同步模块 — 导出/导入 IndexedDB 全部数据
 * 用于多电脑数据同步
 */

// 需要导出的表（按依赖顺序排列，父表在前）
const SYNC_STORES = ["stores", "products", "shipments", "boxes", "box_labels", "box_products", "daily_sales"];

// 导出全部数据为 JSON 对象
async function exportAllData() {
  const data = {};
  for (const name of SYNC_STORES) {
    data[name] = await dbGetAll(name);
  }
  return data;
}

// 导出并下载为 JSON 文件
async function downloadDataBackup() {
  const data = await exportAllData();
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const now = new Date();
  const dateStr = now.getFullYear() + "-" + String(now.getMonth()+1).padStart(2,"0") + "-" + String(now.getDate()).padStart(2,"0");
  a.download = "销量统计_备份_" + dateStr + ".json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return data;
}

// 从 JSON 文件导入数据（替换全部）
async function importDataFromFile(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  // 校验格式
  for (const name of SYNC_STORES) {
    if (!Array.isArray(data[name])) {
      throw new Error("文件格式错误：缺少表 " + name);
    }
  }
  // 清除旧数据后导入
  await clearAllData();
  for (const name of SYNC_STORES) {
    for (const record of data[name]) {
      await dbAdd(name, record);
    }
  }
  return Object.fromEntries(SYNC_STORES.map(n => [n, data[n].length]));
}

// 清除所有数据（反向顺序避免外键冲突）
async function clearAllData() {
  const reversed = [...SYNC_STORES].reverse();
  for (const name of reversed) {
    const all = await dbGetAll(name);
    for (const record of all) {
      await dbDelete(name, record.id);
    }
  }
}

// 获取各表记录数
async function getDataStats() {
  const stats = {};
  for (const name of SYNC_STORES) {
    const all = await dbGetAll(name);
    stats[name] = all.length;
  }
  return stats;
}