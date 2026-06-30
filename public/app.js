const state = {
  tab: "review",
  status: "pending",
  search: "",
  limit: 24,
  offset: 0,
  total: 0,
  user: null,
  categories: [],
  schedules: [],
  scrapeHistory: [],
  creators: {
    search: "",
    limit: 24,
    offset: 0,
    total: 0
  },
  approved: {
    search: "",
    category: "all",
    limit: 12,
    offset: 0,
    total: 0,
    selected: new Set()
  }
};

const list = document.querySelector("#list");
const stats = document.querySelector("#stats");
const currentUser = document.querySelector("#currentUser");
const logout = document.querySelector("#logout");
const template = document.querySelector("#promptTemplate");
const search = document.querySelector("#search");
const pageInfo = document.querySelector("#pageInfo");
const prev = document.querySelector("#prev");
const next = document.querySelector("#next");
const pageSize = document.querySelector("#pageSize");
const pageSelect = document.querySelector("#pageSelect");
const autoReview = document.querySelector("#autoReview");
const lightbox = document.querySelector("#lightbox");
const lightboxImage = document.querySelector("#lightboxImage");
const lightboxTitle = document.querySelector("#lightboxTitle");
const lightboxCounter = document.querySelector("#lightboxCounter");
const lightboxOpen = document.querySelector("#lightboxOpen");
const lightboxPrev = document.querySelector("#lightboxPrev");
const lightboxNext = document.querySelector("#lightboxNext");
const scrapeStatusText = document.querySelector("#scrapeStatusText");
const scrapeProgressBar = document.querySelector("#scrapeProgressBar");
const scrapeProgressLabel = document.querySelector("#scrapeProgressLabel");
const scrapeDelta = document.querySelector("#scrapeDelta");
const scrapeTasks = document.querySelector("#scrapeTasks");
const scrapeLogs = document.querySelector("#scrapeLogs");
const scrapeStart = document.querySelector("#scrapeStart");
const scrapePause = document.querySelector("#scrapePause");
const scrapeResume = document.querySelector("#scrapeResume");
const scrapeStop = document.querySelector("#scrapeStop");
const scheduleForm = document.querySelector("#scheduleForm");
const scheduleStartTime = document.querySelector("#scheduleStartTime");
const scheduleEndTime = document.querySelector("#scheduleEndTime");
const scheduleLabel = document.querySelector("#scheduleLabel");
const scheduleList = document.querySelector("#scheduleList");
const scrapeHistory = document.querySelector("#scrapeHistory");
const creatorSearch = document.querySelector("#creatorSearch");
const creatorList = document.querySelector("#creatorList");
const creatorPrev = document.querySelector("#creatorPrev");
const creatorNext = document.querySelector("#creatorNext");
const creatorPageSize = document.querySelector("#creatorPageSize");
const creatorPageSelect = document.querySelector("#creatorPageSelect");
const creatorPageInfo = document.querySelector("#creatorPageInfo");
const approvedSearch = document.querySelector("#approvedSearch");
const approvedCategories = document.querySelector("#approvedCategories");
const approvedList = document.querySelector("#approvedList");
const approvedPrev = document.querySelector("#approvedPrev");
const approvedNext = document.querySelector("#approvedNext");
const approvedPageSize = document.querySelector("#approvedPageSize");
const approvedPageSelect = document.querySelector("#approvedPageSelect");
const approvedPageInfo = document.querySelector("#approvedPageInfo");
const approvedSelectedInfo = document.querySelector("#approvedSelectedInfo");
const bulkCategory = document.querySelector("#bulkCategory");
const bulkApplyCategory = document.querySelector("#bulkApplyCategory");
const newCategoryName = document.querySelector("#newCategoryName");
const addCategory = document.querySelector("#addCategory");
const editCategorySelect = document.querySelector("#editCategorySelect");
const editCategoryName = document.querySelector("#editCategoryName");
const renameCategory = document.querySelector("#renameCategory");

let activeImages = [];
let activeImageIndex = 0;
let activeImageTitle = "";
let scrapePollTimer = null;

const statusLabels = {
  pending: "待审核",
  approved: "已通过",
  duplicate: "重复",
  rejected: "已驳回"
};

const scrapeStatusLabels = {
  idle: "未启动",
  running: "运行中",
  paused: "已暂停",
  stopping: "停止中",
  stopped: "已停止",
  completed: "已完成",
  error: "异常"
};

const taskStatusLabels = {
  idle: "等待",
  running: "运行中",
  paused: "已暂停",
  completed: "完成",
  failed: "失败",
  stopped: "已停止"
};

function activeCategoryOptions() {
  return state.categories.length
    ? state.categories
    : [
        { value: "摄影与写实", aliases: ["Photography & Realism"] },
        { value: "人物与角色", aliases: ["Characters & People"] },
        { value: "海报与排版", aliases: ["Posters & Typography"] },
        { value: "插画与艺术", aliases: [] },
        { value: "品牌与标志", aliases: [] },
        { value: "图表与信息可视化", aliases: ["Charts & Infographics"] },
        { value: "场景与叙事", aliases: ["Scenes & Storytelling"] },
        { value: "建筑与空间", aliases: [] },
        { value: "商品与电商", aliases: ["Products & E-commerce"] },
        { value: "文档与出版物", aliases: [] },
        { value: "UI 与界面", aliases: ["UI & Interfaces"] },
        { value: "历史与古风题材", aliases: [] },
        { value: "其他应用场景", aliases: ["Other Use Cases"] }
      ];
}

