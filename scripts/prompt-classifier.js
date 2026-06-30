export function titleFromText(text, fallback = "Prompt") {
  const firstLine = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return fallback;
  return firstLine.length > 100 ? `${firstLine.slice(0, 100)}...` : firstLine;
}

export function previewFromText(text) {
  const oneLine = String(text || "").replace(/\s+/g, " ").trim();
  return oneLine.length > 260 ? `${oneLine.slice(0, 260)}...` : oneLine;
}

export function classifyPrompt(text) {
  const lower = String(text || "").toLowerCase();

  if (/poster|typography|font|headline|magazine|cover|flyer|layout|print|海报|排版|字体|封面|杂志/.test(lower)) {
    return { category: "Posters & Typography", styles: ["Poster"], scenes: ["Social"] };
  }
  if (/photo|photograph|portrait|camera|lens|cinematic|realistic|editorial|iphone|film|studio|摄影|写真|镜头|写实|照片|人像/.test(lower)) {
    return { category: "Photography & Realism", styles: ["Photography", "Realistic"], scenes: ["Creative"] };
  }
  if (/logo|brand|branding|packaging|product|commercial|watch|car|bottle|shop|商品|品牌|包装|电商|产品/.test(lower)) {
    return { category: "Products & E-commerce", styles: ["Product", "Brand"], scenes: ["Commerce"] };
  }
  if (/infographic|diagram|chart|map|data|visualization|dashboard|信息图|图表|地图|可视化/.test(lower)) {
    return { category: "Charts & Infographics", styles: ["Infographic"], scenes: ["Education"] };
  }
  if (/character|avatar|hero|mascot|turnaround|sheet|anime|toy|figure|角色|人物|头像|玩具|设定/.test(lower)) {
    return { category: "Characters & People", styles: ["Character"], scenes: ["Creative"] };
  }
  if (/\bui\b|app|dashboard|interface|website|mobile|screen|界面|应用|网页|截图/.test(lower)) {
    return { category: "UI & Interfaces", styles: ["UI"], scenes: ["Tech"] };
  }
  if (/architecture|interior|building|room|space|hotel|house|建筑|室内|空间|房间|酒店/.test(lower)) {
    return { category: "Architecture & Space", styles: ["Architecture"], scenes: ["Space"] };
  }
  if (/document|book|publication|brochure|report|menu|card|文档|出版|书籍|手册|报告|菜单/.test(lower)) {
    return { category: "Documents & Publications", styles: ["Document"], scenes: ["Publication"] };
  }
  if (/history|ancient|traditional|wuxia|samurai|hanfu|retro|历史|古风|古代|传统|武侠/.test(lower)) {
    return { category: "History & Ancient Styles", styles: ["Historical"], scenes: ["Creative"] };
  }
  if (/story|scene|video|storyboard|workflow|cctv|wide shot|分镜|场景|视频|故事|监控/.test(lower)) {
    return { category: "Scenes & Storytelling", styles: ["Scenes"], scenes: ["Story"] };
  }
  if (/illustration|flat|vector|painting|watercolor|3d render|插画|艺术|绘画|矢量/.test(lower)) {
    return { category: "Illustration & Art", styles: ["Illustration"], scenes: ["Creative"] };
  }

  return { category: "Other Use Cases", styles: ["Other Use Cases"], scenes: ["Creative"] };
}
