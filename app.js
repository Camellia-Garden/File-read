"use strict";

const $ = (id) => document.getElementById(id);
const library = $("library");
const reader = $("reader");
const scrollArea = $("reader-scroll");
const settingsDialog = $("settings");
const chaptersDialog = $("chapters");
const removeDialog = $("remove-dialog");

const demo = {
  id: "demo",
  title: "雨后的书店",
  size: 0,
  text: "第一章 还书日\n"
    + "雨刚停，巷子里的石板还泛着光。小满把伞收在门口，指尖碰到门上那串铜铃。叮的一声，店里睡着的猫抬了抬耳朵。\n"
    + "她每个月的最后一个星期六都来还书。店主人很少问她借了什么，只会从柜台后面伸出一只手，把还回来的书放到一边，说一句「慢慢挑」。\n"
    + "今天店里摆了一个新的书架。最下面一层还没贴标签，横着放了几本旧书。小满蹲下去，挑了一本封皮没有字的，翻到第一页。纸上没有正文，只有一片扁平的桂花，和一行铅笔字。\n"
    + "「雨天读到这里的人，可以往后一页。」\n"
    + "她看了一眼窗外。屋檐正在滴水，天边已经亮起来了。她不知道现在还算不算雨天，便先把书捧到了靠窗的椅子上。\n\n"
    + "第二章 夹在书里的便条\n"
    + "下一页贴着一张便条，画了书店窗外的巷子。巷尾有盏路灯，灯底下站着一只猫，尾巴弯成问号。画旁边的箭头指向窗台。\n"
    + "小满抬头。窗台上有一盆长得不太精神的薄荷，花盆底下压着一只信封。她把薄荷往旁边移了移，信封正面写着「给下一位借书的人」。\n"
    + "信里夹的是两张半年前的车票。写信的人说，那天他们在这里躲雨，因为一本书聊到忘了时间，最后一起跑着去赶车。他把车票留下来，想问以后翻到这封信的人，今天有没有遇到什么好事。\n"
    + "小满从包里找出一支笔。她想了一会儿，在信纸底下写道：「我本来打算还完书就走。现在想再坐一会儿。」\n\n"
    + "第三章 再坐一会儿\n"
    + "窗外起了点风，薄荷叶在玻璃上轻轻扫过。小满把信封压回花盆底下，转头才发现那只猫已经睡到了她的伞上。\n"
    + "柜台后，店主人问她要不要喝一杯热茶。\n"
    + "「好呀。」她把书翻开，捋平了方才折起的一角。"
};

const defaults = { theme: "light", font: "serif", size: 20, spacing: 2.0 };
const settingsKey = "kotonoha:settings";
const validThemes = ["light", "paper", "dark"];
const validFonts = ["serif", "sans"];
const bookCache = new Map([[demo.id, demo]]);
const positions = new Map();

let settings = loadSettings();
let session = null;
let database = null;
let storageAvailable = true;
let importing = false;
let pendingRemoval = null;
let scrollTimer;
let toastTimer;

function readLocal(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeLocal(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Keep in-memory settings and positions if this browser blocks storage.
  }
}

function loadSettings() {
  const saved = readLocal(settingsKey);
  if (!saved) return { ...defaults };
  return {
    theme: validThemes.includes(saved.theme) ? saved.theme : defaults.theme,
    font: validFonts.includes(saved.font) ? saved.font : defaults.font,
    size: Number.isFinite(saved.size) ? Math.min(36, Math.max(15, saved.size)) : defaults.size,
    spacing: Number.isFinite(saved.spacing) ? Math.min(2.6, Math.max(1.4, saved.spacing)) : defaults.spacing
  };
}

function positionKey(id) {
  return "kotonoha:position:" + id;
}

function getPosition(id) {
  return positions.get(id) ?? readLocal(positionKey(id)) ?? {};
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("kotonoha-library", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("books", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("书架正在另一个页面中更新"));
  });
}

function bookStore(mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("books", mode);
    const request = operation(transaction.objectStore("books"));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error ?? request.error);
  });
}