function selectedCategoryOption() {
  return activeCategoryOptions().find((item) => String(item.id) === String(editCategorySelect.value));
}

function displayCategory(value) {
  const option = activeCategoryOptions().find((item) => item.value === value || (item.aliases || []).includes(value));
  return option?.value || value || "-";
}

function tagList(values) {
  const items = Array.isArray(values) ? values : [];
  if (!items.length) return "<span class=\"muted\">-</span>";
  return items.map((value) => `<span class="tag">${escapeHtml(value)}</span>`).join("");
}

function firstLetterAvatar(handle, name) {
  const text = String(name || handle || "?").replace(/^@/, "").trim();
  return escapeHtml((text[0] || "?").toUpperCase());
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function renderPageSelect(select, page, pages) {
  select.innerHTML = "";
  for (let index = 1; index <= pages; index += 1) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = String(index);
    option.selected = index === page;
    select.appendChild(option);
  }
  select.disabled = pages <= 1;
}

function itemImages(item) {
  const images = Array.isArray(item.image_urls) ? item.image_urls.filter(Boolean) : [];
  if (!images.length && item.image_url) return [item.image_url];
  return [...new Set(images)];
}

function proxiedImageUrl(url) {
  if (/^https?:\/\/useaifor\.me\/prompt-images\//i.test(url)) return url;
  return `/api/image?url=${encodeURIComponent(url)}`;
}

function renderMedia(media, item) {
  const images = itemImages(item);
  media.innerHTML = "";
  media.className = "media";
  if (!images.length) {
    media.classList.add("placeholder");
    media.textContent = "No image";
    return;
  }
  media.classList.toggle("multi", images.length > 1);
  images.slice(0, 4).forEach((url, index) => {
    const button = document.createElement("button");
    button.className = "image-thumb";
    button.type = "button";
    button.title = "查看大图";
    const img = document.createElement("img");
    img.src = proxiedImageUrl(url);
    img.dataset.originalUrl = url;
    img.alt = item.image_alt || item.title || "";
    img.loading = "lazy";
    button.appendChild(img);
    button.addEventListener("click", () => openLightbox(images, index, item.title || item.source_handle || ""));
    media.appendChild(button);
  });
  if (images.length > 4) {
    const badge = document.createElement("span");
    badge.className = "image-count";
    badge.textContent = `+${images.length - 4}`;
    media.appendChild(badge);
  }
}

function openLightbox(images, index, title) {
  activeImages = images;
  activeImageIndex = index;
  activeImageTitle = title;
  updateLightbox();
  lightbox.hidden = false;
  document.body.classList.add("modal-open");
}

function closeLightbox() {
  lightbox.hidden = true;
  document.body.classList.remove("modal-open");
}

function moveLightbox(delta) {
  if (!activeImages.length) return;
  activeImageIndex = (activeImageIndex + delta + activeImages.length) % activeImages.length;
  updateLightbox();
}

function updateLightbox() {
  const url = activeImages[activeImageIndex];
  lightboxImage.src = proxiedImageUrl(url);
  lightboxImage.alt = activeImageTitle;
  lightboxTitle.textContent = activeImageTitle;
  lightboxCounter.textContent = `${activeImageIndex + 1} / ${activeImages.length}`;
  lightboxOpen.href = url;
  lightboxPrev.disabled = activeImages.length <= 1;
  lightboxNext.disabled = activeImages.length <= 1;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    window.location.href = "/login.html";
    throw new Error("UNAUTHORIZED");
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

async function loadCurrentUser() {
  const data = await requestJson("/api/auth/me");
  state.user = data.user;
  currentUser.textContent = data.user?.displayName || data.user?.username || "-";
}

async function loadCategories() {
  const data = await requestJson("/api/categories");
  state.categories = data.categories || [];
  renderApprovedCategoryControls();
}

function renderApprovedCategoryControls() {
  const options = activeCategoryOptions();
  approvedCategories.innerHTML = [
    `<button type="button" class="${state.approved.category === "all" ? "active" : ""}" data-category="all">全部</button>`,
    ...options.map(
      (item) =>
        `<button type="button" class="${state.approved.category === item.value ? "active" : ""}" data-category="${escapeHtml(item.value)}">${escapeHtml(item.value)}</button>`
    )
  ].join("");
  approvedCategories.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      state.approved.category = button.dataset.category || "all";
      state.approved.offset = 0;
      state.approved.selected.clear();
      loadApprovedPrompts().catch(showApprovedError);
    });
  });
  bulkCategory.innerHTML = `<option value="">选择新分类</option>${options
    .map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.value)}</option>`)
    .join("")}`;
  renderCategoryManager(options);
}

function renderCategoryManager(options = activeCategoryOptions()) {
  const selected = editCategorySelect.value;
  editCategorySelect.innerHTML = options
    .map((item) => `<option value="${escapeHtml(item.id ?? item.value)}">${escapeHtml(item.value)}</option>`)
    .join("");
  const hasSelected = [...editCategorySelect.options].some((option) => option.value === selected);
  if (hasSelected) editCategorySelect.value = selected;
  const option = selectedCategoryOption() || options[0];
  if (option) {
    editCategorySelect.value = String(option.id ?? option.value);
    editCategoryName.value = option.value;
  } else {
    editCategoryName.value = "";
  }
  renameCategory.disabled = !option;
}

async function addPromptCategory() {
  const name = newCategoryName.value.trim();
  if (!name) {
    window.alert("分类名称不能为空");
    return;
  }
  addCategory.disabled = true;
  try {
    const data = await requestJson("/api/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    state.categories = data.categories || [];
    newCategoryName.value = "";
    state.approved.category = name;
    state.approved.offset = 0;
    state.approved.selected.clear();
    renderApprovedCategoryControls();
    await loadApprovedPrompts();
  } finally {
    addCategory.disabled = false;
  }
}

async function renamePromptCategory() {
  const option = selectedCategoryOption();
  const name = editCategoryName.value.trim();
  if (!option || !name) {
    window.alert("请选择分类并填写新名称");
    return;
  }
  if (name === option.value) return;
  renameCategory.disabled = true;
  try {
    const data = await requestJson(`/api/categories/${encodeURIComponent(option.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    state.categories = data.categories || [];
    if (state.approved.category === option.value || (option.aliases || []).includes(state.approved.category)) {
      state.approved.category = name;
    }
    state.approved.offset = 0;
    state.approved.selected.clear();
    renderApprovedCategoryControls();
    await loadApprovedPrompts();
    window.alert(`已更新分类名称，同步正式表 ${data.updatedApproved || 0} 条，待审核表 ${data.updatedRaw || 0} 条`);
  } finally {
    renameCategory.disabled = false;
  }
}

