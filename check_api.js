const fs = require("fs");
const path = require("path");
const axios = require("axios");

// === 配置 ===
const CONFIG_PATH = path.join(__dirname, "KVideo-config.json");
const REPORT_PATH = path.join(__dirname, "report.md");
const ADULT_JSON_PATH = path.join(__dirname, "adult.json");
const LITE_JSON_PATH = path.join(__dirname, "lite.json");

const SEARCH_KEYWORD = process.argv[2] || "大陆";
const TIMEOUT_MS = 10000;
const CONCURRENT_LIMIT = 5; 
const MAX_RETRY = 2;

if (!fs.existsSync(CONFIG_PATH)) {
    console.error("❌ 配置文件不存在");
    process.exit(1);
}

const configArray = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

// 读取历史记录
let history = [];
if (fs.existsSync(REPORT_PATH)) {
    const old = fs.readFileSync(REPORT_PATH, "utf-8");
    const match = old.match(/```json\n([\s\S]+?)\n```/);
    if (match) { try { history = JSON.parse(match[1]); } catch (e) {} }
}

const delay = ms => new Promise(r => setTimeout(r, ms));

async function testSource(item) {
    if (item.enabled === false) return { success: false, reason: "手动禁用", isManualDisabled: true };
    
    const url = item.baseUrl;
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
        try {
            const res = await axios.get(`${url}?ac=detail&wd=${encodeURIComponent(SEARCH_KEYWORD)}`, { timeout: TIMEOUT_MS });
            if (res.data && res.data.list && res.data.list.length > 0) {
                return { success: true, reason: "正常" };
            }
            return { success: false, reason: res.data.list ? "搜索无结果" : "接口解析错误" };
        } catch (e) {
            if (attempt === MAX_RETRY) return { success: false, reason: "超时/宕机" };
            await delay(1000);
        }
    }
}

(async () => {
    console.log(`⏳ 巡检开始: [${SEARCH_KEYWORD}]`);
    
    const pool = configArray.map(item => testSource(item).then(res => ({ ...item, ...res })));
    const todayResults = await Promise.all(pool);

    // 更新历史
    history.push({ 
        date: new Date().toISOString().slice(0, 10), 
        results: todayResults.map(r => ({ api: r.baseUrl, success: r.success })) 
    });
    if (history.length > 30) history = history.slice(-30);

    // 处理数据
    const stats = todayResults.map(item => {
        const historyEntries = history.map(h => h.results.find(x => x.api === item.baseUrl)).filter(Boolean);
        const okCount = historyEntries.filter(h => h.success).length;
        const rate = (okCount / historyEntries.length) * 100;
        const trend = history.slice(-7).map(h => {
            const r = h.results.find(x => x.api === item.baseUrl);
            return r ? (r.success ? "✅" : "❌") : "-";
        }).join("");

        let streakFail = 0;
        for (let i = history.length - 1; i >= 0; i--) {
            const r = history[i].results.find(x => x.api === item.baseUrl);
            if (r && !r.success) streakFail++;
            else break;
        }

        let statusIcon = "✅";
        if (item.isManualDisabled) statusIcon = "🚫";
        else if (streakFail >= 3) statusIcon = "🚨";
        else if (!item.success) statusIcon = "❌";

        let priority = 50;
        if (statusIcon === "✅") priority = rate >= 100 ? 1 : (rate >= 90 ? 5 : 10);
        else if (statusIcon === "🚫") priority = 999;
        else priority = 100 + streakFail;

        return { ...item, statusIcon, rate: rate.toFixed(1) + "%", trend, priority };
    });

    // 写入 JSON
    const adultData = stats.map(s => ({
        id: s.id, name: s.name, baseUrl: s.baseUrl, group: s.group || "normal",
        enabled: s.statusIcon === "✅", priority: s.priority,
        ...(s.statusIcon !== "✅" ? { _comment: s.reason } : {})
    })).sort((a, b) => a.priority - b.priority);
    
    fs.writeFileSync(ADULT_JSON_PATH, JSON.stringify(adultData, null, 2));
    fs.writeFileSync(LITE_JSON_PATH, JSON.stringify(adultData.filter(s => s.group !== "premium" && s.enabled), null, 2));

    // --- 生成 report.md ---
    const nowCST = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 16) + " CST";
    let md = `# 🎬 API 健康巡检报告\n\n`;
    md += `> **更新时间：** ${nowCST} | **检测关键字：** ${SEARCH_KEYWORD}\n\n`;
    md += `| 状态 | 资源名称 | 优先级 | 成功率 | 最近7天趋势 | 源站地址 | 备注 |\n`;
    md += `| :--- | :--- | :---: | :---: | :--- | :--- | :--- |\n`;
    
    stats.sort((a, b) => a.priority - b.priority).forEach(s => {
        // 美化地址显示，如果太长则截断或只保留域名
        const shortUrl = s.baseUrl.replace('https://', '').replace('http://', '').split('/')[0];
        const urlLink = `[${shortUrl}](${s.baseUrl})`;
        const comment = s.statusIcon === "✅" ? "-" : s.reason;
        
        md += `| ${s.statusIcon} | **${s.name}** | ${s.priority} | ${s.rate} | \`${s.trend}\` | ${urlLink} | ${comment} |\n`;
    });

    md += `\n\n### 💡 状态说明\n- ✅ **可用** | ❌ **失联** | 🚨 **连断3天+** | 🚫 **手动禁用**\n\n`;
    md += `<details><summary>📜 历史统计数据 (JSON)</summary>\n\n\`\`\`json\n${JSON.stringify(history, null, 2)}\n\`\`\`\n</details>\n`;
    
    fs.writeFileSync(REPORT_PATH, md);
})();