function notify(message) {
  clearTimeout(toastTimer);
  $("status").textContent = message;
  toastTimer = setTimeout(() => { $("status").textContent = ""; }, 4200);
}

function decode(bytes, encoding = "auto") {
  const read = (label, fatal = false) => new TextDecoder(label, { fatal }).decode(bytes);
  if (encoding !== "auto") return read(encoding);
  const data = new Uint8Array(bytes);
  if (data[0] === 0xff && data[1] === 0xfe) return read("utf-16le");
  if (data[0] === 0xfe && data[1] === 0xff) return read("utf-16be");

  let evenNulls = 0;
  let oddNulls = 0;
  const pairs = Math.floor(Math.min(data.length, 4096) / 2);
  for (let index = 0; index < pairs * 2; index += 2) {
    if (data[index] === 0) evenNulls++;
    if (data[index + 1] === 0) oddNulls++;
  }
  if (oddNulls > pairs * .25 && evenNulls < pairs * .05) return read("utf-16le");
  if (evenNulls > pairs * .25 && oddNulls < pairs * .05) return read("utf-16be");

  try {
    return read("utf-8", true);
  } catch {
    return read("gb18030");
  }
}

const heading = /^(?:第\s*[零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟\d０-９]+\s*[章节卷回幕部篇话話集]|(?:序[章言]?|楔子|前言|引子|正文|终章|尾声|后记|番外)(?=$|[\s：:·（(、\d０-９])|(?:chapter|part|prologue|epilogue)\b(?:\s+[\divxlcdm]+\b)?)/iu;
const maxSectionLength = 14000;

function splitSections(text) {
  const sections = [];
  let title = "";
  let paragraphs = [];

  function appendSection() {
    let remaining = paragraphs.join("\n").trim();
    if (!remaining && !title) return;
    const chunks = [];
    while (remaining.length > maxSectionLength) {
      let breakAt = remaining.lastIndexOf("\n", maxSectionLength);
      if (breakAt < maxSectionLength / 2) {
        breakAt = maxSectionLength;
        const code = remaining.charCodeAt(breakAt);
        if (code >= 0xdc00 && code <= 0xdfff) breakAt--;
      }
      chunks.push(remaining.slice(0, breakAt).trimEnd());
      remaining = remaining.slice(breakAt).trimStart();
    }
    chunks.push(remaining);

    for (const [index, chunk] of chunks.entries()) {
      const name = title
        ? title + (index ? "（续 " + (index + 1) + "）" : "")
        : "第 " + (sections.length + 1) + " 节";
      sections.push({ title: name, text: chunk });
    }
  }

  for (const line of text.split(/\r\n?|\n|\u2028|\u2029/)) {
    const candidate = line.trim();
    if (candidate.length <= 80 && heading.test(candidate)) {
      appendSection();
      title = candidate;
      paragraphs = [];
    } else {
      paragraphs.push(line);
    }
  }
  appendSection();
  if (sections.length === 1 && sections[0].title === "第 1 节") sections[0].title = "正文";
  return sections;
}

function parseBook(book, encoding) {
  const text = (book.text ?? decode(book.bytes, encoding)).replace(/^\uFEFF/, "");
  if (!text.trim()) throw new Error("没有可阅读的文本");
  const sections = splitSections(text);
  if (!sections.length) throw new Error("没有可阅读的文本");

  let totalLength = 0;
  for (const section of sections) {
    section.start = totalLength;
    section.length = Math.max(1, section.text.length);
    totalLength += section.length;
  }
  return { sections, totalLength };
}

async function identify(file, bytes) {
  if (!crypto.subtle) return JSON.stringify([file.name, file.size, file.lastModified]);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return file.name + ":" + Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sizeLabel(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function makeElement(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) element.textContent = value;
  return element;
}

function makeBookCard(book, index) {
  const saved = getPosition(book.id);
  const isDemo = book.id === demo.id;
  const card = makeElement("article", "book-card");
  const open = makeElement("button", "book-open");
  open.type = "button";
  open.dataset.bookId = book.id;
  open.addEventListener("click", () => {
    try {
      startReading(book);
    } catch {
      notify("无法读取《" + book.title + "》");
    }
  });

  const cover = makeElement("span", isDemo ? "cover demo" : "cover tone-" + index % 4);
  cover.setAttribute("aria-hidden", "true");
  cover.append(isDemo ? makeElement("span", "", "雨后") : makeElement("i", "icon icon-book"));
  const info = makeElement("span", "book-info");
  const title = makeElement("strong", "", book.title);
  title.title = book.title;
  const details = isDemo ? "内置示例 · 3 章" : "TXT · " + sizeLabel(book.size);
  const progress = saved.percent > 0 ? " · " + Math.round(saved.percent) + "%" : "";
  const action = makeElement("span", "book-action", saved.openedAt ? "继续阅读  →" : "开始阅读  →");
  info.append(title, makeElement("span", "book-meta", details + progress), action);
  open.append(cover, info);
  card.append(open);

  if (!isDemo) {
    const remove = makeElement("button", "remove-button", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", "移出《" + book.title + "》");
    remove.title = "移出书架";
    remove.addEventListener("click", () => {
      pendingRemoval = book;
      $("remove-description").textContent = "将《" + book.title + "》及其阅读进度从本地书架移除？";
      removeDialog.returnValue = "cancel";
      removeDialog.showModal();
    });
    card.append(remove);
  }

  return card;
}

function renderShelf() {
  const books = [...bookCache.values()].sort((a, b) => {
    if (a.id === demo.id) return 1;
    if (b.id === demo.id) return -1;
    return (getPosition(b.id).openedAt ?? b.addedAt) - (getPosition(a.id).openedAt ?? a.addedAt);
  });
  $("book-count").textContent = books.length + " 本";
  $("book-list").replaceChildren(...books.map(makeBookCard));
}

function applySettings() {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.style.setProperty("--reader-font", "var(--" + settings.font + ")");
  root.style.setProperty("--reader-size", settings.size + "px");
  root.style.setProperty("--reader-spacing", settings.spacing);
  const dark = settings.theme === "dark";
  $("theme-toggle").querySelector(".theme-symbol").textContent = dark ? "☼" : "☾";
  $("theme-label").textContent = dark ? "日间模式" : "夜间模式";

  settingsDialog.querySelector('input[name="theme"][value="' + settings.theme + '"]').checked = true;
  settingsDialog.querySelector('input[name="font"][value="' + settings.font + '"]').checked = true;
  $("font-size").value = settings.size;
  $("line-height").value = settings.spacing;
  $("size-value").value = settings.size + " px";
  $("spacing-value").value = settings.spacing.toFixed(1);
}

function updateSettings(updates) {
  const ratio = session ? scrollRatio() : 0;
  Object.assign(settings, updates);
  applySettings();
  writeLocal(settingsKey, settings);
  if (session) {
    scrollToRatio(ratio);
    savePosition();
  }
}

function scrollRatio() {
  const distance = scrollArea.scrollHeight - scrollArea.clientHeight;
  return distance > 1 ? Math.max(0, Math.min(1, scrollArea.scrollTop / distance)) : 0;
}

function scrollToRatio(ratio) {
  scrollArea.scrollTop = (scrollArea.scrollHeight - scrollArea.clientHeight) * ratio;
}

function savePosition() {
  if (!session) return;
  const { book, index, sections, encoding, openedAt, totalLength } = session;
  const section = sections[index];
  const ratio = scrollRatio();
  const visibleRatio = scrollArea.scrollHeight - scrollArea.clientHeight > 1 ? ratio : 1;
  const percent = (section.start + section.length * visibleRatio) / totalLength * 100;
  $("progress-bar").value = percent;
  $("progress-label").textContent = Math.round(percent) + "%";
  const position = { index, ratio, percent, encoding, openedAt };
  positions.set(book.id, position);
  writeLocal(positionKey(book.id), position);
}

function renderSection(index, ratio = 0) {
  const { sections } = session;
  const section = sections[index];
  session.index = index;

  $("chapter-index").textContent = (index + 1) + " / " + sections.length;
  $("chapter-title").textContent = section.title;
  $("prev").disabled = index === 0;
  $("next").disabled = index === sections.length - 1;
  const body = document.createDocumentFragment();
  let blank = false;

  for (const line of section.text.split("\n")) {
    if (!line.trim()) {
      if (!blank) body.append(makeElement("p", "blank", "\u00A0"));
      blank = true;
      continue;
    }
    const indent = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}「『“（]/u.test(line);
    body.append(makeElement("p", indent ? "indent" : "", line));
    blank = false;
  }

  $("reader-text").replaceChildren(body);
  scrollToRatio(ratio);
  savePosition();
}

function startReading(book) {
  const saved = getPosition(book.id);
  const encoding = saved.encoding ?? "auto";
  const parsed = parseBook(book, encoding);
  const index = Number.isInteger(saved.index) ? Math.max(0, Math.min(saved.index, parsed.sections.length - 1)) : 0;
  const ratio = Number.isFinite(saved.ratio) ? Math.min(1, Math.max(0, saved.ratio)) : 0;
  session = { ...parsed, book, index, encoding, openedAt: Date.now() };
  $("reader-book").textContent = book.title;
  $("reader-book").title = book.title;
  library.hidden = true;
  reader.hidden = false;
  renderSection(index, ratio);
  $("chapter-title").focus({ preventScroll: true });
}

function showLibrary() {
  const id = session?.book.id;
  savePosition();
  clearTimeout(scrollTimer);
  scrollTimer = null;
  session = null;
  reader.hidden = true;
  library.hidden = false;
  renderShelf();
  const bookButton = Array.from($("book-list").querySelectorAll(".book-open"))
    .find((button) => button.dataset.bookId === id);
  (bookButton ?? $("library-heading")).focus({ preventScroll: true });
}

function navigateSection(direction) {
  if (!session) return;
  const index = session.index + direction;
  if (index < 0 || index >= session.sections.length) return;
  renderSection(index);
  $("chapter-title").focus({ preventScroll: true });
}

function showChapters() {
  if (!session) return;
  const links = session.sections.map((section, index) => {
    const button = makeElement("button", "chapter-link", section.title);
    button.type = "button";
    if (index === session.index) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => {
      chaptersDialog.close();
      if (index !== session.index) renderSection(index);
      $("chapter-title").focus({ preventScroll: true });
    });
    return button;
  });

  $("chapter-list").replaceChildren(...links);
  chaptersDialog.showModal();
  links[session.index].focus();
}