function renderScrapeStatus(data) {
  const status = data.status || "idle";
  const progress = Math.max(0, Math.min(100, Number(data.progress || 0)));
  scrapeStatusText.textContent = scrapeStatusLabels[status] || status;
  scrapeStatusText.className = `scrape-status ${status}`;
  scrapeProgressBar.style.width = `${progress}%`;
  scrapeProgressLabel.textContent =
    status === "idle"
      ? "等待启动"
      : `${progress}% · 新增提示词 ${data.delta?.x || 0} 条 · 新增博主 ${data.delta?.creators || 0} 个 · 云端图片 ${data.delta?.cloudImages || 0} 张`;

  scrapeDelta.innerHTML = [
    ["提示词总数", data.counts?.rawTotal || 0],
    ["X 来源", data.counts?.xTotal || 0],
    ["博主", data.counts?.creators || 0],
    ["云端图片", data.counts?.cloudImages || 0]
  ].map(([label, value]) => `<span><b>${escapeHtml(value)}</b>${label}</span>`).join("");

  const tasks = Object.values(data.tasks || {});
  scrapeTasks.innerHTML = tasks.length
    ? tasks
        .map((task) => {
          const taskProgress = task.total ? Math.round((Math.min(task.current, task.total) / task.total) * 100) : 0;
          const parts = [
            task.phase,
            task.subject,
            task.total ? `${task.current}/${task.total}` : "",
            `新增 ${task.inserted || 0}`,
            task.updated ? `更新 ${task.updated}` : "",
            task.skipped ? `跳过 ${task.skipped}` : "",
            task.errors ? `错误 ${task.errors}` : ""
          ].filter(Boolean);
          return `
            <div class="scrape-task">
              <div class="scrape-task-head">
                <strong>${escapeHtml(task.label)}</strong>
                <span>${escapeHtml(taskStatusLabels[task.status] || task.status)} · ${taskProgress}%</span>
              </div>
              <div class="scrape-task-bar"><span style="width: ${taskProgress}%"></span></div>
              <p>${escapeHtml(parts.join(" · "))}</p>
            </div>
          `;
        })
        .join("")
    : "<div class=\"scrape-task muted\">暂无任务</div>";

  scrapeLogs.textContent = (data.logs || []).join("\n");
  scrapeLogs.scrollTop = scrapeLogs.scrollHeight;

  scrapeStart.disabled = ["running", "paused", "stopping"].includes(status);
  scrapePause.disabled = status !== "running";
  scrapeResume.disabled = status !== "paused";
  scrapeStop.disabled = !["running", "paused", "stopping"].includes(status);

  if (["running", "paused", "stopping"].includes(status)) startScrapePolling();
  else stopScrapePolling();
}

async function loadScrapeStatus() {
  const data = await requestJson("/api/scrape/status");
  renderScrapeStatus(data);
  if (["running", "paused", "stopping", "completed", "stopped", "error"].includes(data.status)) {
    loadStats().catch(() => {});
    loadScrapeHistory().catch(() => {});
  }
  return data;
}

function startScrapePolling() {
  if (scrapePollTimer) return;
  scrapePollTimer = window.setInterval(() => {
    loadScrapeStatus().catch((error) => {
      scrapeProgressLabel.textContent = `采集状态读取失败：${error.message}`;
    });
  }, 2000);
}

function stopScrapePolling() {
  if (!scrapePollTimer) return;
  window.clearInterval(scrapePollTimer);
  scrapePollTimer = null;
}

async function scrapeAction(action) {
  const buttonMap = {
    start: scrapeStart,
    pause: scrapePause,
    resume: scrapeResume,
    stop: scrapeStop
  };
  const button = buttonMap[action];
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = action === "start" ? "启动中" : action === "stop" ? "停止中" : "处理中";
  try {
    const data = await requestJson(`/api/scrape/${action}`, { method: "POST" });
    renderScrapeStatus(data);
    await Promise.all([loadStats(), state.tab === "review" ? loadPrompts() : Promise.resolve(), loadScrapeHistory()]);
  } catch (error) {
    window.alert(error.message);
    await loadScrapeStatus().catch(() => {});
  } finally {
    button.textContent = oldText;
  }
}

