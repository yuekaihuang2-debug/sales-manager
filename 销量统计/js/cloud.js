/**
 * 云端存储适配器 - Upstash Redis
 */
const CLOUD_CONFIG = {
  provider: "upstash",
  upstashUrl: "https://apparent-zebra-88186.upstash.io",
  upstashToken: "gQAAAAAAAVh6AAIgcDI5ODFmZWQyMDM2MDE0ODIxOWJlOTBkNWVjZjRjNDljMA",
};

const CLOUD_KEY = "sales_manager_data";

const CloudStorage = {
  async read() {
    const cfg = CLOUD_CONFIG;
    const res = await fetch(cfg.upstashUrl + "/get/" + CLOUD_KEY, {
      headers: { Authorization: "Bearer " + cfg.upstashToken },
    });
    if (!res.ok) throw new Error("云端读取失败 HTTP " + res.status);
    const json = await res.json();
    return json.result ? JSON.parse(json.result) : {};
  },

  async write(data) {
    const cfg = CLOUD_CONFIG;
    const res = await fetch(cfg.upstashUrl + "/set/" + CLOUD_KEY, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + cfg.upstashToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(JSON.stringify(data)),
    });
    if (!res.ok) throw new Error("云端写入失败 HTTP " + res.status);
  },
};