function showSettings() {
  const bookHasEncoding = Boolean(session?.book.bytes);
  $("encoding-row").hidden = !bookHasEncoding;
  $("encoding-error").hidden = true;
  if (bookHasEncoding) $("encoding").value = session.encoding;
  settingsDialog.showModal();
}

function changeEncoding(encoding) {
  if (!session?.book.bytes) return;
  $("encoding-error").hidden = true;
  try {
    const updated = parseBook(session.book, encoding);
    const index = Math.min(session.index, updated.sections.length - 1);
    const ratio = scrollRatio();
    session = { ...session, ...updated, encoding };
    renderSection(index, ratio);
  } catch {
    $("encoding").value = session.encoding;
    $("encoding-error").hidden = false;
  }
}

async function importFiles(files) {
  if (importing || !files.length) return;
  importing = true;
  const added = [];
  const messages = [];
  let duplicate = null;
  let storageFailed = false;

  try {
    for (const file of files) {
      if (!/\.txt$/i.test(file.name) && file.type !== "text/plain") {
        messages.push("请选择 TXT 文件");
        continue;
      }
      try {
        const bytes = await file.arrayBuffer();
        const id = await identify(file, bytes);
        if (bookCache.has(id)) {
          duplicate = bookCache.get(id);
          continue;
        }
        const book = {
          id,
          title: file.name.replace(/\.txt$/i, "").trim() || "未命名文档",
          size: file.size,
          addedAt: Date.now(),
          bytes
        };
        if (!decode(bytes).trim()) {
          messages.push("《" + book.title + "》是空文件");
          continue;
        }
        if (storageAvailable) {
          try {
            await bookStore("readwrite", (store) => store.put(book));
          } catch {
            storageFailed = true;
          }
        }
        bookCache.set(id, book);
        added.push(book);
      } catch {
        messages.push("无法导入 " + file.name);
      }
    }

    renderShelf();
    const selected = files.length === 1 ? (added[0] ?? duplicate) : null;
    if (selected) {
      try {
        startReading(selected);
      } catch {
        messages.push("无法识别《" + selected.title + "》的正文");
      }
    }
    if (added.length && (!storageAvailable || storageFailed)) {
      messages.push("浏览器无法保存部分文件，关闭网页后需重新导入");
    }
    if (added.length > 1) messages.unshift("已导入 " + added.length + " 本书");
    if (messages.length) notify([...new Set(messages)].join("；"));
  } finally {
    importing = false;
    $("file-picker").value = "";
  }
}