async function loadSchedules() {
  const data = await requestJson("/api/scrape/schedules");
  state.schedules = data.items || [];
  renderSchedules();
}

function renderSchedules() {
  if (!state.schedules.length) {
    scheduleList.innerHTML = "<div class=\"empty compact-empty\">暂无定时任务</div>";
    return;
  }
  scheduleList.innerHTML = state.schedules
    .map(
      (item) => {
        const startTime = item.startTime || item.time || "-";
        const endTime = item.endTime || "-";
        return `
        <article class="schedule-card">
          <div>
            <strong>${escapeHtml(startTime)}-${escapeHtml(endTime)}</strong>
            <span>${escapeHtml(item.label || `每天 ${startTime}-${endTime}`)}</span>
          </div>
          <div class="schedule-edit">
            <label><span>开始</span><input type="time" data-field="startTime" data-id="${escapeHtml(item.id)}" value="${escapeHtml(startTime)}"></label>
            <label><span>结束</span><input type="time" data-field="endTime" data-id="${escapeHtml(item.id)}" value="${escapeHtml(endTime)}"></label>
            <input type="text" data-field="label" data-id="${escapeHtml(item.id)}" value="${escapeHtml(item.label || "")}" placeholder="备注">
          </div>
          <div class="schedule-meta">
            <span>${item.enabled ? "已启用" : "已停用"}</span>
            <span>上次执行 ${escapeHtml(formatDateTime(item.lastRunAt))}</span>
            ${item.lastSkipAt ? `<span>跳过 ${escapeHtml(formatDateTime(item.lastSkipAt))}：${escapeHtml(item.lastSkipReason || "")}</span>` : ""}
          </div>
          <div class="schedule-actions">
            <button type="button" data-action="save" data-id="${escapeHtml(item.id)}">保存</button>
            <button type="button" data-action="toggle" data-id="${escapeHtml(item.id)}">${item.enabled ? "停用" : "启用"}</button>
            <button type="button" class="reject" data-action="delete" data-id="${escapeHtml(item.id)}">删除</button>
          </div>
        </article>
      `;
      }
    )
    .join("");
  scheduleList.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => updateSchedule(button.dataset.id, button.dataset.action).catch((error) => window.alert(error.message)));
  });
}

async function addSchedule(event) {
  event.preventDefault();
  const startTime = scheduleStartTime.value;
  const endTime = scheduleEndTime.value;
  const label = scheduleLabel.value.trim();
  await requestJson("/api/scrape/schedules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ startTime, endTime, label })
  });
  scheduleForm.reset();
  await loadSchedules();
}

async function updateSchedule(id, action) {
  const item = state.schedules.find((schedule) => schedule.id === id);
  if (!item) return;
  if (action === "delete") {
    await requestJson(`/api/scrape/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
  } else if (action === "toggle") {
    await requestJson(`/api/scrape/schedules/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !item.enabled })
    });
  } else if (action === "save") {
    const card = scheduleList.querySelector(`[data-action="save"][data-id="${CSS.escape(id)}"]`)?.closest(".schedule-card");
    const startTime = card?.querySelector('[data-field="startTime"]')?.value;
    const endTime = card?.querySelector('[data-field="endTime"]')?.value;
    const label = card?.querySelector('[data-field="label"]')?.value.trim();
    await requestJson(`/api/scrape/schedules/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startTime, endTime, label })
    });
  }
  await loadSchedules();
}

async function loadScrapeHistory() {
  const data = await requestJson("/api/scrape/history");
  state.scrapeHistory = data.items || [];
  renderScrapeHistory();
}

function renderScrapeHistory() {
  if (!state.scrapeHistory.length) {
    scrapeHistory.innerHTML = "<div class=\"empty compact-empty\">暂无采集记录</div>";
    return;
  }
  scrapeHistory.innerHTML = state.scrapeHistory
    .map((item) => {
      const delta = item.delta || {};
      const tasks = Object.values(item.tasks || {});
      return `
        <article class="history-card">
          <div class="history-head">
            <div>
              <strong>${escapeHtml(formatDateTime(item.startedAt))}</strong>
              <span>${item.trigger === "schedule" ? "定时采集" : "手动采集"} · ${escapeHtml(scrapeStatusLabels[item.status] || item.status)}${item.scheduleEndAt ? ` · 自动停止 ${escapeHtml(formatDateTime(item.scheduleEndAt))}` : ""}</span>
            </div>
            <div class="history-delta">
              <span>提示词 +${delta.x || 0}</span>
              <span>博主 +${delta.creators || 0}</span>
              <span>图片 +${delta.cloudImages || 0}</span>
            </div>
          </div>
          <div class="history-tasks">
            ${tasks
              .map(
                (task) =>
                  `<span>${escapeHtml(task.label)}：新增 ${task.inserted || 0}，更新 ${task.updated || 0}，跳过 ${task.skipped || 0}</span>`
              )
              .join("")}
          </div>
          <details>
            <summary>查看本轮日志</summary>
            <pre>${escapeHtml((item.logs || []).join("\n"))}</pre>
          </details>
        </article>
      `;
    })
    .join("");
}

async function loadStats() {
  const data = await requestJson("/api/stats");
  const raw = data.raw || {};
  stats.innerHTML = [
    ["博主", data.creators || 0],
    ["待审", raw.pending || 0],
    ["正式", data.approved || 0],
    ["重复", raw.duplicate || 0],
    ["驳回", raw.rejected || 0]
  ].map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`).join("");
}

async function loadPrompts() {
  list.innerHTML = "<div class=\"empty\">加载中...</div>";
  const params = new URLSearchParams({
    status: state.status,
    search: state.search,
    limit: String(state.limit),
    offset: String(state.offset)
  });
  const data = await requestJson(`/api/raw-prompts?${params.toString()}`);
  state.total = data.total || 0;
  if (state.offset >= state.total && state.total > 0) {
    state.offset = Math.max(0, (Math.ceil(state.total / state.limit) - 1) * state.limit);
    return loadPrompts();
  }
  renderPrompts(data.items || []);
  renderPager();
}

function showCreatorError(error) {
  creatorList.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
}

function showApprovedError(error) {
  approvedList.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
}

async function loadCreators() {
  creatorList.innerHTML = "<div class=\"empty\">加载中...</div>";
  const params = new URLSearchParams({
    search: state.creators.search,
    limit: String(state.creators.limit),
    offset: String(state.creators.offset)
  });
  const data = await requestJson(`/api/creators?${params.toString()}`);
  state.creators.total = data.total || 0;
  if (state.creators.offset >= state.creators.total && state.creators.total > 0) {
    state.creators.offset = Math.max(0, (Math.ceil(state.creators.total / state.creators.limit) - 1) * state.creators.limit);
    return loadCreators();
  }
  renderCreators(data.items || []);
  renderCreatorPager();
}

function renderCreators(items) {
  creatorList.innerHTML = "";
  if (!items.length) {
    creatorList.innerHTML = "<div class=\"empty\">没有匹配博主</div>";
    return;
  }
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "creator-card";
    const avatar = item.avatar_url
      ? `<img src="${proxiedImageUrl(item.avatar_url)}" alt="${escapeHtml(item.display_name || item.handle)}" loading="lazy">`
      : `<span>${firstLetterAvatar(item.handle, item.display_name)}</span>`;
    card.innerHTML = `
      <div class="creator-avatar">${avatar}</div>
      <div class="creator-body">
        <div class="creator-head">
          <a href="${escapeHtml(item.profile_url || `https://x.com/${String(item.handle || "").replace(/^@/, "")}`)}" target="_blank" rel="noreferrer">${escapeHtml(item.handle)}</a>
          <span class="status-pill ${item.monitor_enabled ? "approved" : "rejected"}">${item.monitor_enabled ? "监控中" : "已停用"}</span>
        </div>
        <h2>${escapeHtml(item.display_name || item.handle)}</h2>
        <p>${escapeHtml(item.bio || item.discovery_query || "暂无简介")}</p>
        <div class="creator-meta">
          <span>来源样本 <b>${item.source_case_count || 0}</b></span>
          <span>提及 <b>${item.status_link_count || 0}</b></span>
          <span>评分 <b>${item.discovery_score || 0}</b></span>
          <span>最近抓取 <b>${escapeHtml(formatDateTime(item.last_scraped_at))}</b></span>
        </div>
        ${item.last_scrape_error ? `<div class="creator-error">${escapeHtml(item.last_scrape_error)}</div>` : ""}
      </div>
    `;
    creatorList.appendChild(card);
  }
}

function renderCreatorPager() {
  const page = Math.floor(state.creators.offset / state.creators.limit) + 1;
  const pages = Math.max(1, Math.ceil(state.creators.total / state.creators.limit));
  creatorPageSize.value = String(state.creators.limit);
  renderPageSelect(creatorPageSelect, page, pages);
  creatorPageInfo.textContent = `共 ${state.creators.total} 个`;
  creatorPrev.disabled = state.creators.offset <= 0;
  creatorNext.disabled = state.creators.offset + state.creators.limit >= state.creators.total;
}

async function loadApprovedPrompts() {
  approvedList.innerHTML = "<div class=\"empty\">加载中...</div>";
  const params = new URLSearchParams({
    search: state.approved.search,
    category: state.approved.category,
    limit: String(state.approved.limit),
    offset: String(state.approved.offset)
  });
  const data = await requestJson(`/api/approved-prompts?${params.toString()}`);
  state.approved.total = data.total || 0;
  if (state.approved.offset >= state.approved.total && state.approved.total > 0) {
    state.approved.offset = Math.max(0, (Math.ceil(state.approved.total / state.approved.limit) - 1) * state.approved.limit);
    return loadApprovedPrompts();
  }
  renderApprovedPrompts(data.items || []);
  renderApprovedPager();
  renderApprovedCategoryControls();
  renderApprovedSelectedInfo();
}

function renderApprovedPrompts(items) {
  approvedList.innerHTML = "";
  if (!items.length) {
    approvedList.innerHTML = "<div class=\"empty\">没有已通过数据</div>";
    return;
  }
  for (const item of items) {
    const images = itemImages(item);
    const card = document.createElement("article");
    card.className = "approved-card";
    const checked = state.approved.selected.has(Number(item.id)) ? "checked" : "";
    card.innerHTML = `
      <label class="approved-check">
        <input type="checkbox" value="${item.id}" ${checked}>
      </label>
      <button class="approved-thumb" type="button" ${images.length ? "" : "disabled"}>
        ${
          images.length
            ? `<img src="${proxiedImageUrl(images[0])}" alt="${escapeHtml(item.image_alt || item.title || "")}" loading="lazy">`
            : "<span>No image</span>"
        }
      </button>
      <div class="approved-body">
        <div class="meta-row">
          <a class="source" href="${escapeHtml(item.source_url || "#")}" target="_blank" rel="noreferrer">${escapeHtml(item.source_handle || "unknown")}</a>
          <div class="approved-meta">
            <span>审核 ${escapeHtml(item.approved_by || "-")} · ${escapeHtml(formatDateTime(item.approved_at))}</span>
            <span class="tag">${escapeHtml(displayCategory(item.category))}</span>
          </div>
        </div>
        <h2>${escapeHtml(item.title || `Prompt #${item.id}`)}</h2>
        <p>${escapeHtml(item.prompt_preview || "")}</p>
        <div class="approved-tags">${tagList(item.styles)} ${tagList(item.scenes)}</div>
        <div class="approved-actions">
          <button class="reject approved-reject" type="button">退回</button>
        </div>
      </div>
    `;
    card.querySelector("input").addEventListener("change", (event) => {
      const id = Number(event.currentTarget.value);
      if (event.currentTarget.checked) state.approved.selected.add(id);
      else state.approved.selected.delete(id);
      renderApprovedSelectedInfo();
    });
    card.querySelector(".approved-thumb").addEventListener("click", () => {
      if (images.length) openLightbox(images, 0, item.title || item.source_handle || "");
    });
    card.querySelector(".approved-reject").addEventListener("click", () => rejectApprovedPrompt(item.id));
    approvedList.appendChild(card);
  }
}

function renderApprovedPager() {
  const page = Math.floor(state.approved.offset / state.approved.limit) + 1;
  const pages = Math.max(1, Math.ceil(state.approved.total / state.approved.limit));
  approvedPageSize.value = String(state.approved.limit);
  renderPageSelect(approvedPageSelect, page, pages);
  approvedPageInfo.textContent = `共 ${state.approved.total} 条`;
  approvedPrev.disabled = state.approved.offset <= 0;
  approvedNext.disabled = state.approved.offset + state.approved.limit >= state.approved.total;
}

function renderApprovedSelectedInfo() {
  approvedSelectedInfo.textContent = `已选 ${state.approved.selected.size} 条`;
  bulkApplyCategory.disabled = state.approved.selected.size === 0 || !bulkCategory.value;
}

async function applyBulkCategory() {
  const ids = [...state.approved.selected];
  const category = bulkCategory.value;
  if (!ids.length || !category) return;
  const data = await requestJson("/api/approved-prompts/category", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, category })
  });
  state.approved.selected.clear();
  await Promise.all([loadApprovedPrompts(), loadStats()]);
  window.alert(`已修改 ${data.updated || 0} 条`);
}

async function rejectApprovedPrompt(id) {
  await requestJson(`/api/approved-prompts/${id}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "管理员从已通过列表退回" })
  });
  state.approved.selected.delete(Number(id));
  await Promise.all([loadApprovedPrompts(), loadStats()]);
}