async function removeBook(book) {
  try {
    if (storageAvailable) await bookStore("readwrite", (store) => store.delete(book.id));
    bookCache.delete(book.id);
    positions.delete(book.id);
    writeLocal(positionKey(book.id), null);
    renderShelf();
    $("collection-title").scrollIntoView({ block: "nearest" });
    document.querySelector(".add-book").focus({ preventScroll: true });
    notify("已移出《" + book.title + "》");
  } catch {
    notify("暂时无法移出，请重试");
  }
}

function bindEvents() {
  document.querySelectorAll("[data-import]").forEach((button) => {
    button.addEventListener("click", () => $("file-picker").click());
  });
  document.querySelectorAll("[data-settings]").forEach((button) => {
    button.addEventListener("click", showSettings);
  });
  document.querySelector(".brand").addEventListener("click", (event) => {
    event.preventDefault();
    window.scrollTo(0, 0);
    $("library-heading").focus({ preventScroll: true });
  });
  $("home").addEventListener("click", () => window.scrollTo(0, 0));
  $("file-picker").addEventListener("change", (event) => importFiles(Array.from(event.target.files)));
  $("theme-toggle").addEventListener("click", () => updateSettings({ theme: settings.theme === "dark" ? "light" : "dark" }));
  $("back").addEventListener("click", showLibrary);
  $("open-chapters").addEventListener("click", showChapters);
  $("prev").addEventListener("click", () => navigateSection(-1));
  $("next").addEventListener("click", () => navigateSection(1));

  scrollArea.addEventListener("scroll", () => {
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      savePosition();
    }, 120);
  }, { passive: true });
  window.addEventListener("pagehide", savePosition);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) savePosition();
  });
  document.addEventListener("keydown", (event) => {
    if (!session || document.querySelector("dialog[open]") || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (window.getSelection()?.toString()) return;
      event.preventDefault();
      navigateSection(event.key === "ArrowLeft" ? -1 : 1);
    }
    if (event.key === "Escape") showLibrary();
  });

  settingsDialog.addEventListener("input", (event) => {
    const { name, value, id } = event.target;
    if (name === "theme" || name === "font") updateSettings({ [name]: value });
    if (id === "font-size") updateSettings({ size: Number(value) });
    if (id === "line-height") updateSettings({ spacing: Number(value) });
  });
  $("encoding").addEventListener("change", (event) => changeEncoding(event.target.value));
  removeDialog.addEventListener("close", () => {
    if (removeDialog.returnValue === "remove" && pendingRemoval) void removeBook(pendingRemoval);
    pendingRemoval = null;
  });

  window.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = session ? "none" : "copy";
    if (!session) library.classList.add("dragging");
  });
  window.addEventListener("dragleave", (event) => {
    if (!event.relatedTarget) library.classList.remove("dragging");
  });
  window.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    library.classList.remove("dragging");
    if (!session) void importFiles(Array.from(event.dataTransfer.files));
  });
}

async function initialize() {
  applySettings();
  try {
    database = await openDatabase();
    for (const book of await bookStore("readonly", (store) => store.getAll())) {
      bookCache.set(book.id, book);
    }
  } catch {
    storageAvailable = false;
  }
  renderShelf();
  bindEvents();
}

void initialize();