function renderPrompts(items) {
  list.innerHTML = "";
  if (!items.length) {
    list.innerHTML = "<div class=\"empty\">没有匹配数据</div>";
    return;
  }
  for (const item of items) {
    const node = template.content.firstElementChild.cloneNode(true);
    const source = node.querySelector(".source");
    const media = node.querySelector(".media");
    const status = node.querySelector(".status-pill");
    const scrapedAt = node.querySelector(".scraped-at");
    const promptEdit = node.querySelector(".prompt-edit");
    const translation = node.querySelector(".translation");
    const translationBody = node.querySelector(".translation-body");

    source.textContent = item.source_handle || "unknown";
    source.href = item.source_url || `https://x.com/${String(item.source_handle || "").replace(/^@/, "")}`;
    status.textContent = statusLabels[item.review_status] || item.review_status;
    status.classList.add(item.review_status);
    scrapedAt.textContent = `采集 ${formatDateTime(item.scraped_at)}`;
    if (item.reviewed_by || item.reviewed_at) {
      scrapedAt.textContent += ` · 审核 ${item.reviewed_by || "-"} ${formatDateTime(item.reviewed_at)}`;
    }
    node.querySelector("h2").textContent = item.title || `Prompt #${item.id}`;
    node.querySelector(".preview").textContent = item.prompt_preview || "";
    node.querySelector(".category").textContent = item.category || "-";
    node.querySelector(".styles").innerHTML = tagList(item.styles);
    node.querySelector(".scenes").innerHTML = tagList(item.scenes);
    promptEdit.value = item.prompt || "";
    promptEdit.style.height = `${Math.min(420, Math.max(170, promptEdit.scrollHeight))}px`;
    promptEdit.addEventListener("input", () => {
      promptEdit.dataset.dirty = "true";
      promptEdit.style.height = "auto";
      promptEdit.style.height = `${Math.min(520, Math.max(170, promptEdit.scrollHeight))}px`;
    });

    renderMedia(media, item);

    node.querySelector(".approve").addEventListener("click", () => approvePrompt(item.id, promptEdit));
    node.querySelector(".save").addEventListener("click", () => savePrompt(item.id, promptEdit));
    node.querySelector(".translate").addEventListener("click", (event) =>
      translatePrompt(promptEdit, translation, translationBody, event.currentTarget)
    );
    node.querySelector(".reject").addEventListener("click", () => rejectPrompt(item.id));
    node.querySelector(".pending").addEventListener("click", () => markPending(item.id));
    node.querySelector(".copy").addEventListener("click", async (event) => {
      await navigator.clipboard.writeText(promptEdit.value || "");
      event.currentTarget.textContent = "已复制";
      window.setTimeout(() => {
        event.currentTarget.textContent = "复制";
      }, 1200);
    });

    if (item.review_status === "pending") {
      node.querySelector(".pending").disabled = true;
    }
    if (item.review_status === "approved" || item.review_status === "duplicate") {
      node.querySelector(".approve").disabled = true;
      node.querySelector(".save").disabled = true;
    }
    list.appendChild(node);
  }
}

function renderPager() {
  const page = Math.floor(state.offset / state.limit) + 1;
  const pages = Math.max(1, Math.ceil(state.total / state.limit));
  pageSize.value = String(state.limit);
  pageSelect.innerHTML = "";
  for (let index = 1; index <= pages; index += 1) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = String(index);
    option.selected = index === page;
    pageSelect.appendChild(option);
  }
  pageSelect.disabled = pages <= 1;
  pageInfo.textContent = `共 ${state.total} 条`;
  prev.disabled = state.offset <= 0;
  next.disabled = state.offset + state.limit >= state.total;
}

async function savePrompt(id, promptEdit) {
  const prompt = promptEdit.value.trim();
  if (!prompt) {
    window.alert("提示词不能为空");
    return false;
  }
  const button = promptEdit.closest(".prompt-card").querySelector(".save");
  button.disabled = true;
  button.textContent = "保存中";
  try {
    await requestJson(`/api/raw-prompts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt })
    });
    promptEdit.dataset.dirty = "false";
    button.textContent = "已保存";
    window.setTimeout(() => {
      button.textContent = "保存修改";
      button.disabled = false;
    }, 1000);
    return true;
  } catch (error) {
    button.textContent = "保存修改";
    button.disabled = false;
    window.alert(error.message);
    return false;
  }
}

async function approvePrompt(id, promptEdit) {
  if (promptEdit.dataset.dirty === "true") {
    const saved = await savePrompt(id, promptEdit);
    if (!saved) return;
  }
  try {
    await requestJson(`/api/raw-prompts/${id}/approve`, {
      method: "POST"
    });
    await refresh();
  } catch (error) {
    if (error.message === "PROMPT_SAFETY_BLOCKED") {
      window.alert("命中安全红线，已自动驳回，不能上架。");
      await refresh();
      return;
    }
    throw error;
  }
}

async function translatePrompt(promptEdit, translation, translationBody, button) {
  const text = promptEdit.value.trim();
  if (!text) {
    window.alert("提示词不能为空");
    return;
  }
  button.disabled = true;
  button.textContent = "翻译中";
  translation.hidden = false;
  translationBody.textContent = "翻译中...";
  try {
    const data = await requestJson("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    translationBody.textContent = data.translation || "没有翻译结果";
  } catch (error) {
    translationBody.textContent = `翻译失败：${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = "翻译";
  }
}

async function rejectPrompt(id) {
  await requestJson(`/api/raw-prompts/${id}/reject`, {
    method: "POST"
  });
  await refresh();
}

async function markPending(id) {
  await requestJson(`/api/raw-prompts/${id}/pending`, { method: "POST" });
  await refresh();
}

async function runAutoReview() {
  autoReview.disabled = true;
  const originalText = autoReview.textContent;
  autoReview.textContent = "初审中...";
  try {
    const data = await requestJson("/api/raw-prompts/auto-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: state.limit, search: state.search })
    });
    await refresh();
    window.alert(
      `智能初审完成：扫描 ${data.scanned || 0} 条，通过 ${data.approved || 0} 条，重复 ${data.duplicate || 0} 条，驳回 ${data.rejected || 0} 条，清洗 ${data.cleaned || 0} 条，失败 ${data.failed || 0} 条`
    );
  } catch (error) {
    window.alert(error.message);
  } finally {
    autoReview.disabled = false;
    autoReview.textContent = originalText;
  }
}

async function refresh() {
  await Promise.all([loadStats(), loadPrompts()]);
}

async function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tabs button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  document.querySelectorAll(".tab-page").forEach((page) => {
    page.classList.toggle("active", page.id === `tab-${tab}`);
  });
  if (tab === "review") {
    await refresh();
  } else if (tab === "scrape") {
    await Promise.all([loadStats(), loadScrapeStatus(), loadSchedules(), loadScrapeHistory()]);
  } else if (tab === "creators") {
    await Promise.all([loadStats(), loadCreators()]);
  } else if (tab === "approved") {
    await Promise.all([loadStats(), loadApprovedPrompts()]);
  }
}

document.querySelectorAll(".tabs button").forEach((button) => {
  button.addEventListener("click", () => {
    switchTab(button.dataset.tab).catch((error) => {
      if (button.dataset.tab === "creators") showCreatorError(error);
      else if (button.dataset.tab === "approved") showApprovedError(error);
      else list.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    });
  });
});

document.querySelectorAll(".segmented button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".segmented button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.status = button.dataset.status;
    state.offset = 0;
    refresh().catch((error) => {
      list.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    });
  });
});

let searchTimer;
search.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    state.search = search.value.trim();
    state.offset = 0;
    refresh().catch((error) => {
      list.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    });
  }, 250);
});

document.querySelector("#refresh").addEventListener("click", () => refresh());
autoReview.addEventListener("click", () => runAutoReview());
scrapeStart.addEventListener("click", () => scrapeAction("start"));
scrapePause.addEventListener("click", () => scrapeAction("pause"));
scrapeResume.addEventListener("click", () => scrapeAction("resume"));
scrapeStop.addEventListener("click", () => scrapeAction("stop"));
scheduleForm.addEventListener("submit", (event) => addSchedule(event).catch((error) => window.alert(error.message)));
document.querySelector("#scrapeHistoryRefresh").addEventListener("click", () =>
  Promise.all([loadScrapeStatus(), loadSchedules(), loadScrapeHistory()]).catch((error) => window.alert(error.message))
);
document.querySelector("#lightboxClose").addEventListener("click", closeLightbox);
lightbox.addEventListener("click", (event) => {
  if (event.target === lightbox) closeLightbox();
});
lightboxPrev.addEventListener("click", () => moveLightbox(-1));
lightboxNext.addEventListener("click", () => moveLightbox(1));
window.addEventListener("keydown", (event) => {
  if (lightbox.hidden) return;
  if (event.key === "Escape") closeLightbox();
  if (event.key === "ArrowLeft") moveLightbox(-1);
  if (event.key === "ArrowRight") moveLightbox(1);
});
prev.addEventListener("click", () => {
  state.offset = Math.max(0, state.offset - state.limit);
  loadPrompts();
});
next.addEventListener("click", () => {
  state.offset += state.limit;
  loadPrompts();
});
pageSize.addEventListener("change", () => {
  state.limit = Number(pageSize.value);
  state.offset = 0;
  loadPrompts();
});
pageSelect.addEventListener("change", () => {
  state.offset = (Number(pageSelect.value) - 1) * state.limit;
  loadPrompts();
});

let creatorSearchTimer;
creatorSearch.addEventListener("input", () => {
  window.clearTimeout(creatorSearchTimer);
  creatorSearchTimer = window.setTimeout(() => {
    state.creators.search = creatorSearch.value.trim();
    state.creators.offset = 0;
    loadCreators().catch(showCreatorError);
  }, 250);
});
document.querySelector("#creatorRefresh").addEventListener("click", () => loadCreators().catch(showCreatorError));
creatorPrev.addEventListener("click", () => {
  state.creators.offset = Math.max(0, state.creators.offset - state.creators.limit);
  loadCreators().catch(showCreatorError);
});
creatorNext.addEventListener("click", () => {
  state.creators.offset += state.creators.limit;
  loadCreators().catch(showCreatorError);
});
creatorPageSize.addEventListener("change", () => {
  state.creators.limit = Number(creatorPageSize.value);
  state.creators.offset = 0;
  loadCreators().catch(showCreatorError);
});
creatorPageSelect.addEventListener("change", () => {
  state.creators.offset = (Number(creatorPageSelect.value) - 1) * state.creators.limit;
  loadCreators().catch(showCreatorError);
});

let approvedSearchTimer;
approvedSearch.addEventListener("input", () => {
  window.clearTimeout(approvedSearchTimer);
  approvedSearchTimer = window.setTimeout(() => {
    state.approved.search = approvedSearch.value.trim();
    state.approved.offset = 0;
    state.approved.selected.clear();
    loadApprovedPrompts().catch(showApprovedError);
  }, 250);
});
document.querySelector("#approvedRefresh").addEventListener("click", () => loadApprovedPrompts().catch(showApprovedError));
approvedPrev.addEventListener("click", () => {
  state.approved.offset = Math.max(0, state.approved.offset - state.approved.limit);
  loadApprovedPrompts().catch(showApprovedError);
});
approvedNext.addEventListener("click", () => {
  state.approved.offset += state.approved.limit;
  loadApprovedPrompts().catch(showApprovedError);
});
approvedPageSize.addEventListener("change", () => {
  state.approved.limit = Number(approvedPageSize.value);
  state.approved.offset = 0;
  loadApprovedPrompts().catch(showApprovedError);
});
approvedPageSelect.addEventListener("change", () => {
  state.approved.offset = (Number(approvedPageSelect.value) - 1) * state.approved.limit;
  loadApprovedPrompts().catch(showApprovedError);
});
bulkCategory.addEventListener("change", renderApprovedSelectedInfo);
bulkApplyCategory.addEventListener("click", () => applyBulkCategory().catch((error) => window.alert(error.message)));
addCategory.addEventListener("click", () => addPromptCategory().catch((error) => window.alert(error.message)));
newCategoryName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") addPromptCategory().catch((error) => window.alert(error.message));
});
editCategorySelect.addEventListener("change", () => {
  const option = selectedCategoryOption();
  editCategoryName.value = option?.value || "";
});
renameCategory.addEventListener("click", () => renamePromptCategory().catch((error) => window.alert(error.message)));
editCategoryName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") renamePromptCategory().catch((error) => window.alert(error.message));
});
logout.addEventListener("click", async () => {
  await requestJson("/api/auth/logout", { method: "POST" }).catch(() => {});
  window.location.href = "/login.html";
});

loadCurrentUser()
  .then(() =>
    Promise.all([
      loadCategories().catch(() => renderApprovedCategoryControls()),
      refresh().catch((error) => {
        list.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
      }),
      loadScrapeStatus().catch((error) => {
        scrapeProgressLabel.textContent = `采集状态读取失败：${error.message}`;
      }),
      loadSchedules().catch(() => {}),
      loadScrapeHistory().catch(() => {})
    ])
  )
  .catch(() => {});
